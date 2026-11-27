/**
 * The receipt: proving a message reached the model.
 *
 * Claude Code writes one JSONL line per event to
 * `<CLAUDE_CONFIG_DIR>/projects/<slug>/<session>.jsonl`. A channel message that
 * reaches the model lands there as an attachment whose origin is this channel.
 * The same message id in a tool result — what a session that greps its own
 * outbox produces — is not a delivery, so it must not mark anything read.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigDir } from "../intercom/paths.ts";

export const CHANNEL_SERVER = "claude-intercom";

/** Claude Code caps a project directory name at this many characters. */
const PROJECT_DIR_MAX = 200;

/** The 32-bit string hash Claude Code appends when it cuts a directory name short. */
function nameHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return hash;
}

/** How Claude Code names the directory holding one working directory's sessions. */
export function claudeProjectDir(cwd: string): string {
  const name = cwd.replace(/[^A-Za-z0-9]/g, "-");
  if (name.length <= PROJECT_DIR_MAX) return name;
  return `${name.slice(0, PROJECT_DIR_MAX)}-${Math.abs(nameHash(cwd)).toString(36)}`;
}

export function findTranscript(sessionId: string, cwd?: string, configDir: string = claudeConfigDir()): string | undefined {
  const root = join(configDir, "projects");
  if (cwd) {
    const direct = join(root, claudeProjectDir(cwd), `${sessionId}.jsonl`);
    if (existsSync(direct)) return direct;
  }
  try {
    for (const dir of readdirSync(root)) {
      const file = join(root, dir, `${sessionId}.jsonl`);
      if (existsSync(file)) return file;
    }
  } catch {
    // A missing projects directory is not an error: the scan simply waits.
  }
  return undefined;
}

/** Read only the bytes asked for, so a long session log never sits in memory whole. */
function readRange(file: string, from: number, to: number): string {
  const pieces: string[] = [];
  const fd = openSync(file, "r");
  try {
    const chunk = 4 * 1024 * 1024;
    let at = from;
    while (at < to) {
      const length = Math.min(chunk, to - at);
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, at);
      if (read <= 0) break;
      pieces.push(buffer.toString("utf8", 0, read));
      at += read;
    }
  } finally {
    closeSync(fd);
  }
  return pieces.join("");
}

function isThisChannel(server: unknown): boolean {
  return typeof server === "string" && (server === CHANNEL_SERVER || server.endsWith(`:${CHANNEL_SERVER}`));
}

/** One transcript line, when it records this channel's message reaching the model. */
export function deliveredLine(line: string): string | undefined {
  if (!line.includes("channel")) return undefined;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  // A queued command is not a delivery; it is a line saying one was queued.
  if (record["type"] === "queue-operation") return undefined;
  const attachment = record["attachment"] as Record<string, unknown> | undefined;
  const message = record["message"] as Record<string, unknown> | undefined;
  const origin = (attachment?.["origin"] ?? record["origin"] ?? message?.["origin"]) as Record<string, unknown> | undefined;
  if (origin?.["kind"] !== "channel" || !isThisChannel(origin["server"])) return undefined;
  return line;
}

function deliveredIds(content: string, wanted: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const line of content.split("\n")) {
    if (!deliveredLine(line)) continue;
    for (const id of wanted) if (line.includes(id)) found.add(id);
  }
  return found;
}

/** The length of the part of a chunk that ends with a whole line. */
function wholeLines(content: string): number {
  return content.lastIndexOf("\n") + 1;
}

function sizeOf(file: string): number | undefined {
  try {
    return statSync(file).size;
  } catch {
    return undefined;
  }
}

/**
 * Incremental reader over one transcript. The offset starts at the current end
 * of the file, so an id written by an earlier run of the same session cannot
 * mark a new entry read.
 */
export class ReceiptScan {
  private transcript: string | undefined;
  private offset = 0;

  constructor(
    private readonly sessionId: string,
    private readonly cwd?: string,
    private readonly configDir: string = claudeConfigDir(),
  ) {}

  start(): void {
    this.transcript = findTranscript(this.sessionId, this.cwd, this.configDir);
    this.offset = this.transcript === undefined ? 0 : (sizeOf(this.transcript) ?? 0);
  }

  /** Ids already delivered before this process started, so they are not pushed twice. */
  search(ids: Iterable<string>): Set<string> {
    const wanted = [...ids];
    if (wanted.length === 0) return new Set();
    const file = this.transcript ?? findTranscript(this.sessionId, this.cwd, this.configDir);
    if (file === undefined) return new Set();
    const size = sizeOf(file);
    if (size === undefined || size === 0) return new Set();
    return deliveredIds(readRange(file, 0, size), wanted);
  }

  /** Ids that appeared since the last look. */
  scan(ids: Iterable<string>): Set<string> {
    const wanted = [...ids];
    if (wanted.length === 0) return new Set();
    this.transcript ??= findTranscript(this.sessionId, this.cwd, this.configDir);
    if (this.transcript === undefined) return new Set();
    const size = sizeOf(this.transcript);
    if (size === undefined || size <= this.offset) return new Set();
    const added = readRange(this.transcript, this.offset, size);
    // A line Claude Code is still writing waits for the next look.
    const complete = wholeLines(added);
    this.offset += Buffer.byteLength(added.slice(0, complete), "utf8");
    return deliveredIds(added.slice(0, complete), wanted);
  }
}
