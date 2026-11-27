/**
 * Command-line actions that do their job and exit without starting PetPlay:
 *
 * - `--help`, `--version`
 * - `--logs`: where the logs are (the running or last run is `current.log`)
 * - `--reset`: settings, layouts and the screen-capture permission back to defaults
 *
 * - `--install`, `--uninstall`, `--update`, `--update-check`, `--update-channels`,
 *   `--update-rollback`: the installer (classes/installerCli.ts → classes/installer.ts)
 */
import { join } from "@std/path";
import { checkoutRoot, configDir, logsDir, tempDir } from "./appPaths.ts";
import { describeBuild, getBuildInfo, INSTALLER_PROTOCOL } from "./buildInfo.ts";

/** Runs a command-line action; `null` when the arguments ask for none (start PetPlay). */
export async function runCliCommand(args: readonly string[]): Promise<number | null> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  if (args.includes("--version")) {
    // `--json` is what the updater runs on a downloaded build to prove it starts.
    // `installer` is the --json installer protocol classes/installerClient.ts checks before it
    // runs this build for an install, update or rollback.
    console.log(
      args.includes("--json")
        ? JSON.stringify({ ...getBuildInfo(), installer: INSTALLER_PROTOCOL })
        : describeBuild(),
    );
    return 0;
  }
  if (args.includes("--logs")) {
    console.log(logsDir());
    console.log(`(this or the last run: ${join(logsDir(), "current.log")})`);
    return 0;
  }
  if (args.includes("--reset")) return await reset(args.includes("--yes"));
  if (args.includes("--test")) {
    const { runSelfTest } = await import("./selfTest.ts");
    return await runSelfTest(args);
  }
  if (
    args.some((a) =>
      a === "--install" || a === "--uninstall" || a === "--update" || a.startsWith("--update-") ||
      a.startsWith("--install-file=")
    )
  ) {
    const { runInstallerCli } = await import("./installerCli.ts");
    return await runInstallerCli(args);
  }
  return null;
}

const HELP = `PetPlay: desktop, keyboard and spatial UI overlay for SteamVR

Run with no arguments to start PetPlay.

  --version     print the version and exit
  --test        run built-in self-test (boot, WebXR, OpenVR, renderer, capture) and exit
  --logs        print where the logs are and exit
  --reset       reset settings, layouts and the screen-capture permission, and exit
                (asks first; add --yes to skip the question)
  --update [--channel=C] [--yes]
                update to the newest build on the channel (default: the one this build
                came from; "stable", or owner/repo#branch for a branch build)
  --update-check [--channel=C]
                print whether an update is available and exit
  --update-channels
                list the channels with a build for this platform
  --update-rollback
                put back the build the last update replaced
                (all --update commands take --json for one JSON object per line)
  --install-file=PATH [--sha256=HEX]
                install that PetPlay executable (a local build) in place of this one
  --install     install this PetPlay and start it with SteamVR
  --uninstall   remove the installed PetPlay and its SteamVR entry
  --help        this text`;

/** What `--reset` removes: everything PetPlay saved, except logs and an installed copy. */
function resetTargets(): string[] {
  const targets = [configDir()];
  // A checkout's tmp/ belongs to its dev tools too; only a release's scratch is PetPlay's alone.
  if (checkoutRoot() == null) targets.push(tempDir());
  return targets.filter(exists);
}

async function reset(confirmed: boolean): Promise<number> {
  const targets = resetTargets();
  if (targets.length === 0) {
    console.log("Nothing to reset: PetPlay has no saved settings.");
    return 0;
  }
  console.log(
    "This removes PetPlay's saved settings, window layouts and screen-capture permission:",
  );
  for (const target of targets) console.log(`  ${target}`);
  console.log(
    "Logs and an installed PetPlay are kept. Close PetPlay first, or it saves them again.",
  );
  if (!confirmed) {
    if (!Deno.stdin.isTerminal()) {
      console.log("Not reset: run with --reset --yes to confirm without a terminal.");
      return 1;
    }
    if (!await ask("Reset PetPlay? [y/N] ")) {
      console.log("Not reset.");
      return 1;
    }
  }
  for (const target of targets) Deno.removeSync(target, { recursive: true });
  console.log("PetPlay is reset to its defaults.");
  return 0;
}

/** Reads a yes/no answer from the terminal; anything but y/yes is no unless `fallback`. */
export async function ask(question: string, fallback = false): Promise<boolean> {
  await Deno.stdout.write(new TextEncoder().encode(question));
  const buffer = new Uint8Array(256);
  const read = await Deno.stdin.read(buffer);
  if (read == null) return fallback;
  const answer = new TextDecoder().decode(buffer.subarray(0, read)).trim().toLowerCase();
  if (answer === "") return fallback;
  return answer === "y" || answer === "yes";
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}
