/**
 * The outbox: what arrived, what was pushed, and what the model actually saw.
 *
 * This exists because the broker forgets a message the moment it writes it to
 * the socket. If the channel then fails to push, or Claude Code queues the push
 * and never shows it, the text is gone from every queue on the machine. So the
 * entry is written to disk first, and it stays there until a transcript line
 * proves the model received it.
 *
 * `readAt` is the only field that means delivered to the model. `deliveredAt`
 * means a notification was written to the transport, which is weaker: Claude
 * Code can accept it and still never put it in a turn.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Inbound } from "./adapter.ts";

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export interface OutboxEntry {
  messageId: string;
  from: { id: string; name?: string; cwd: string };
  text: string;
  expectsReply: boolean;
  receivedAt: string;
  /** A channel notification was written to the transport. */
  deliveredAt?: string;
  /** The id appears in a transcript line that records the model receiving it. */
  readAt?: string;
}

export class Outbox {
  private constructor(
    private readonly file: string,
    private entries: OutboxEntry[],
  ) {}

  static load(file: string): Outbox {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      return new Outbox(file, Array.isArray(parsed) ? (parsed as OutboxEntry[]) : []);
    } catch {
      // A missing or corrupt outbox is an empty one, not a crash at startup.
      return new Outbox(file, []);
    }
  }

  /** A write that is never half a file: a crash mid-save leaves the old outbox. */
  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.entries, null, 2)}\n`);
    renameSync(temp, this.file);
  }

  /** Record an arrival. Repeating the same message id is not a second message. */
  record(inbound: Inbound, now = new Date()): OutboxEntry {
    const existing = this.entries.find((entry) => entry.messageId === inbound.message.id);
    if (existing) return existing;
    const entry: OutboxEntry = {
      messageId: inbound.message.id,
      from: {
        id: inbound.from.id,
        ...(inbound.from.name === undefined ? {} : { name: inbound.from.name }),
        cwd: inbound.from.cwd,
      },
      text: inbound.message.content.text,
      expectsReply: inbound.message.expectsReply === true,
      receivedAt: now.toISOString(),
    };
    this.entries.push(entry);
    return entry;
  }

  markDelivered(messageId: string, at = new Date()): boolean {
    const entry = this.entries.find((candidate) => candidate.messageId === messageId);
    if (!entry || entry.deliveredAt !== undefined) return false;
    entry.deliveredAt = at.toISOString();
    return true;
  }

  markRead(messageId: string, at = new Date()): boolean {
    const entry = this.entries.find((candidate) => candidate.messageId === messageId);
    if (!entry || entry.readAt !== undefined) return false;
    entry.readAt = at.toISOString();
    return true;
  }

  all(): OutboxEntry[] {
    return [...this.entries];
  }

  /** Written by the broker, not yet pushed. */
  undelivered(): OutboxEntry[] {
    return this.entries.filter((entry) => entry.deliveredAt === undefined);
  }

  /** Pushed or not, still not proven received by the model. */
  unread(): OutboxEntry[] {
    return this.entries.filter((entry) => entry.readAt === undefined);
  }

  /** Read entries age out; unread ones survive, because they are still owed an answer. */
  prune(now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS): void {
    this.entries = this.entries.filter((entry) => {
      const readAt = entry.readAt === undefined ? undefined : Date.parse(entry.readAt);
      return readAt === undefined || now - readAt < maxAgeMs;
    });
  }
}
