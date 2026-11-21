/**
 * Builds the household agent (`rdp/agent.ts`) for a machine without a checkout: one compiled
 * `petplay-agent`, the helpers it runs, and a launcher that points the agent at them and at
 * `.secret` beside it.
 *
 *   deno task rdp:agent:build              Linux, into dist/agent/
 *     petplay-agent, petplay-media (encoder + iroh link), screen-streamer, run.sh
 *   deno task rdp:agent:build --windows    Windows (cross-built), into dist/agent-windows/
 *     petplay-agent.exe, petplay-media.exe (capture-wgc + iroh link), run.cmd
 *
 * The Windows build needs mingw-w64-gcc for the cross-compiled petplay-media. Copy the
 * directory over, add `.secret`, and run the launcher in the logged-on session (Windows only
 * captures a desktop from there).
 */
import { fromFileUrl } from "@std/path";

const windows = Deno.args.includes("--windows");
const root = fromFileUrl(new URL("../", import.meta.url));
const mediatransport = `${root}submodules/petplay_mediatransport`;
const out = `${root}dist/${windows ? "agent-windows" : "agent"}`;

async function run(command: string, args: string[], cwd = root): Promise<void> {
  const { code } = await new Deno.Command(command, { args, cwd, stdout: "inherit", stderr: "inherit" })
    .output();
  if (code !== 0) Deno.exit(code);
}

await Deno.mkdir(out, { recursive: true });
// Actors are workers spawned by URL; their modules must be embedded.
const compile = (target: string[], output: string) =>
  run(Deno.execPath(), [
    "compile",
    "-A",
    "--no-check",
    ...target,
    "--include",
    "./rdp/desktopSource.ts",
    "--include",
    "./rdp/desktopInput.ts",
    "-o",
    output,
    "./rdp/agent.ts",
  ]);

if (windows) {
  const target = "x86_64-pc-windows-gnu";
  await run("cargo", [
    "build",
    "--release",
    "--target",
    target,
    "--no-default-features",
    "--features",
    "decode-windows,capture-windows",
    "--target-dir",
    "target/wincheck",
  ], mediatransport);
  await compile(["--target", "x86_64-pc-windows-msvc"], `${out}/petplay-agent.exe`);
  await Deno.copyFile(
    `${mediatransport}/target/wincheck/${target}/release/petplay-media.exe`,
    `${out}/petplay-media.exe`,
  );
  await Deno.writeTextFile(
    `${out}/run.cmd`,
    [
      "@echo off",
      "rem Offers this machine's desktop to the household (rdp/agent.ts). Needs .secret beside this.",
      "rem Run it in the logged-on session: Windows captures a desktop only from there.",
      'set "PETPLAY_MEDIA_BINARY=%~dp0petplay-media.exe"',
      'set "PETPLAY_LINK_BINARY=%~dp0petplay-media.exe"',
      '"%~dp0petplay-agent.exe" --secret-file="%~dp0.secret" %*',
      "",
    ].join("\r\n"),
  );
} else {
  // The encoder and the link in one binary, built apart from the release build PetPlay uses.
  await run("cargo", ["build", "--release", "--features", "iroh", "--target-dir", "target/agent"], mediatransport);
  await run("cargo", ["build", "--release"], `${root}submodules/screen-streamer`);
  await compile([], `${out}/petplay-agent`);
  await Deno.copyFile(`${mediatransport}/target/agent/release/petplay-media`, `${out}/petplay-media`);
  await Deno.copyFile(
    `${root}submodules/screen-streamer/target/release/screen-streamer`,
    `${out}/screen-streamer`,
  );
  await Deno.writeTextFile(
    `${out}/run.sh`,
    `#!/bin/sh
# Offers this machine's desktop to the household (rdp/agent.ts). Needs .secret beside this.
dir=$(cd "$(dirname "$0")" && pwd)
export PETPLAY_MEDIA_BINARY="$dir/petplay-media"
export PETPLAY_LINK_BINARY="$dir/petplay-media"
export PETPLAY_SCREEN_STREAMER="$dir/screen-streamer"
exec "$dir/petplay-agent" --secret-file="$dir/.secret" "$@"
`,
  );
  await Deno.chmod(`${out}/run.sh`, 0o755);
}
console.log(`built ${out}`);
