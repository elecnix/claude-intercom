/**
 * The session lifecycle: claim the pinned id, publish the label, and come back
 * after a disconnect without inventing a new identity.
 *
 * The reconnect deliberately reuses the same id. The broker keeps a session's
 * queue in memory against that id, so a reconnect within the retention window
 * reclaims whatever arrived while the channel was away; a fresh id would strand
 * it. The label is republished rather than re-derived, so a rename made while
 * disconnected survives the gap.
 */
import { ensureBroker, isSessionHeldError, type ChannelBus } from "./adapter.ts";
import { claimId, labelFor, pinnedSessionId, registrationFor } from "./identity.ts";

export type SessionState =
  | { status: "connecting" }
  | { status: "registered"; sessionId: string; label: string }
  | { status: "disconnected"; retryInMs: number; reason: string }
  | { status: "stopped" };

export interface SessionTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemTimers: SessionTimers = {
  setTimeout: (handler, ms) => {
    const timer = setTimeout(handler, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface StartSessionOptions {
  cwd: string;
  /** Defaults to the repository label. Overridden only by an explicit rename. */
  label?: string;
  model?: string;
  /** How many id collisions to walk past before giving the bus up temporarily. */
  maxClaimAttempts?: number;
  ensureBroker?: () => Promise<void>;
  timers?: SessionTimers;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  onStateChange?: (state: SessionState) => void;
}

export interface RunningSession {
  state(): SessionState;
  /** The claimed id, or null while disconnected. */
  sessionId(): string | null;
  /** Publish a new label. A no-op when it matches what is already published. */
  setLabel(label: string): void;
  stop(): Promise<void>;
}

export async function startSession(bus: ChannelBus, options: StartSessionOptions): Promise<RunningSession> {
  const timers = options.timers ?? systemTimers;
  const ensure = options.ensureBroker ?? ensureBroker;
  const maxClaims = options.maxClaimAttempts ?? 4;
  const baseId = pinnedSessionId(options.cwd);

  let label = options.label ?? labelFor(options.cwd);
  let published: string | null = null;
  let state: SessionState = { status: "connecting" };
  let claims = 0;
  let reconnects = 0;
  let timer: unknown = null;
  let stopped = false;

  const announce = (): void => options.onStateChange?.(state);

  function publishLabel(): void {
    if (published === label) return;
    bus.setLabel(label);
    published = label;
  }

  function scheduleReconnect(reason: string): void {
    if (stopped) return;
    // One retry at a time: a duplicate close event must not arm a second timer.
    if (timer !== null) return;
    const base = options.reconnectBaseMs ?? 1_000;
    const cap = options.reconnectMaxMs ?? 30_000;
    const delay = Math.min(base * 2 ** reconnects, cap);
    reconnects += 1;
    state = { status: "disconnected", retryInMs: delay, reason };
    announce();
    timer = timers.setTimeout(() => {
      timer = null;
      void connect();
    }, delay);
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    state = { status: "connecting" };
    announce();

    try {
      await ensure();
    } catch (error) {
      scheduleReconnect(`broker unavailable: ${(error as Error).message}`);
      return;
    }

    for (let attempt = claims; attempt < maxClaims; attempt += 1) {
      const id = claimId(baseId, attempt);
      try {
        await bus.connect(registrationFor(options.cwd, { model: options.model }), id);
        claims = 0;
        reconnects = 0;
        const sessionId = bus.sessionId ?? id;
        publishLabel();
        state = { status: "registered", sessionId, label };
        announce();
        return;
      } catch (error) {
        if (stopped) return;
        if (!isSessionHeldError(error)) {
          scheduleReconnect(`registration failed: ${(error as Error).message}`);
          return;
        }
        // Another live process in the same repository holds this mailbox.
        claims = attempt + 1;
      }
    }

    scheduleReconnect(`${maxClaims} session ids in ${baseId} are held by live processes`);
  }

  const detachDisconnect = bus.onDisconnect((error) => {
    if (stopped) return;
    claims = 0;
    published = null;
    scheduleReconnect(error.message);
  });

  await connect();

  return {
    state: () => state,
    sessionId: () => (state.status === "registered" ? state.sessionId : null),
    setLabel: (next: string) => {
      const trimmed = next.trim();
      if (!trimmed) return;
      label = trimmed;
      if (state.status === "registered") {
        publishLabel();
        state = { ...state, label };
        announce();
      }
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      detachDisconnect();
      state = { status: "stopped" };
      announce();
      await bus.disconnect().catch(() => {});
    },
  };
}
