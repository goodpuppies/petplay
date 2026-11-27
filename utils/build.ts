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
import { buildMedia, buildNative } from "./build-native.ts";

import { parseBuildConfiguration } from "../classes/buildConfiguration.ts";
const configuration = parseBuildConfiguration(Deno.args);
const { mode, target, output } = configuration;

const webxrBundle =
  "submodules/threewebxrwebgpudeno/submodules/iwer/packages/iwer/build/iwer.module.js";
const prebuiltWebxr = Deno.env.get("PETPLAY_PREBUILT_WEBXR") === "1" &&
  await Deno.stat(webxrBundle).then(() => true, () => false);
if (prebuiltWebxr) {
  console.log(`Reusing ${webxrBundle}`);
} else {
  const webxr = await new Deno.Command(Deno.execPath(), {
    args: ["task", "build:webxr"],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!webxr.success) throw new Error(`WebXR runtime build failed (${webxr.code})`);
}

await Deno.mkdir("dist", { recursive: true });
// The per-run log (classes/runLog.ts) names the build a tester ran.
const commit = new TextDecoder().decode(
  (await new Deno.Command("git", { args: ["rev-parse", "HEAD"], stdout: "piped", stderr: "null" })
    .output())
    .stdout,
).trim();
// The version shown in the wrist menu and compared by the updater (classes/buildInfo.ts,
// classes/updater.ts). "-dirty" only for edits to PetPlay's own tracked files, and never in CI,
// whose checkout is exactly the commit: CI's own preconf/install steps made every release "dirty".
const git = async (...args: string[]) =>
  new TextDecoder().decode(
    (await new Deno.Command("git", { args, stdout: "piped", stderr: "null" }).output()).stdout,
  ).trim();
const dirty = Deno.env.get("GITHUB_ACTIONS") !== "true" &&
  (await git("status", "--porcelain", "--ignore-submodules=all", "--untracked-files=no")) !== "";
// Release tags only: branch builds are tagged `build-…` too (utils/publish-branch-build.ts).
const describe = await git("describe", "--tags", "--always", "--match", "v[0-9]*");
const version = describe && dirty ? `${describe}-dirty` : describe;
await Deno.writeTextFile(
  "dist/build-info.json",
  JSON.stringify({
    version: version || null,
    commit: commit || null,
    target: target ?? Deno.build.target,
    built: new Date().toISOString(),
    mode,
    channel: ciChannel(),
    // The runtime embedded in the executable; peer builds compare it (utils/peer-build.ts).
    deno: Deno.version.deno,
  }) +
    "\n",
);
/** The update channel a CI build belongs to (classes/updater.ts); local builds have none. */
function ciChannel(): string | null {
  if (Deno.env.get("GITHUB_ACTIONS") !== "true") return null;
  const refType = Deno.env.get("GITHUB_REF_TYPE");
  if (refType === "tag") return "stable";
  const repo = Deno.env.get("GITHUB_REPOSITORY");
  // A pull request build's ref is the merge ref, not a channel anyone can follow.
  const branch = Deno.env.get("GITHUB_EVENT_NAME") === "pull_request"
    ? null
    : Deno.env.get("GITHUB_REF_NAME");
  return refType === "branch" && repo && branch ? `${repo}#${branch}` : null;
}

const resolvedTarget = nativeBuildTarget(target);
// Both variants ship the optimized capture helper: an unoptimized one manages about 4 fps, and
// building it would overwrite the dist/native copy that source runs use.
const captureHelper = await buildNative(resolvedTarget);
const mediaHelper = await buildMedia(resolvedTarget);
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
  "--include",
  mediaHelper,
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

for (const path of localOnlyPaths()) args.push("--exclude", path);

/**
 * What a working checkout has and CI's clean one does not: agent scratch, earlier build outputs,
 * Rust `target/` dirs and `node_modules` other than the root one (submodules' dev installs). The
 * compiler embeds those when they sit under an included directory or next to a package.json, and
 * they made a local build 1.4 GB instead of CI's ~420 MB, and different enough from it that a
 * peer build (utils/peer-build.ts) had to send nearly all of it.
 */
function localOnlyPaths(): string[] {
  const found = ["./_scratch", "./dist/peer"];
  const walk = (dir: string) => {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      const path = `${dir}/${entry.name}`;
      // The compiler takes `--exclude` of a whole node_modules dir, not of a dir holding one, so
      // _scratch is walked as well.
      if (path === "./node_modules" || path === "./dist") continue;
      if (entry.name === ".git") continue;
      if (entry.name === "node_modules" || entry.name === "target") found.push(path);
      else walk(path);
    }
  };
  walk(".");
  // Native npm packages for the building machine's OS that nothing at runtime imports: the
  // iroh Node binding (the link runs in petplay-media) and the tsrs type checker. They are a
  // tenth of the binary, and differ between a cross build and the target OS's own build.
  try {
    for (const entry of Deno.readDirSync("./node_modules/.deno")) {
      if (/^@number0\+iroh-|^@tsrs\+/.test(entry.name)) {
        found.push(`./node_modules/.deno/${entry.name}`);
      }
    }
  } catch {
    // No node_modules yet.
  }
  return found;
}

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
