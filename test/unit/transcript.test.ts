/**
 * A receipt counts only in the line where Claude Code records this channel's
 * message reaching the model. These tests write real files and append real
 * bytes, because the byte offset is part of what is being asserted.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { CHANNEL_SERVER, ReceiptScan, claudeProjectDir, deliveredLine, findTranscript } from "../../src/claude/transcript.ts";

const root = mkdtempSync(join(os.tmpdir(), "claude-intercom-scan-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

const session = "11111111-2222-3333-4444-555555555555";
const cwd = "/tmp/some worktree";

function lab(name: string): { dir: string; file: string } {
  const configDir = join(root, name);
  const file = join(configDir, "projects", claudeProjectDir(cwd), `${session}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "");
  return { dir: configDir, file };
}

/** The line Claude Code writes when a channel message reaches the model. */
function deliver(file: string, text: string, server = CHANNEL_SERVER): void {
  const prompt = `<channel source="${server}">${text}</channel>`;
  appendFileSync(file, `${JSON.stringify({
    type: "attachment",
    attachment: { type: "queued_command", prompt, commandMode: "prompt", origin: { kind: "channel", server } },
  })}\n`);
}

test("the project directory name replaces every punctuation character", () => {
  assert.equal(claudeProjectDir("/home/nicolas/Source/claude-intercom/main"), "-home-nicolas-Source-claude-intercom-main");
  assert.equal(claudeProjectDir("/tmp/some worktree"), "-tmp-some-worktree");
});

test("a transcript is found by directory, and by session id when it has moved", () => {
  const { dir, file } = lab("locate");
  assert.equal(findTranscript(session, cwd, dir), file);
  assert.equal(findTranscript(session, "/somewhere/else", dir), file, "a moved session is still found");
  assert.equal(findTranscript("other-session", cwd, dir), undefined);
});

test("only a channel delivery of this server counts", () => {
  assert.ok(deliveredLine(JSON.stringify({
    type: "attachment",
    attachment: { origin: { kind: "channel", server: CHANNEL_SERVER } },
  })));
  assert.ok(deliveredLine(JSON.stringify({
    type: "attachment",
    attachment: { origin: { kind: "channel", server: `plugin:claude-intercom:${CHANNEL_SERVER}` } },
  })), "a plugin-scoped server name is the same channel");
  assert.equal(deliveredLine(JSON.stringify({
    type: "attachment",
    attachment: { origin: { kind: "channel", server: "bellwether" } },
  })), undefined, "another channel's delivery is not this one's");
  assert.equal(deliveredLine(JSON.stringify({
    type: "queue-operation",
    attachment: { origin: { kind: "channel", server: CHANNEL_SERVER } },
  })), undefined, "a queued command is not a delivery");
  assert.equal(deliveredLine("{\"type\":\"user\",\"message\":{\"content\":\"msg-1\"}}"), undefined);
  assert.equal(deliveredLine("not json"), undefined);
});

test("a scan ignores anything written before it started", () => {
  const { dir, file } = lab("before");
  deliver(file, "older run, message m-1");
  const scan = new ReceiptScan(session, cwd, dir);
  scan.start();
  assert.deepEqual([...scan.scan(["m-1"])], []);
});

test("a scan reports only what appeared since the last look", () => {
  const { dir, file } = lab("incremental");
  const scan = new ReceiptScan(session, cwd, dir);
  scan.start();
  deliver(file, "message m-1 arrived");
  assert.deepEqual([...scan.scan(["m-1", "m-2"])], ["m-1"]);
  deliver(file, "message m-2 arrived");
  assert.deepEqual([...scan.scan(["m-1", "m-2"])], ["m-2"]);
  assert.deepEqual([...scan.scan(["m-1", "m-2"])], [], "the same bytes are not read twice");
});

test("an id quoted in a tool result does not mark a message read", () => {
  const { dir, file } = lab("quote");
  const scan = new ReceiptScan(session, cwd, dir);
  scan.start();
  appendFileSync(file, `${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "m-1 appears in this output" }] } })}\n`);
  assert.deepEqual([...scan.scan(["m-1"])], []);
  deliver(file, "message m-1 arrived");
  assert.deepEqual([...scan.scan(["m-1"])], ["m-1"]);
});

test("a half-written line waits for the next look", () => {
  const { dir, file } = lab("partial");
  const scan = new ReceiptScan(session, cwd, dir);
  scan.start();
  const line = JSON.stringify({ type: "attachment", attachment: { origin: { kind: "channel", server: CHANNEL_SERVER }, prompt: "m-1" } });
  appendFileSync(file, line.slice(0, 20));
  assert.deepEqual([...scan.scan(["m-1"])], []);
  appendFileSync(file, `${line.slice(20)}\n`);
  assert.deepEqual([...scan.scan(["m-1"])], ["m-1"]);
});

test("searching the whole file finds what an earlier server already delivered", () => {
  const { dir, file } = lab("search");
  deliver(file, "delivered before this process started, m-9");
  const scan = new ReceiptScan(session, cwd, dir);
  scan.start();
  assert.deepEqual([...scan.search(["m-9"])], ["m-9"]);
  assert.deepEqual([...scan.search(["m-8"])], []);
});
