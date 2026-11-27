/**
 * A real broker, started by the channel itself in a scratch agent directory, so
 * the live bus on this machine is never touched.
 *
 * Two things are proven here that a fake bus cannot prove: that a peer sees this
 * session's id and label on the roster, and that mail sent while the channel is
 * away is handed back to the same id when it returns.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

const scratch = mkdtempSync(join(os.tmpdir(), "claude-intercom-broker-"));
const agentDir = join(scratch, "agent");
const project = join(scratch, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(project, { recursive: true });
process.env["PI_CODING_AGENT_DIR"] = agentDir;

// Imported after the agent directory is set: the adapter resolves the broker
// socket from the environment at import time.
const { createChannelBus } = await import("../../src/intercom/adapter.ts");
const { startSession } = await import("../../src/intercom/session.ts");
const { labelFor, pinnedSessionId, registrationFor } = await import("../../src/intercom/identity.ts");

test.after(() => rmSync(scratch, { recursive: true, force: true }));

async function until<T>(what: string, check: () => Promise<T | undefined> | T | undefined, timeoutMs = 20_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("a peer sees this session's id and label, and a rename reaches the roster", async () => {
  const bus = createChannelBus();
  // The session spawns the broker, so it goes first: the bus does not exist
  // until something asks for it.
  const session = await startSession(bus, { cwd: project });
  const peer = createChannelBus();
  await peer.connect(registrationFor(project, { model: "probe-peer" }), "probe-peer");
  try {
    assert.equal(session.state().status, "registered");
    const id = pinnedSessionId(project);
    assert.equal(session.sessionId(), id);

    const seen = await until("the session on the roster", async () => {
      const sessions = await peer.list();
      return sessions.find((entry) => entry.id === id);
    });
    assert.equal(seen.name, labelFor(project));
    assert.equal(seen.cwd, project);

    session.setLabel("claude@renamed");
    await until("the renamed label", async () => {
      const sessions = await peer.list();
      return sessions.find((entry) => entry.id === id && entry.name === "claude@renamed");
    });
  } finally {
    await session.stop();
    await peer.disconnect();
  }
});

test("mail queued while the channel was away returns to the same id", async () => {
  const id = pinnedSessionId(project);
  const away = await startSession(createChannelBus(), { cwd: project });
  await away.stop();

  const peer = createChannelBus();
  await peer.connect(registrationFor(project, { model: "probe-peer" }), "probe-peer");
  try {
    const queued = await peer.send(id, { text: "sent while the channel was closed" });
    assert.deepEqual(queued, { kind: "queued", id: queued.kind === "queued" ? queued.id : "" });

    const received: string[] = [];
    const returning = createChannelBus();
    returning.onMessage(({ message }) => received.push(message.content.text));
    const back = await startSession(returning, { cwd: project });
    try {
      await until("the queued message", () => (received.length > 0 ? received[0] : undefined));
      assert.deepEqual(received, ["sent while the channel was closed"]);
      assert.equal(back.sessionId(), id);
    } finally {
      await back.stop();
    }
  } finally {
    await peer.disconnect();
  }
});
