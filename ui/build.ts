/**
 * Builds the UI preview page into `dist/ui/`:
 *   dist/ui/index.html, page.js (main thread DOM/canvas bridge), client.js (OffscreenCanvas worker).
 *
 * `deno task ui:build`.
 */
import { fromFileUrl } from "@std/path";

export async function buildUiBundle(): Promise<string> {
  const root = fromFileUrl(new URL("../", import.meta.url));
  const out = `${root}dist/ui`;

  await Deno.mkdir(out, { recursive: true });
  for (
    const [entry, file] of [
      ["ui/browser/page.ts", "page.js"],
      ["ui/browser/client.ts", "client.js"],
    ]
  ) {
    const { code, stderr } = await new Deno.Command(Deno.execPath(), {
      args: [
        "bundle",
        "--platform",
        "browser",
        "--minify",
        "-o",
        `${out}/${file}`,
        `${root}${entry}`,
      ],
      stdout: "inherit",
      stderr: "piped",
    }).output();
    if (code !== 0) {
      throw new Error(`bundle ${entry} failed:\n${new TextDecoder().decode(stderr)}`);
    }
  }
  await Deno.copyFile(`${root}ui/browser/index.html`, `${out}/index.html`);
  return out;
}

if (import.meta.main) {
  const out = await buildUiBundle();
  console.log(`built ${out}`);
}
