/**
 * Installing a release: PetPlay copies itself to a fixed per-user place (classes/appPaths.ts) and
 * registers that copy with SteamVR as a startup overlay app, so SteamVR starts it from then on and
 * the download can be deleted. From the wrist menu (Settings → APP) or `petplay --install`.
 *
 * Updating is running a newer download: a release that finds a different build installed asks,
 * in a terminal, whether to replace it, and does not start (see {@link offerUpdate}).
 *
 * Uninstalling removes the installed copy and its SteamVR entry. Settings, layouts and logs stay;
 * `petplay --reset` clears them.
 *
 * A source checkout cannot install itself (its executable is Deno); `deno task steamvr:register`
 * registers a checkout instead. Both use the same app key, so each replaces the other.
 */
import { join } from "@std/path";
import { installDir, installedExecutablePath, stateDir, steamVrAppDir } from "./appPaths.ts";
import { type BuildInfo, describeBuild, getBuildInfo, sameBuild } from "./buildInfo.ts";
import {
  buildSteamVrLauncher,
  buildSteamVrManifest,
  STEAMVR_APP_KEY,
  STEAMVR_IMAGE_FILE,
  STEAMVR_LAUNCHER_FILE,
  STEAMVR_MANIFEST_FILE,
} from "./steamVrManifest.ts";

const INSTALL_RECORD = "install.json";
const windows = Deno.build.os === "windows";

/** The SteamVR app key; tests set `PETPLAY_STEAMVR_APP_KEY` to stay clear of a real install. */
export function steamVrAppKey(): string {
  return Deno.env.get("PETPLAY_STEAMVR_APP_KEY") || STEAMVR_APP_KEY;
}

type InstallRecord = Partial<BuildInfo> & { installedAt?: string; from?: string };

export type InstallState = {
  /** A release build: only those can install themselves. */
  canInstall: boolean;
  installed: boolean;
  installedPath: string;
  installedBuild: InstallRecord | null;
  thisBuild: BuildInfo;
  /** This process is the installed copy. */
  runningInstalled: boolean;
  /** The installed copy is this same build. */
  upToDate: boolean;
};

export function installState(): InstallState {
  const installedPath = installedExecutablePath();
  const thisBuild = getBuildInfo();
  const installed = exists(installedPath);
  const installedBuild = installed ? readRecord() : null;
  return {
    canInstall: Deno.build.standalone,
    installed,
    installedPath,
    installedBuild,
    thisBuild,
    runningInstalled: installed && samePath(Deno.execPath(), installedPath),
    upToDate: installedBuild != null && sameBuild(installedBuild, thisBuild),
  };
}

/**
 * Copies this executable into the install directory (replacing an older copy), and registers it
 * with SteamVR with auto-launch on. Running it again repairs a moved or missing registration.
 * @returns what was done, one line each.
 */
export async function installSelf(): Promise<string[]> {
  if (!Deno.build.standalone) {
    throw new Error(
      "Only a release build installs itself. In a source checkout, use deno task steamvr:register.",
    );
  }
  const notes: string[] = [];
  const target = installedExecutablePath();
  Deno.mkdirSync(installDir(), { recursive: true });
  if (!samePath(Deno.execPath(), target)) {
    replaceExecutable(Deno.execPath(), target);
    notes.push(`Copied PetPlay to ${target}`);
  }
  const record: InstallRecord = {
    ...getBuildInfo(),
    installedAt: new Date().toISOString(),
    from: Deno.execPath(),
  };
  Deno.writeTextFileSync(
    join(installDir(), INSTALL_RECORD),
    JSON.stringify(record, null, 2) + "\n",
  );

  const manifest = writeSteamVrFiles(target);
  const { registerSteamVrApp } = await import("./steamVrRegistration.ts");
  notes.push(`SteamVR: ${registerSteamVrApp(manifest, steamVrAppKey(), true)}`);
  notes.push(`${describeBuild()} starts with SteamVR from now on.`);
  return notes;
}

