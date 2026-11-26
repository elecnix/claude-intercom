/**
 * The seam is only real if nothing else crosses it.
 *
 * The adapter exists so that an upstream change lands in one file. That holds
 * only while pi-intercom is imported nowhere else, so this test reads the tree
 * rather than trusting a reviewer to notice.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const adapter = join(root, "src/intercom/adapter.ts");

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (/\.(ts|js|mjs)$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

test("pi-intercom is imported only by the adapter", () => {
  const offenders = [...sourceFiles(join(root, "src")), ...sourceFiles(join(root, "bin"))]
    .filter((path) => path !== adapter)
    .filter((path) => /["']pi-intercom(\/|["'])/.test(readFileSync(path, "utf8")));
  assert.deepEqual(
    offenders.map((path) => path.slice(root.length)),
    [],
    "these files import pi-intercom directly; go through src/intercom/adapter.ts",
  );
});
