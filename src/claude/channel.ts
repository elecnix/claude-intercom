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
import { startSession, type RunningSession } from "../intercom/session.ts";

const log = (...args: unknown[]): void => console.error("[claude-intercom]", ...args);

const STATUS_TOOL = {
  name: "intercom_status",
  description: "Report this session's identity on the pi-intercom bus and what the channel is connected to.",
  inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
};

function statusReport(session: RunningSession, cwd: string): string {
  const state = session.state();
  return JSON.stringify({
    phase: "P1",
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
    note: "Incoming messages are received but not delivered to the model until P2 and P4.",
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
    return { content: [{ type: "text" as const, text: statusReport(session, cwd) }] };
  });

  // Exit with the session: a leftover server would show this session as listening.
  let quitting = false;
  const quit = (): void => {
    if (quitting) return;
    quitting = true;
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
