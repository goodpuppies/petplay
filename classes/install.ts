/**
 * The installed release's layout and state: where the installed copy, its record (`install.json`),
 * the kept previous build and the SteamVR manifest/launcher live, and the atomic swap that puts a
 * new executable in place. Every operation that changes the install (install, update, rollback,
 * uninstall) is classes/installer.ts, the one installer backend behind the CLI, the Settings
 * overlay and the start-up "replace the installed copy?" prompt.
 *
 * A source checkout cannot install itself (its executable is Deno); `deno task steamvr:register`
 * registers a checkout instead. Both use the same app key, so each replaces the other.
 */
import { basename, dirname, join } from "@std/path";
import { installDir, installedExecutablePath, stateDir, steamVrAppDir } from "./appPaths.ts";
import { type BuildInfo, getBuildInfo, sameBuild } from "./buildInfo.ts";
import {
  buildSteamVrLauncher,
  buildSteamVrManifest,
  STEAMVR_APP_KEY,
  STEAMVR_IMAGE_FILE,
  STEAMVR_LAUNCHER_FILE,
  STEAMVR_MANIFEST_FILE,
} from "./steamVrManifest.ts";

export const INSTALL_RECORD = "install.json";
const windows = Deno.build.os === "windows";

/** The SteamVR app key; tests set `PETPLAY_STEAMVR_APP_KEY` to stay clear of a real install. */
export function steamVrAppKey(): string {
  return Deno.env.get("PETPLAY_STEAMVR_APP_KEY") || STEAMVR_APP_KEY;
}

export type InstallRecord = Partial<BuildInfo> & { installedAt?: string; from?: string };

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

export const IN_TERMINAL_ENV = "PETPLAY_UPDATE_TERMINAL";

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
export function openInTerminal(args: readonly string[]): boolean {
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

/** Where the build an update replaced is kept, for rollback and as delta-update source. */
export function previousExecutablePath(target: string): string {
  return windows ? target.replace(/\.exe$/i, "") + ".previous.exe" : `${target}.previous`;
}

/**
 * Moves `incoming` (in the same directory) over `target` atomically, keeping the old target as
 * {@link previousExecutablePath}. Linux keeps it as a hard link (no copy; the running process
 * keeps its inode either way). Windows cannot replace a running executable, only rename it, so
 * the old one is renamed aside first.
 * @returns the kept previous path, or `null` when nothing was replaced.
 */
export function swapInExecutable(incoming: string, target: string): string | null {
  const previous = previousExecutablePath(target);
  const hadTarget = exists(target);
  if (!windows) {
    if (hadTarget) {
      try {
        Deno.removeSync(previous);
      } catch {
        // None kept yet.
      }
      try {
        Deno.linkSync(target, previous);
      } catch {
        // A filesystem without hard links: no rollback copy, the update still goes ahead.
      }
    }
    Deno.renameSync(incoming, target);
    return hadTarget && exists(previous) ? previous : null;
  }
  // Leftovers of earlier updates whose process was still running then.
  for (const entry of safeReadDir(dirname(target))) {
    if (entry.endsWith(".stale") || entry === `${basename(target)}.old`) {
      try {
        Deno.removeSync(join(dirname(target), entry));
      } catch {
        // Still running.
      }
    }
  }
  try {
    Deno.removeSync(previous);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      // The previous build is running (after a rollback): move it out of the way instead.
      Deno.renameSync(previous, `${previous}.${Date.now()}.stale`);
    }
  }
  if (hadTarget) Deno.renameSync(target, previous);
  Deno.renameSync(incoming, target);
  return hadTarget ? previous : null;
}

function safeReadDir(dir: string): string[] {
  try {
    return [...Deno.readDirSync(dir)].map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** The manifest, image and (Linux) launcher SteamVR runs. @returns the manifest path. */
export function writeSteamVrFiles(executable: string): string {
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

export function readRecord(): InstallRecord | null {
  try {
    return JSON.parse(Deno.readTextFileSync(join(installDir(), INSTALL_RECORD)));
  } catch {
    return null;
  }
}

export function executableName(): string {
  return windows ? "petplay.exe" : "petplay";
}

export function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

export function samePath(a: string, b: string): boolean {
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
