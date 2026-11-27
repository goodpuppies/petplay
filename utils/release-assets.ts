/**
 * `deno run -A --no-config utils/release-assets.ts <dir> <file>...`: what a release (tagged, or a
 * branch build) publishes besides the binaries. For each executable it writes
 * `<name>.chunks.json`, the chunk index the updater's delta downloads read
 * (classes/updateChunks.ts), then `SHA256SUMS` over every file, indexes included.
 *
 * Executables are the files named `petplay*` without an extension other than `.exe`.
 */
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { indexFile, readFileBlocks } from "../classes/updateChunks.ts";

// Runs with --no-config in release jobs (no `deno install`), so only node: and relative imports.
async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const block of readFileBlocks(path)) hash.update(block);
  return hash.digest("hex");
}

const [dir, ...names] = Deno.args;
if (!dir || names.length === 0) {
  console.error("usage: release-assets.ts <dir> <file>...");
  Deno.exit(2);
}
const isExecutable = (name: string) => /^petplay(-[a-z0-9]+)?(\.exe)?$/.test(name);
const published = [...names];
for (const name of names.filter(isExecutable)) {
  const started = performance.now();
  const index = await indexFile(join(dir, name));
  const indexName = `${name}.chunks.json`;
  await Deno.writeTextFile(join(dir, indexName), JSON.stringify(index));
  published.push(indexName);
  console.log(
    `${indexName}: ${index.lengths.length} chunks of ${(index.size / 1e6).toFixed(0)} MB in ${
      ((performance.now() - started) / 1000).toFixed(1)
    } s`,
  );
}
const lines: string[] = [];
for (const name of published) lines.push(`${await sha256File(join(dir, name))}  ${basename(name)}`);
await Deno.writeTextFile(join(dir, "SHA256SUMS"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
