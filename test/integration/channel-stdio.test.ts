/**
 * The entry point, started the way Claude Code starts it: a stdio MCP client
 * with the session identity in the environment. This proves the channel
 * handshake and that the declared capability arrives, which no unit test can.
 *
 * It never touches the live bus: PI_CODING_AGENT_DIR points at a scratch
 * directory, so a future phase that connects would reach a broker of its own.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PI_INTERCOM_CONTRACT } from "../../src/intercom/adapter.ts";
import { labelFor, pinnedSessionId } from "../../src/intercom/identity.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const entry = path.join(root, "bin/claude-intercom-mcp.js");

test("the channel declares claude/channel, registers, and answers intercom_status", async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "claude-intercom-channel-"));
  const client = new Client({ name: "claude-code", version: "0.0.0" }, { capabilities: {} });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      stderr: "pipe",
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: scratch,
        CLAUDE_CONFIG_DIR: path.join(scratch, "claude"),
        CLAUDE_CODE_SESSION_ID: "00000000-0000-4000-8000-000000000000",
        CLAUDE_PROJECT_DIR: path.join(scratch, "project"),
        PI_CODING_AGENT_DIR: path.join(scratch, "agent"),
      },
    }));

    assert.deepEqual(client.getServerCapabilities()?.experimental?.["claude/channel"], {});

    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["intercom_status"]);

    const status = await client.callTool({ name: "intercom_status", arguments: {} });
    const content = status.content as { type: string; text: string }[];
    const project = path.join(scratch, "project");
    const report = JSON.parse(content[0]!.text) as {
      phase: string;
      registered: boolean;
      sessionId: string | null;
      mailbox: string;
      label: string;
      upstream: { package: string; version: string };
    };
    assert.equal(report.phase, "P1");
    assert.equal(report.registered, true);
    assert.equal(report.mailbox, pinnedSessionId(project));
    assert.equal(report.sessionId, pinnedSessionId(project));
    assert.equal(report.label, labelFor(project));
    assert.equal(report.upstream.package, PI_INTERCOM_CONTRACT.package);
    assert.equal(report.upstream.version, PI_INTERCOM_CONTRACT.version);
  } finally {
    await client.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
