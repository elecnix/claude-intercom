#!/usr/bin/env node
// The Claude Code MCP channel entry point.
//
// tsx is registered before the first import of a .ts file, because the adapter
// loads TypeScript source from inside node_modules and Node refuses to strip
// types there. pi-intercom's own CLI registers tsx for the same reason; see
// cli.mjs in that package.
import { register } from "tsx/esm/api";

register();
// main() resolves once the transport is attached; the process stays alive on
// stdin, which is what Claude Code closes to end the server.
const { main } = await import("../src/claude/channel.ts");
await main();
