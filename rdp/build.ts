/**
 * Builds the RDP page into `dist/rdp/`: a static site that only delivers code (connecting goes
 * through topics and iroh), so it can be served from anywhere.
 *
 *   dist/rdp/index.html, page.js (the page's PostalService), client.js (the client actor),
 *   link/ (the browser iroh module: submodules/petplay_mediatransport/link-web/pkg-web).
 *
 * Needs `link-web/build.sh` to have run. `deno task rdp:build`.
 */
import { fromFileUrl } from "@std/path";

const root = fromFileUrl(new URL("../", import.meta.url));
const out = `${root}dist/rdp`;
const linkWeb = `${root}submodules/petplay_mediatransport/link-web/pkg-web`;

await Deno.mkdir(`${out}/link`, { recursive: true });
for (const [entry, file] of [["web/rdp/page.ts", "page.js"], ["web/rdp/client.ts", "client.js"]]) {
  const { code, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["bundle", "--platform", "browser", "--minify", "-o", `${out}/${file}`, `${root}${entry}`],
    stdout: "inherit",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    console.error(new TextDecoder().decode(stderr));
    Deno.exit(code);
  }
}
await Deno.copyFile(`${root}web/rdp/index.html`, `${out}/index.html`);
for (const file of ["petplay_link_web.js", "petplay_link_web_bg.wasm"]) {
  try {
    await Deno.copyFile(`${linkWeb}/${file}`, `${out}/link/${file}`);
  } catch {
    console.error(`missing ${linkWeb}/${file}: run submodules/petplay_mediatransport/link-web/build.sh`);
    Deno.exit(1);
  }
}
console.log(`built ${out}`);
