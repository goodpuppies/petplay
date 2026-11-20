/**
 * `deno task build`: compile the launcher into `dist/`.
 *
 * Deno already handles the per-OS executable suffix — `--output dist/petplay` becomes
 * `dist/petplay.exe` when targeting Windows — so the only thing that has to branch is the icon,
 * which Deno refuses outside Windows (`--icon` on Linux: *"only available when targeting
 * Windows"*). Writing into `dist/` also keeps the output from colliding with the `petplay/`
 * source directory on the OSes where the binary has no extension.
 */
import { nativeBuildTarget } from "../classes/nativeBuildTarget.ts";
import { buildRaylib } from "./build-raylib.ts";
import { buildNative } from "./build-native.ts";

import { parseBuildConfiguration } from "../classes/buildConfiguration.ts";
const configuration = parseBuildConfiguration(Deno.args);
const { mode, target, output } = configuration;

const webxr = await new Deno.Command(Deno.execPath(), {
  args: ["task", "build:webxr"],
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).output();
if (!webxr.success) throw new Error(`WebXR runtime build failed (${webxr.code})`);

await Deno.mkdir("dist", { recursive: true });
// The per-run log (classes/runLog.ts) names the build a tester ran.
const commit = new TextDecoder().decode(
  (await new Deno.Command("git", { args: ["rev-parse", "HEAD"], stdout: "piped", stderr: "null" })
    .output())
    .stdout,
).trim();
// The version shown in the wrist menu and checked by the update prompt (classes/buildInfo.ts).
const version = new TextDecoder().decode(
  (await new Deno.Command("git", {
    args: ["describe", "--tags", "--always", "--dirty"],
    stdout: "piped",
    stderr: "null",
  }).output()).stdout,
).trim();
await Deno.writeTextFile(
  "dist/build-info.json",
  JSON.stringify({
    version: version || null,
    commit: commit || null,
    target: target ?? Deno.build.target,
    built: new Date().toISOString(),
    mode,
  }) +
    "\n",
);
const resolvedTarget = nativeBuildTarget(target);
// Both variants ship the optimized capture helper: an unoptimized one manages about 4 fps, and
// building it would overwrite the dist/native copy that source runs use.
const captureHelper = await buildNative(resolvedTarget);
const raylib = resolvedTarget === "aarch64-unknown-linux-gnu"
  ? await buildRaylib(resolvedTarget, Deno.env.get("PETPLAY_RAYLIB_SYSROOT"))
  : null;

// Every directory holding a module that is spawned by URL at runtime has to be embedded as files:
// actors are workers, and `{ worker: "process" }` children are dispatched into a module href. The
// actor modules live in `petplay/` and `classes/`; `IPCWorker` reaches its host module inside
// stageforge. A module whose directory is missing here only fails once that child is actually
// spawned, so keep this list in step with the spawn sites.
const args = [
  "compile",
  "-A",
  // Always use the explicit variant, including native builds: private .env is not a build input.
  `--env-file=${configuration.envFile}`,
  "--no-check",
  ...(target ? ["--target", target] : []),
  "--include",
  "./petplay/",
  "--include",
  "./classes/",
  // desktopInput and desktopSource are spawned by main; their own imports come with them.
  "--include",
  "./rdp/desktopInput.ts",
  "--include",
  "./rdp/desktopSource.ts",
  "--include",
  "./resources/",
  "--include",
  "./submodules/threewebxrwebgpudeno/submodules/iwer/packages/iwer/build/",
  "--include",
  captureHelper,
  ...(raylib ? ["--include", raylib] : []),
  "--include",
  "./dist/build-info.json",
  "--include",
  "./submodules/stageforge/",
  // Agent playtests are dynamically imported inside the compiled webxr worker too.
  "--include",
  "./utils/playtest.ts",
  "--include",
  "./tests/playtest/",
  "--include",
  "./submodules/threewebxrwebgpudeno/vendor/three-msdf-text-utils/demo/fonts/roboto/",
  "--include",
  "./resources/fonts/",
  "--output",
  output,
];

if (Deno.build.os === "windows" && !target) {
  args.push("--icon", "resources/petplay.ico");
}

// `dev` matches the previous release launcher: the compiled binary boots straight into a session.
args.push("petplay/petplay.ts", "dev");

const build = new Deno.Command(Deno.execPath(), {
  args,
  // Package export conditions are resolved while compiling, so the compiler needs them too.
  env: { DENO_CONDITIONS: mode, NODE_ENV: mode },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
const { code } = await build.output();
Deno.exit(code);
