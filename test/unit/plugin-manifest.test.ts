/**
 * Packaging: the plugin manifest is what makes the channel a channel, and the
 * entry point it names has to exist and be executable. A manifest that points
 * at a missing file loads as nothing, silently.
 */
import assert from "node:assert/strict";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8")) as {
  name?: unknown;
  mcpServers?: Record<string, { command?: unknown }>;
  channels?: { server?: unknown }[];
};

test("the plugin manifest declares the MCP server and the channel that carries it", () => {
  assert.equal(manifest.name, "claude-intercom");
  assert.ok(manifest.mcpServers?.["claude-intercom"], "plugin.json names no claude-intercom MCP server");
  assert.deepEqual(
    manifest.channels?.map((channel) => channel.server),
    ["claude-intercom"],
    "plugin.json must declare the channel, or events never reach the model",
  );
});

test("the declared entry point exists and is executable", () => {
  const command = manifest.mcpServers?.["claude-intercom"]?.command;
  assert.ok(typeof command === "string", "the manifest declares no command");
  const entry = command.replace("${CLAUDE_PLUGIN_ROOT}/", "");
  const path = join(root, entry);
  const mode = statSync(path).mode;
  assert.ok(mode & 0o111, `${entry} is not executable`);
  assert.doesNotThrow(() => accessSync(path, constants.X_OK));
});
