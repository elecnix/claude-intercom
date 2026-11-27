/**
 * The upstream contract: what this adapter assumes about pi-intercom, asserted
 * so a bump upstream fails here rather than inside a running session.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { PI_INTERCOM_CONTRACT, createChannelBus, toSendOutcome } from "../../src/intercom/adapter.ts";

const require = createRequire(import.meta.url);

function upstreamManifest(): Record<string, unknown> {
  let manifestPath: string;
  try {
    manifestPath = require.resolve("pi-intercom/package.json");
  } catch {
    assert.fail(
      "pi-intercom no longer resolves its own package.json, which usually means it gained an `exports` map. "
      + "The deep import in src/intercom/adapter.ts stops working when that happens: revisit the adapter before bumping the pin.",
    );
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
}

test("the installed pi-intercom is the version this adapter was written against", () => {
  assert.equal(upstreamManifest()["version"], PI_INTERCOM_CONTRACT.version);
});

test("pi-intercom still declares no exports map, which the deep import depends on", () => {
  assert.equal(
    upstreamManifest()["exports"],
    undefined,
    "pi-intercom added an `exports` map: src/intercom/adapter.ts can no longer import broker/client.ts by path.",
  );
});

test("pi-intercom still ships its broker sources", () => {
  const files = upstreamManifest()["files"];
  assert.ok(Array.isArray(files), "pi-intercom declares no files list");
  assert.ok(files.includes("broker/**/*.ts"), "pi-intercom stopped shipping broker/**/*.ts");
  assert.doesNotThrow(() => require.resolve("pi-intercom/broker/client.ts"));
});

test("the broker client exposes the surface the adapter wraps", () => {
  const { IntercomClient } = require("pi-intercom/broker/client.ts") as {
    IntercomClient: { prototype: Record<string, unknown> };
  };
  for (const method of ["connect", "disconnect", "send", "listSessions", "updatePresence", "isConnected"]) {
    assert.equal(typeof IntercomClient.prototype[method], "function", `IntercomClient.${method} is missing`);
  }

  const bus = createChannelBus();
  assert.equal(bus.sessionId, null, "a fresh bus is not connected");
  for (const method of ["connect", "disconnect", "list", "send", "setLabel", "onMessage", "onDisconnect"]) {
    assert.equal(typeof (bus as unknown as Record<string, unknown>)[method], "function", `ChannelBus.${method} is missing`);
  }
});

test("a send result maps to exactly three model-facing outcomes", () => {
  assert.deepEqual(
    toSendOutcome({ id: "a", delivered: true, delivery: "socket_delivered", retryable: false, outcomeKnown: true }),
    { kind: "delivered", id: "a" },
  );
  assert.deepEqual(
    toSendOutcome({ id: "b", delivered: true, delivery: "queued", retryable: false, outcomeKnown: true }),
    { kind: "queued", id: "b" },
  );
  assert.deepEqual(
    toSendOutcome({
      id: "c",
      delivered: false,
      delivery: "failed",
      retryable: false,
      outcomeKnown: true,
      code: "E_TARGET_DISCONNECTED",
      reason: "Target session is not currently connected; blocking asks are not queued",
    }),
    {
      kind: "refused",
      code: "E_TARGET_DISCONNECTED",
      reason: "Target session is not currently connected; blocking asks are not queued",
    },
  );
});
