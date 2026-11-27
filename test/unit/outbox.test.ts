/**
 * The outbox is the only copy of a message once the broker has forgotten it, so
 * its properties are asserted against a real file: idempotence on a repeated id,
 * a save that never leaves half a file, and a prune that keeps what is still
 * owed an answer.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Inbound } from "../../src/intercom/adapter.ts";
import { Outbox } from "../../src/intercom/outbox.ts";
import { intercomStateDir, outboxPath } from "../../src/intercom/paths.ts";

const root = mkdtempSync(join(os.tmpdir(), "claude-intercom-outbox-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

function inbound(id: string, text: string, extra: Partial<Inbound["message"]> = {}): Inbound {
  return {
    from: { id: "pi-1", name: "pi-worker", cwd: "/work", model: "pi", pid: 1, startedAt: 0, lastActivity: 0 },
    message: { id, timestamp: 0, content: { text }, ...extra },
  };
}

test("state lives under the session id, so an uninstall is one directory", () => {
  assert.equal(intercomStateDir("claude-abc12345", "/root"), "/root/intercom/claude-abc12345");
  assert.equal(outboxPath("claude-abc12345", "/root"), "/root/intercom/claude-abc12345/outbox.json");
});

test("a repeated message id is not a second message", () => {
  const file = join(root, "dedupe", "outbox.json");
  const outbox = Outbox.load(file);
  const first = outbox.record(inbound("m1", "hello"), new Date("2026-01-01T00:00:00Z"));
  const second = outbox.record(inbound("m1", "hello again"), new Date("2026-01-01T00:00:01Z"));
  assert.equal(first.messageId, second.messageId);
  assert.equal(outbox.all().length, 1);
  assert.equal(outbox.all()[0]!.text, "hello", "the first text wins: the id is the identity");
  assert.equal(outbox.all()[0]!.receivedAt, "2026-01-01T00:00:00.000Z");
});

test("saving and loading survives a process boundary and keeps order", () => {
  const file = join(root, "roundtrip", "outbox.json");
  const outbox = Outbox.load(file);
  outbox.record(inbound("m1", "first"));
  outbox.record(inbound("m2", "second", { expectsReply: true }));
  outbox.save();

  const reloaded = Outbox.load(file);
  assert.deepEqual(reloaded.all().map((entry) => entry.messageId), ["m1", "m2"]);
  assert.equal(reloaded.all()[1]!.expectsReply, true);
  assert.equal(reloaded.all()[0]!.from.name, "pi-worker");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).length, 2);
});

test("delivered and read are separate states, and neither repeats", () => {
  const outbox = Outbox.load(join(root, "states", "outbox.json"));
  outbox.record(inbound("m1", "hello"));
  assert.equal(outbox.undelivered().length, 1);
  assert.equal(outbox.markDelivered("m1"), true);
  assert.equal(outbox.markDelivered("m1"), false, "a second push is not a second delivery");
  assert.equal(outbox.undelivered().length, 0);
  assert.equal(outbox.unread().length, 1, "pushed is not read");
  assert.equal(outbox.markRead("m1"), true);
  assert.equal(outbox.markRead("m1"), false);
  assert.equal(outbox.unread().length, 0);
});

test("a corrupt outbox is an empty one, not a crash at startup", () => {
  const file = join(root, "corrupt", "outbox.json");
  mkdirSync(join(root, "corrupt"), { recursive: true });
  writeFileSync(file, "{not json");
  assert.deepEqual(Outbox.load(file).all(), []);
});

test("pruning drops what was read and keeps what is still owed", () => {
  const outbox = Outbox.load(join(root, "prune", "outbox.json"));
  outbox.record(inbound("read-long-ago", "old"));
  outbox.markRead("read-long-ago", new Date("2026-01-01T00:00:00Z"));
  outbox.record(inbound("never-read", "still owed"));
  outbox.prune(Date.parse("2026-01-03T00:00:00Z"), 24 * 60 * 60 * 1_000);
  assert.deepEqual(outbox.all().map((entry) => entry.messageId), ["never-read"]);
});
