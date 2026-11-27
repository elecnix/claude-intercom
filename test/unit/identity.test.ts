/**
 * Identity is the mailbox. These are the properties the broker's reclaim rules
 * depend on, so they are asserted rather than assumed.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claimId, labelFor, pinnedSessionId, registrationFor } from "../../src/intercom/identity.ts";

const scratch = mkdtempSync(join(os.tmpdir(), "claude-intercom-identity-"));
const alpha = join(scratch, "alpha");
const beta = join(scratch, "beta");
mkdirSync(alpha, { recursive: true });
mkdirSync(beta, { recursive: true });
test.after(() => rmSync(scratch, { recursive: true, force: true }));

test("the id is stable for one directory and distinct between directories", () => {
  assert.equal(pinnedSessionId(alpha), pinnedSessionId(alpha));
  assert.notEqual(pinnedSessionId(alpha), pinnedSessionId(beta));
  assert.match(pinnedSessionId(alpha), /^claude-[0-9a-f]{8}$/);
});

test("a symlink and a trailing slash name the same mailbox", () => {
  const link = join(scratch, "alpha-link");
  symlinkSync(alpha, link);
  assert.equal(pinnedSessionId(link), pinnedSessionId(alpha));
  assert.equal(pinnedSessionId(`${alpha}/`), pinnedSessionId(alpha));
});

test("the label follows the directory name and never becomes the identity", () => {
  assert.equal(labelFor(alpha), "claude@alpha");
  assert.equal(labelFor(`${alpha}/`), "claude@alpha");
  assert.notEqual(labelFor(alpha), pinnedSessionId(alpha));
});

test("a directory name that would confuse a roster is sanitized", () => {
  const awkward = join(scratch, "my repo (v2)");
  mkdirSync(awkward, { recursive: true });
  assert.equal(labelFor(awkward), "claude@my-repo-v2-");
});

test("collision attempts walk past a held id without changing the first choice", () => {
  assert.equal(claimId("claude-abc12345", 0), "claude-abc12345");
  assert.equal(claimId("claude-abc12345", 1), "claude-abc12345-2");
  assert.equal(claimId("claude-abc12345", 2), "claude-abc12345-3");
});

test("the registration carries a canonical directory and no name", () => {
  const registration = registrationFor(alpha, { model: "claude-code", now: 1_700_000_000_000, pid: 42 });
  assert.equal(registration.cwd, alpha);
  assert.equal(registration.model, "claude-code");
  assert.equal(registration.pid, 42);
  assert.equal(registration.startedAt, 1_700_000_000_000);
  assert.equal(registration.name, undefined, "the mailbox must not be named at registration");
});
