/**
 * The one module allowed to import pi-intercom.
 *
 * Everything else in this repository talks to the `ChannelBus` interface, so
 * the upstream dependency lives behind a single seam. The reason is not taste:
 * this adapter imports a TypeScript *source* module from inside another
 * package (`pi-intercom/broker/client.ts`), which only works because that
 * package ships its broker sources in `files` and declares no `exports` map. Add
 * an `exports` map upstream and this import stops resolving. The contract test
 * in `test/unit/adapter-contract.test.ts` fails loudly in that case instead of
 * leaving a runtime surprise, and the fix is confined to this file.
 *
 * Loading also needs `tsx`: Node refuses to strip types for files under
 * `node_modules` (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). pi-intercom's
 * own CLI registers tsx for the same reason.
 */
import { IntercomClient, IntercomSessionHeldError } from "pi-intercom/broker/client.ts";
import type { SendResult } from "pi-intercom/broker/client.ts";
import { createRequire } from "node:module";
import { loadConfig } from "pi-intercom/config.ts";
import type { Message, SessionInfo, SessionRegistration } from "pi-intercom/types.ts";

// Re-exported so no other file has to name the upstream package.
export type { Message, SessionInfo, SessionRegistration } from "pi-intercom/types.ts";

/** A live process in the same repository already holds this mailbox. */
export function isSessionHeldError(error: unknown): error is IntercomSessionHeldError {
  return error instanceof IntercomSessionHeldError
    || (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "E_SESSION_HELD");
}

/**
 * Start the bus if nothing is listening.
 *
 * The broker auto-spawns from a Pi session, so a machine that runs only Claude
 * Code has no broker and no way to be messaged. This makes the channel able to
 * bring the bus up on its own, using the same launch configuration the Pi
 * extension uses.
 */
export async function ensureBroker(): Promise<void> {
  const config = loadConfig();
  // Loaded through require rather than a static import: upstream type-checks
  // spawn.ts under a looser tsconfig than this repository's, and a borrowed
  // convenience should not lower the strictness of our own sources.
  const { spawnBrokerIfNeeded } = createRequire(import.meta.url)("pi-intercom/broker/spawn.ts") as {
    spawnBrokerIfNeeded: (brokerCommand: string, brokerArgs: string[]) => Promise<void>;
  };
  await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
}

/** The upstream version this adapter was written against. Bump it with the tests. */
export const PI_INTERCOM_CONTRACT = {
  package: "pi-intercom",
  version: "0.18.1",
  protocol: 1,
} as const;

export interface Inbound {
  from: SessionInfo;
  message: Message;
}

/** What a send actually did, in the three states a model can act on. */
export type SendOutcome =
  | { kind: "delivered"; id: string }
  | { kind: "queued"; id: string }
  | { kind: "refused"; reason: string; code?: string };

export interface SendRequest {
  text: string;
  replyTo?: string;
  expectsReply?: boolean;
  noWake?: boolean;
}

export interface ChannelBus {
  readonly sessionId: string | null;
  connect(registration: SessionRegistration, sessionId?: string): Promise<void>;
  disconnect(): Promise<void>;
  list(): Promise<SessionInfo[]>;
  send(to: string, request: SendRequest): Promise<SendOutcome>;
  /** Publish the readable label. Identity is never derived from it. */
  setLabel(name: string): void;
  onMessage(handler: (inbound: Inbound) => void): () => void;
  onDisconnect(handler: (error: Error) => void): () => void;
}

/** `queued` is a real state, not a success: the peer is offline and may never read it. */
export function toSendOutcome(result: SendResult): SendOutcome {
  if (!result.delivered) {
    return {
      kind: "refused",
      reason: result.reason ?? "delivery refused",
      ...(result.code === undefined ? {} : { code: result.code }),
    };
  }
  return result.delivery === "queued"
    ? { kind: "queued", id: result.id }
    : { kind: "delivered", id: result.id };
}

export function createChannelBus(): ChannelBus {
  const client = new IntercomClient();
  return {
    get sessionId(): string | null {
      return client.sessionId;
    },
    connect: (registration, sessionId) => client.connect(registration, sessionId),
    disconnect: () => client.disconnect(),
    list: () => client.listSessions(),
    send: async (to, request) => toSendOutcome(await client.send(to, {
      text: request.text,
      ...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
      ...(request.expectsReply === undefined ? {} : { expectsReply: request.expectsReply }),
      ...(request.noWake === undefined ? {} : { noWake: request.noWake }),
    })),
    setLabel: (name) => client.updatePresence({ name }),
    onMessage: (handler) => {
      const listener = (from: SessionInfo, message: Message): void => handler({ from, message });
      client.on("message", listener);
      return () => client.off("message", listener);
    },
    onDisconnect: (handler) => {
      client.on("disconnected", handler);
      return () => client.off("disconnected", handler);
    },
  };
}
