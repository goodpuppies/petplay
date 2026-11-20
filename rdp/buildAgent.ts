/**
 * Builds the household agent (`rdp/agent.ts`) for a machine without a checkout, into
 * `dist/agent/`: one compiled `petplay-agent`, the helpers it runs, and `run.sh`, which points
 * the agent at them and at `.secret` beside it.
 *
 *   dist/agent/petplay-agent      the agent (deno compile)
 *   dist/agent/petplay-media      encoder + iroh link (cargo build --release --features iroh)
 *   dist/agent/screen-streamer    capture and input helper
 *   dist/agent/run.sh             ./run.sh [agent flags]; put the household secret in .secret
 *
 * `deno task rdp:agent:build`. Copy the directory over, add `.secret`, and run `run.sh`.
 */
import { fromFileUrl } from "@std/path";

const root = fromFileUrl(new URL("../", import.meta.url));
const out = `${root}dist/agent`;
const media = `${root}submodules/petplay_mediatransport/target/agent/release/petplay-media`;
const streamer = `${root}submodules/screen-streamer/target/release/screen-streamer`;

async function run(command: string, args: string[], cwd = root): Promise<void> {
  const { code } = await new Deno.Command(command, { args, cwd, stdout: "inherit", stderr: "inherit" })
    .output();
  if (code !== 0) Deno.exit(code);
}

await Deno.mkdir(out, { recursive: true });
// The encoder and the link in one binary, built apart from the release build PetPlay uses.
await run("cargo", ["build", "--release", "--features", "iroh", "--target-dir", "target/agent"], `${root}submodules/petplay_mediatransport`);
await run("cargo", ["build", "--release"], `${root}submodules/screen-streamer`);
await run(Deno.execPath(), [
  "compile",
  "-A",
  "--no-check",
  // Actors are workers spawned by URL; their modules must be embedded.
  "--include",
  "./rdp/desktopSource.ts",
  "--include",
  "./rdp/desktopInput.ts",
  "-o",
  `${out}/petplay-agent`,
  "./rdp/agent.ts",
]);
await Deno.copyFile(media, `${out}/petplay-media`);
await Deno.copyFile(streamer, `${out}/screen-streamer`);
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
console.log(`built ${out}`);
