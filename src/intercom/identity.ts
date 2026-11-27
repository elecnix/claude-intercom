/**
 * Identity: who a Claude Code session is on the bus, and what it is called.
 *
 * The two are separate on purpose. The id is the mailbox and survives a
 * restart; the label is what a person reads and follows a rename. A rename must
 * never move mail, and a restart must never leave mail that nobody can claim.
 *
 * The id is derived from the repository directory rather than chosen at random,
 * because the broker reclaims a queue only for the same session id or for a
 * uniquely named session in the same directory. A random id per process would
 * make every restart a new stranger, and the queue would expire unread.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { SessionRegistration } from "./adapter.ts";

const ID_PREFIX = "claude";
const DEFAULT_MODEL = "claude-code";

/** `realpath` so a symlinked or trailing-slash path names the same mailbox. */
function canonical(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

/** Stable per repository, distinct between repositories, independent of the label. */
export function pinnedSessionId(cwd: string): string {
  const digest = createHash("sha256").update(canonical(cwd)).digest("hex").slice(0, 8);
  return `${ID_PREFIX}-${digest}`;
}

/** The readable label a person sees in `intercom list`. Never used to route. */
export function labelFor(cwd: string): string {
  const name = basename(canonical(cwd)) || "workspace";
  return `claude@${name.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
}

/**
 * The nth attempt at claiming an id. The broker refuses an id held by another
 * live process, which is what keeps two sessions in one repository from
 * sharing a mailbox; the second one takes a suffix and a mailbox of its own.
 */
export function claimId(base: string, attempt: number): string {
  return attempt <= 0 ? base : `${base}-${attempt + 1}`;
}

export function registrationFor(
  cwd: string,
  options: { model?: string; now?: number; pid?: number } = {},
): SessionRegistration {
  const now = options.now ?? Date.now();
  return {
    cwd: canonical(cwd),
    model: options.model ?? DEFAULT_MODEL,
    pid: options.pid ?? process.pid,
    startedAt: now,
    lastActivity: now,
    status: "idle",
  };
}
