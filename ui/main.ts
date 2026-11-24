/**
 * Standalone web previewer for PetPlay UI & design system mockups.
 *
 * Architecturally mirrors `rdp/main.ts`: constructs a `PostalService`, spawns `ui/preview.ts`
 * (which composes `ui/studio.tsx`), and prints the URL to open in a browser. The UI itself is
 * server-rendered via r3f + uikit + raythree IR and streamed to the browser's OffscreenCanvas.
 *
 *   deno task ui:web [--host=127.0.0.1] [--port=3995] [--scene=wrist] [--no-watch] [--no-build]
 */
import { parseArgs } from "@std/cli/parse-args";
import { fromFileUrl } from "@std/path";
import { PostalService } from "../submodules/stageforge/mod.ts";
import { buildUiBundle } from "./build.ts";

const args = parseArgs(Deno.args, {
  string: ["host", "port", "scene"],
  boolean: ["build", "watch"],
  default: { host: "127.0.0.1", port: "3995", build: true, watch: true },
  negatable: ["build", "watch"],
});

const distDir = fromFileUrl(new URL("../dist/ui", import.meta.url));
if (args.build) {
  await buildUiBundle();
} else {
  try {
    await Deno.stat(`${distDir}/page.js`);
  } catch {
    console.log("[ui] dist/ui not built yet, building…");
    await buildUiBundle();
  }
}

const postal = new PostalService();
const preview = await postal.add("./preview.ts", import.meta.url);
const { url } = await postal.PostMessage({
  target: preview,
  type: "START",
  payload: {
    hostname: args.host,
    port: Number(args.port),
    scene: args.scene,
    dir: distDir,
  },
}, true) as { url: string };

// Saved code patches into the running actors, or reloads them (stageforge HotReload), once the
// project type-checks.
if (args.watch) await postal.enableHotReload({ check: [Deno.execPath(), "task", "check"] });

console.log(`\nPetPlay UI preview: ${url}${args.watch ? " (hot reload on)" : ""}\n`);

let exiting = false;
async function exit(): Promise<void> {
  if (exiting) return;
  exiting = true;
  await postal.shutdownAll({ reason: "process-exit", timeoutMs: 3000, bestEffort: true });
  Deno.exit(0);
}
Deno.addSignalListener("SIGINT", () => void exit());
Deno.addSignalListener("SIGTERM", () => void exit());