/**
 * Removes PetPlay's SteamVR entry and the installed copy. Settings, layouts and logs stay.
 * @returns what was done, one line each.
 */
export async function uninstallSelf(): Promise<string[]> {
  const notes: string[] = [];
  const manifest = join(steamVrAppDir(), STEAMVR_MANIFEST_FILE);
  if (exists(manifest)) {
    const { unregisterSteamVrApp } = await import("./steamVrRegistration.ts");
    notes.push(`SteamVR: ${unregisterSteamVrApp(manifest, steamVrAppKey())}`);
    Deno.removeSync(steamVrAppDir(), { recursive: true });
  }
  const target = installedExecutablePath();
  if (exists(target)) {
    try {
      Deno.removeSync(target);
      notes.push(`Removed ${target}`);
    } catch (error) {
      // Windows keeps a running executable's file; Linux never refuses.
      notes.push(
        `Could not remove ${target} while it runs (${error}); delete it after PetPlay exits.`,
      );
    }
  }
  for (const leftover of [INSTALL_RECORD, `${executableName()}.old`]) {
    try {
      Deno.removeSync(join(installDir(), leftover));
    } catch {
      // Not there.
    }
  }
  try {
    Deno.removeSync(installDir());
  } catch {
    // Not empty (the running copy on Windows), or never created.
  }
  notes.push(
    notes.length === 0
      ? "PetPlay was not installed."
      : "PetPlay is uninstalled. Settings and logs are kept.",
  );
  return notes;
}

/**
 * When a release starts and a *different* build is installed, ask whether to replace it, instead
 * of starting: the expected way to update is to download a new PetPlay and run it. Asks in a
 * terminal; a release started without one (double-clicked) reopens itself in one.
 * @returns an exit code when it handled the start, `null` to start PetPlay normally.
 */
export async function offerUpdate(args: readonly string[]): Promise<number | null> {
  if (!Deno.build.standalone || args.includes("--no-update-check")) return null;
  // Only the process the user started: PetPlay's own children re-run this entry point.
  if (Deno.env.get("PETPLAY_LOG_PARENT_PID") != null) return null;
  const state = installState();
  if (!state.installed || state.runningInstalled || state.upToDate) return null;

  if (!Deno.stdin.isTerminal()) {
    if (Deno.env.get(IN_TERMINAL_ENV) == null && openInTerminal(args)) return 0;
    console.error(
      `A different PetPlay is installed at ${state.installedPath}. Run this download from a ` +
        "terminal to update it, or with --no-update-check to run it without installing.",
    );
    return 1;
  }

  const { ask } = await import("./cli.ts");
  const installed = state.installedBuild?.version ?? "an unknown version";
  console.log(`PetPlay ${installed} is installed (${state.installedPath}).`);
  console.log(`This download is ${describeBuild(state.thisBuild)}.`);
  let code = 0;
  if (await ask(`Replace the installed PetPlay with this one? [Y/n] `, true)) {
    try {
      for (const note of await installSelf()) console.log(note);
      console.log("You can delete this download.");
    } catch (error) {
      console.error(`Update failed: ${error instanceof Error ? error.message : error}`);
      code = 1;
    }
  } else {
    console.log("The installed PetPlay is unchanged.");
  }
  // A terminal opened for this, or a Windows console, closes the moment PetPlay exits.
  if (Deno.env.get(IN_TERMINAL_ENV) != null || windows) await ask("Press Enter to close.");
  return code;
}

const IN_TERMINAL_ENV = "PETPLAY_UPDATE_TERMINAL";

/** Terminal emulators to ask in, with the argument that precedes the command to run. */
const TERMINALS: readonly (readonly [string, ...string[]])[] = [
  ["x-terminal-emulator", "-e"],
  ["konsole", "-e"],
  ["gnome-terminal", "--"],
  ["kgx", "--"],
  ["xfce4-terminal", "-x"],
  ["kitty"],
  ["alacritty", "-e"],
  ["foot"],
  ["wezterm", "start", "--"],
  ["xterm", "-e"],
];

