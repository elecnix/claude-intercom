/**
 * The lifecycle, driven against a fake bus and a hand-picked clock: what is
 * asserted here is the decision to keep one identity across a disconnect, and
 * the timing of the retries that follow it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ChannelBus, SendOutcome, SessionInfo } from "../../src/intercom/adapter.ts";
import { pinnedSessionId, labelFor } from "../../src/intercom/identity.ts";
import { startSession, type SessionTimers } from "../../src/intercom/session.ts";

const cwd = "/home/someone/Source/demo";

interface FakeBus {
  bus: ChannelBus;
  connects: string[];
  labels: string[];
  drop(error?: Error): void;
  connected: () => boolean;
}

function fakeBus(held: string[] = []): FakeBus {
  const connects: string[] = [];
  const labels: string[] = [];
  let connected = false;
  let disconnectHandler: ((error: Error) => void) | null = null;
  const bus: ChannelBus = {
    get sessionId(): string | null {
      return connected ? `sid:${connects.at(-1)}` : null;
    },
    async connect(_registration, sessionId) {
      const id = sessionId ?? "(broker-assigned)";
      if (held.includes(id)) {
        throw Object.assign(new Error(`session ${id} is held`), { code: "E_SESSION_HELD" });
      }
      connects.push(id);
      connected = true;
    },
    async disconnect() {
      connected = false;
    },
    async list(): Promise<SessionInfo[]> {
      return [];
    },
    async send(): Promise<SendOutcome> {
      return { kind: "delivered", id: "sent" };
    },
    setLabel(name) {
      labels.push(name);
    },
    onMessage() {
      return () => {};
    },
    onDisconnect(handler) {
      disconnectHandler = handler;
      return () => {
        disconnectHandler = null;
      };
    },
  };
  return {
    bus,
    connects,
    labels,
    drop: (error = new Error("socket closed")) => {
      connected = false;
      disconnectHandler?.(error);
    },
    connected: () => connected,
  };
}

interface FakeClock {
  timers: SessionTimers;
  advance(ms: number): Promise<void>;
  pending(): number;
}

function fakeClock(): FakeClock {
  let now = 0;
  let nextId = 1;
  const queue: { at: number; id: number; handler: () => void }[] = [];
  const timers: SessionTimers = {
    setTimeout(handler, ms) {
      const id = nextId++;
      queue.push({ at: now + ms, id, handler });
      return id;
    },
    clearTimeout(handle) {
      const index = queue.findIndex((entry) => entry.id === handle);
      if (index >= 0) queue.splice(index, 1);
    },
  };
  return {
    timers,
    pending: () => queue.length,
    async advance(ms) {
      now += ms;
      for (;;) {
        const due = queue.filter((entry) => entry.at <= now).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        queue.splice(queue.indexOf(due), 1);
        due.handler();
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

test("a session registers under the repository id and publishes its label", async () => {
  const fake = fakeBus();
  const session = await startSession(fake.bus, { cwd, ensureBroker: async () => {} });
  try {
    assert.equal(fake.connects.length, 1);
    assert.equal(fake.connects[0], pinnedSessionId(cwd));
    assert.deepEqual(fake.labels, [labelFor(cwd)]);
    assert.deepEqual(session.state(), { status: "registered", sessionId: `sid:${pinnedSessionId(cwd)}`, label: labelFor(cwd) });
  } finally {
    await session.stop();
  }
});

test("a mailbox held by another live process is walked past, not stolen", async () => {
  const base = pinnedSessionId(cwd);
  const fake = fakeBus([base, `${base}-2`]);
  const session = await startSession(fake.bus, { cwd, ensureBroker: async () => {} });
  try {
    assert.deepEqual(fake.connects, [`${base}-3`]);
    assert.equal(fake.labels.length, 1);
  } finally {
    await session.stop();
  }
});

test("a disconnect reconnects under the same id and republishes the label", async () => {
  const fake = fakeBus();
  const clock = fakeClock();
  const session = await startSession(fake.bus, { cwd, ensureBroker: async () => {}, timers: clock.timers });
  try {
    fake.drop(new Error("broker went away"));
    assert.equal(session.state().status, "disconnected");
    assert.equal((session.state() as { retryInMs: number }).retryInMs, 1_000);
    assert.equal(clock.pending(), 1, "one retry, even if close arrives twice");

    fake.drop(new Error("duplicate close"));
    assert.equal(clock.pending(), 1, "a duplicate close must not arm a second retry");

    await clock.advance(1_000);
    assert.equal(fake.connects.length, 2);
    assert.equal(fake.connects[1], fake.connects[0], "the mailbox must survive the reconnect");
    assert.deepEqual(fake.labels, [labelFor(cwd), labelFor(cwd)], "the label is republished after a reconnect");
    assert.equal(session.state().status, "registered");
  } finally {
    await session.stop();
  }
});

test("repeated failures back off exponentially instead of hammering the bus", async () => {
  const fake = fakeBus();
  const clock = fakeClock();
  let attempts = 0;
  const session = await startSession(fake.bus, {
    cwd,
    timers: clock.timers,
    ensureBroker: async () => {
      attempts += 1;
      throw new Error("no broker");
    },
  });
  try {
    assert.equal(attempts, 1);
    assert.equal((session.state() as { retryInMs: number }).retryInMs, 1_000);
    assert.equal(fake.connects.length, 0);

    await clock.advance(1_000);
    assert.equal(attempts, 2);
    assert.equal((session.state() as { retryInMs: number }).retryInMs, 2_000);

    await clock.advance(2_000);
    assert.equal(attempts, 3);
    assert.equal((session.state() as { retryInMs: number }).retryInMs, 4_000);
  } finally {
    await session.stop();
  }
});

test("a rename publishes once, and stopping cancels a pending retry", async () => {
  const fake = fakeBus();
  const clock = fakeClock();
  const session = await startSession(fake.bus, { cwd, ensureBroker: async () => {}, timers: clock.timers });
  try {
    session.setLabel("claude@renamed");
    session.setLabel("claude@renamed");
    assert.deepEqual(fake.labels, [labelFor(cwd), "claude@renamed"]);
    assert.equal((session.state() as { label: string }).label, "claude@renamed");

    fake.drop();
    assert.equal(clock.pending(), 1);
    await session.stop();
    assert.equal(clock.pending(), 0, "a stopped session must not reconnect");
    assert.equal(session.state().status, "stopped");
  } finally {
    await session.stop();
  }
});
