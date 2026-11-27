/**
 * The Claude Code channel.
 *
 * At P1 the server registers on the bus under an id chosen from the repository
 * directory, publishes a readable label, and reports both through
 * `intercom_status`. Messages are received but not yet handled: the durable
 * outbox and the channel push arrive in P2 and P4, so a message sent to this
 * session today lands on a socket that logs it and nothing more.
 *
 * stdout carries the MCP protocol, so every log line goes to stderr.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PI_INTERCOM_CONTRACT, createChannelBus } from "../intercom/adapter.ts";
import { labelFor, pinnedSessionId } from "../intercom/identity.ts";
import { Outbox } from "../intercom/outbox.ts";
import { outboxPath } from "../intercom/paths.ts";
import { startSession, type RunningSession } from "../intercom/session.ts";
import { ReceiptScan } from "./transcript.ts";

const log = (...args: unknown[]): void => console.error("[claude-intercom]", ...args);

const STATUS_TOOL = {
  name: "intercom_status",
  description: "Report this session's identity on the pi-intercom bus and what the channel is connected to.",
  inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
};

function statusReport(session: RunningSession, cwd: string, outbox: Outbox): string {
  const state = session.state();
  return JSON.stringify({
    phase: "P2",
    registered: state.status === "registered",
    sessionId: session.sessionId(),
    mailbox: pinnedSessionId(cwd),
    label: state.status === "registered" ? state.label : labelFor(cwd),
    state,
    upstream: {
      package: PI_INTERCOM_CONTRACT.package,
      version: PI_INTERCOM_CONTRACT.version,
      protocol: PI_INTERCOM_CONTRACT.protocol,
    },
    outbox: {
      entries: outbox.all().length,
      unread: outbox.unread().length,
      undelivered: outbox.undelivered().length,
    },
    note: "Arrivals are written to the outbox before anything else; the channel push that starts a turn arrives in P4, so nothing reaches the model yet.",
  }, null, 2);
}

export async function main(): Promise<void> {
  const cwd = process.env["CLAUDE_PROJECT_DIR"]?.trim() || process.cwd();
  const label = process.env["CLAUDE_INTERCOM_LABEL"]?.trim() || labelFor(cwd);

  const bus = createChannelBus();
  const session = await startSession(bus, {
    cwd,
    label,
    onStateChange: (state) => {
      if (state.status === "registered") log(`registered as ${state.sessionId} (${state.label})`);
      else if (state.status === "disconnected") log(`disconnected: ${state.reason}; retrying in ${state.retryInMs} ms`);
    },
  });

  // The outbox follows the claimed id, which is the mailbox: a session that took
  // a "-2" suffix owns a different directory of its own.
  const sessionId = session.sessionId() ?? pinnedSessionId(cwd);
  const outbox = Outbox.load(outboxPath(sessionId));
  const transcriptSession = process.env["CLAUDE_CODE_SESSION_ID"]?.trim();

  bus.onMessage((inbound) => {
    const entry = outbox.record(inbound);
    outbox.save();
    log(`recorded ${entry.messageId} from ${entry.from.name ?? entry.from.id}`);
  });

  // Mark read only what a transcript line proves the model received. An id that
  // appears in a tool result is not a delivery, and `deliveredLine` filters it.
  const scan = transcriptSession === undefined ? undefined : new ReceiptScan(transcriptSession, cwd);
  const markRead = (ids: Set<string>): void => {
    let changed = false;
    for (const id of ids) changed = outbox.markRead(id) || changed;
    if (changed) outbox.save();
  };
  if (scan !== undefined) {
    scan.start();
    markRead(scan.search(outbox.unread().map((entry) => entry.messageId)));
  }
  outbox.prune();
  outbox.save();

  const scanTimer = setInterval(() => {
    if (scan === undefined) return;
    const pending = outbox.unread().map((entry) => entry.messageId);
    if (pending.length === 0) return;
    markRead(scan.scan(pending));
  }, 500);
  scanTimer.unref?.();

  const server = new Server(
    { name: "claude-intercom", version: "0.0.0" },
    {
      capabilities: { experimental: { "claude/channel": {} }, tools: {} },
      instructions: [
        "This server carries intercom traffic for this session: messages from other coding agents,",
        "and the replies to questions this session asked.",
        "At P1 it reports identity and connection state; delivery to the model arrives with the durable outbox.",
      ].join(" "),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [STATUS_TOOL] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== STATUS_TOOL.name) {
      return { content: [{ type: "text" as const, text: `Unknown tool: ${request.params.name}` }], isError: true };
    }
    return { content: [{ type: "text" as const, text: statusReport(session, cwd, outbox) }] };
  });

  // Exit with the session: a leftover server would show this session as listening.
  let quitting = false;
  const quit = (): void => {
    if (quitting) return;
    quitting = true;
    clearInterval(scanTimer);
    outbox.save();
    void session.stop().finally(() => process.exit(0));
  };
  process.stdin.on("end", quit);
  process.stdin.on("close", quit);
  process.on("SIGTERM", quit);
  process.on("SIGINT", quit);
  server.onclose = quit;

  await server.connect(new StdioServerTransport());
  log("channel ready, P1 identity");
}
