/**
 * Where this plugin is allowed to write on the user's machine.
 *
 * One directory per session id, under Claude Code's own state root, so an
 * uninstall can be a single `rm -rf` and `CLAUDE_CONFIG_DIR` moves everything
 * with it.
 */
import os from "node:os";
import { join } from "node:path";

/** Claude Code's state root, which a lab overrides with CLAUDE_CONFIG_DIR. */
export function claudeConfigDir(): string {
  return process.env["CLAUDE_CONFIG_DIR"] ?? join(os.homedir(), ".claude");
}

export function intercomStateDir(sessionId: string, configDir: string = claudeConfigDir()): string {
  return join(configDir, "intercom", sessionId);
}

export function outboxPath(sessionId: string, configDir: string = claudeConfigDir()): string {
  return join(intercomStateDir(sessionId, configDir), "outbox.json");
}
