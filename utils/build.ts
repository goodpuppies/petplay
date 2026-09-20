/**
 * `deno task build`: compile the launcher into `dist/`.
 *
 * Deno already handles the per-OS executable suffix — `--output dist/petplay` becomes
 * `dist/petplay.exe` when targeting Windows — so the only thing that has to branch is the icon,
 * which Deno refuses outside Windows (`--icon` on Linux: *"only available when targeting
 * Windows"*). Writing into `dist/` also keeps the output from colliding with the `petplay/`
 * source directory on the OSes where the binary has no extension.
 */
const output = "dist/petplay";

await Deno.mkdir("dist", { recursive: true });

// Every directory holding a module that is spawned by URL at runtime has to be embedded as files:
// actors are workers, and `{ worker: "process" }` children are dispatched into a module href. The
// actor modules live in `petplay/` and `classes/`; `IPCWorker` reaches its host module inside
// stageforge. A module whose directory is missing here only fails once that child is actually
// spawned, so keep this list in step with the spawn sites.
const args = [
  "compile",
  "-A",
  "--env-file",
  "--no-check",
  "--include",
  "./petplay/",
  "--include",
  "./classes/",
  "--include",
  "./resources/",
  "--include",
  "./submodules/stageforge/",
  "--include",
  "./submodules/threewebxrwebgpudeno/vendor/three-msdf-text-utils/demo/fonts/roboto/",
  "--include",
  "./resources/fonts/",
  "--output",
  output,
];

if (Deno.build.os === "windows") {
  args.push("--icon", "resources/petplay.ico");
}

// `dev` matches the previous release launcher: the compiled binary boots straight into a session.
args.push("petplay/petplay.ts", "dev");

const build = new Deno.Command(Deno.execPath(), {
  args,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
const { code } = await build.output();
Deno.exit(code);
