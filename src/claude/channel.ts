/**
 * The Claude Code channel, P0.
 *
 * At this phase the server proves the two things that cannot be faked later: it
 * speaks MCP over stdio with the `claude/channel` capability declared, and it
 * starts at all when launched the way Claude Code launches it. Registration,
 * the outbox and the push path arrive in later phases; `intercom_status` is the
 * only tool, and it says so rather than pretending otherwise.
 *
 * stdout carries the MCP protocol, so every log line goes to stderr.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PI_INTERCOM_CONTRACT } from "../intercom/adapter.ts";

const log = (...args: unknown[]): void => console.error("[claude-intercom]", ...args);

const STATUS_TOOL = {
  name: "intercom_status",
  description: "Report what this channel is connected to. P0 reports the pinned upstream contract only.",
  inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
};

function statusReport(): string {
  return JSON.stringify({
    phase: "P0",
    registered: false,
    upstream: {
      package: PI_INTERCOM_CONTRACT.package,
      version: PI_INTERCOM_CONTRACT.version,
      protocol: PI_INTERCOM_CONTRACT.protocol,
    },
    note: "Registration, presence labels and the durable outbox arrive in P1 and P2.",
  }, null, 2);
}

export async function main(): Promise<void> {
  const server = new Server(
    { name: "claude-intercom", version: "0.0.0" },
    {
      capabilities: { experimental: { "claude/channel": {} }, tools: {} },
      instructions: [
        "This server carries intercom traffic for this session: messages from other coding agents,",
        "and the replies to questions this session asked.",
        "At P0 it only reports status.",
      ].join(" "),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [STATUS_TOOL] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== STATUS_TOOL.name) {
      return { content: [{ type: "text" as const, text: `Unknown tool: ${request.params.name}` }], isError: true };
    }
    return { content: [{ type: "text" as const, text: statusReport() }] };
  });

  // Exit with the session: a leftover server would show this session as listening.
  const quit = (): void => {
    process.exit(0);
  };
  process.stdin.on("end", quit);
  process.stdin.on("close", quit);
  process.on("SIGTERM", quit);
  process.on("SIGINT", quit);
  server.onclose = quit;

  await server.connect(new StdioServerTransport());
  log("channel ready, P0 status only");
}