/** Reopens this PetPlay in a terminal emulator (Linux); false if none is found. */
function openInTerminal(args: readonly string[]): boolean {
  if (Deno.build.os !== "linux") return false;
  const preferred = Deno.env.get("TERMINAL");
  const candidates = preferred ? [[preferred, "-e"] as const, ...TERMINALS] : TERMINALS;
  for (const [program, ...prefix] of candidates) {
    const path = findOnPath(program);
    if (path == null) continue;
    try {
      const child = new Deno.Command(path, {
        args: [...prefix, Deno.execPath(), ...args],
        env: { [IN_TERMINAL_ENV]: "1" },
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      child.unref();
      return true;
    } catch {
      // Try the next one.
    }
  }
  return false;
}

function findOnPath(program: string): string | null {
  for (const directory of (Deno.env.get("PATH") ?? "").split(":")) {
    if (directory === "") continue;
    const path = join(directory, program);
    try {
      if (Deno.statSync(path).isFile) return path;
    } catch {
      // Not here.
    }
  }
  return null;
}

/**
 * Puts `source` at `target` without ever leaving a half-written executable. On Windows a running
 * executable cannot be replaced, only renamed, so the old one is moved aside first.
 */
function replaceExecutable(source: string, target: string): void {
  const incoming = `${target}.new`;
  Deno.copyFileSync(source, incoming);
  if (!windows) {
    Deno.chmodSync(incoming, 0o755);
    Deno.renameSync(incoming, target);
    return;
  }
  const aside = `${target}.old`;
  try {
    Deno.removeSync(aside);
  } catch {
    // None, or still running from an earlier update; renaming over it below fails then too.
  }
  try {
    Deno.renameSync(target, aside);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  Deno.renameSync(incoming, target);
}

/** The manifest, image and (Linux) launcher SteamVR runs. @returns the manifest path. */
function writeSteamVrFiles(executable: string): string {
  const dir = steamVrAppDir();
  Deno.mkdirSync(dir, { recursive: true });
  let binaryPath: string;
  if (windows) {
    binaryPath = executable;
  } else {
    // SteamVR starts overlay apps inside its runtime container; the launcher leaves it.
    const launcher = join(dir, STEAMVR_LAUNCHER_FILE);
    writeFile(
      launcher,
      buildSteamVrLauncher({ workingDirectory: installDir(), command: [executable] }),
    );
    Deno.chmodSync(launcher, 0o755);
    binaryPath = STEAMVR_LAUNCHER_FILE;
  }
  const manifest = join(dir, STEAMVR_MANIFEST_FILE);
  writeFile(
    manifest,
    buildSteamVrManifest({ appKey: steamVrAppKey(), binaryPath, imagePath: STEAMVR_IMAGE_FILE }),
  );
  Deno.writeFileSync(
    join(dir, STEAMVR_IMAGE_FILE),
    Deno.readFileSync(new URL("../resources/PetPlay.png", import.meta.url)),
  );
  return manifest;
}

function writeFile(path: string, text: string): void {
  const temp = `${path}.petplay-tmp`;
  Deno.writeTextFileSync(temp, text);
  Deno.renameSync(temp, path);
}

function readRecord(): InstallRecord | null {
  try {
    return JSON.parse(Deno.readTextFileSync(join(installDir(), INSTALL_RECORD)));
  } catch {
    return null;
  }
}

function executableName(): string {
  return windows ? "petplay.exe" : "petplay";
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  try {
    return Deno.realPathSync(a) === Deno.realPathSync(b);
  } catch {
    return false;
  }
}

/** Where SteamVR-launched runs record their start (the Linux launcher writes it). */
export function steamVrLaunchLogPath(): string {
  return join(stateDir(), "steamvr-launch.log");
}
