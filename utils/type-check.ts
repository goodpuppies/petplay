#!/usr/bin/env -S deno run -A
/**
 * Type check PetPlay with tsrs (the Rust port of TypeScript 7) against tsconfig.json.
 *
 *   deno task check          tsrs, filtered (this script)
 *   deno task check:deno     Deno's own `deno check`, unfiltered, for comparison
 *
 * Deno's runtime declarations come from `deno types`, regenerated into dist/types/ whenever the
 * Deno version changes, so the globals always match the runtime that runs the code.
 *
 * Errors are filtered by where they are (their primary location), never by what they mention:
 * vendored third-party sources are expected to carry errors, but an error in our code that
 * involves a vendored type must still show.
 */
import { fromFileUrl } from "@std/path";

const root = fromFileUrl(new URL("../", import.meta.url));

/** Third-party code compiled from source; errors there are expected. */
const IGNORED_LOCATIONS = [
  "node_modules/",
  "dist/",
  "research/",
  "submodules/threewebxrwebgpudeno/submodules/",
  "submodules/threewebxrwebgpudeno/vendor/",
  "submodules/gluten/",
  "submodules/byte_type_C/",
];

/** Known, deliberate exceptions in our own code. */
const IGNORED_DIAGNOSTICS: Array<(d: Diagnostic) => boolean> = [
  // `/// <reference lib="deno.worker" />` etc.: deno.d.ts already declares them globally.
  (d) => d.code === "TS2726" && d.message.includes("'deno."),
  // Generated preconf setter imports a module that only exists in its build context.
  (d) => d.file === "utils/preconf/setter.ts" && d.code === "TS2307",
];

type Diagnostic = { file: string; line: number; col: number; code: string; message: string };

async function denoTypes(): Promise<void> {
  const dir = `${root}dist/types`;
  const marker = `${dir}/deno.version`;
  const version = Deno.version.deno;
  try {
    if ((await Deno.readTextFile(marker)).trim() === version) return;
  } catch { /* first run */ }
  const out = await new Deno.Command(Deno.execPath(), { args: ["types"], stdout: "piped" }).output();
  if (!out.success) throw new Error("deno types failed");
  // tsc has no deno.* libs; everything they name is in this one file already.
  const text = new TextDecoder().decode(out.stdout)
    .replace(/^\/\/\/ <reference lib="deno\.[^"]+" \/>$/gm, "");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/deno.d.ts`, text);
  await Deno.writeTextFile(marker, version);
}

function parse(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const line of output.split("\n")) {
    const m = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
    if (m) {
      diagnostics.push({
        file: m[1].replace(/\\/g, "/").replace(/^\.\//, ""),
        line: Number(m[2]),
        col: Number(m[3]),
        code: m[4],
        message: m[5],
      });
    } else if (diagnostics.length && /^\s/.test(line) && line.trim()) {
      diagnostics[diagnostics.length - 1].message += `\n${line}`;
    }
  }
  return diagnostics;
}

export async function typeCheck(): Promise<{ shown: Diagnostic[]; filtered: number; raw: string }> {
  await denoTypes();
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${root}node_modules/tsrs/bin/tsrs`, "-p", `${root}tsconfig.json`, "--pretty", "false"],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const raw = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  const all = parse(raw);
  if (!out.success && all.length === 0) throw new Error(raw.trim() || `tsrs exited with ${out.code}`);
  const shown = all.filter((d) =>
    !IGNORED_LOCATIONS.some((prefix) => d.file.startsWith(prefix)) &&
    !IGNORED_DIAGNOSTICS.some((ignore) => ignore(d))
  );
  return { shown, filtered: all.length - shown.length, raw };
}

if (import.meta.main) {
  const started = performance.now();
  const { shown, filtered } = await typeCheck();
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  for (const d of shown) console.log(`${d.file}:${d.line}:${d.col} ${d.code} ${d.message}\n`);
  if (shown.length === 0) {
    console.log(`✅ No type errors (${filtered} in vendored code filtered, ${seconds}s)`);
  } else {
    console.log(`${shown.length} error(s) (${filtered} in vendored code filtered, ${seconds}s)`);
    Deno.exit(1);
  }
}
