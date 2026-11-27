/**
 * The one installer backend. Every change to the installed PetPlay goes through here, whoever
 * asks: the CLI (`--install`, `--uninstall`, `--update`, `--update-rollback`; classes/installerCli.ts),
 * the Settings overlay (through a `petplay … --json` child process, classes/installerClient.ts,
 * so ~500 MB of hashing never runs in a scene worker), and the start-up prompt a newer download
 * shows when an older build is installed ({@link offerUpdate}).
 *
 * Every operation:
 * - holds the install directory's lock, so two PetPlays, or the CLI and the overlay, never
 *   install at once;
 * - stages the new executable next to the target and only then swaps it in atomically, keeping
 *   the replaced build as `petplay.previous` (classes/install.ts `swapInExecutable`), so any of
 *   them can be rolled back;
 * - writes `install.json` from the build that was actually put in place;
 * - keeps the SteamVR registration pointing at the installed copy;
 * - reports the same progress events and the same result, so every front end shows the same.
 *
 * Layout (paths, state, SteamVR files) is classes/install.ts; finding and downloading builds is
 * classes/updater.ts.
 */
import { dirname, join } from "@std/path";
import { installDir, installedExecutablePath, steamVrAppDir } from "./appPaths.ts";
import { type BuildInfo, describeBuild, getBuildInfo } from "./buildInfo.ts";
import {
  executableName,
  exists,
  IN_TERMINAL_ENV,
  INSTALL_RECORD,
  installState,
  openInTerminal,
  previousExecutablePath,
  samePath,
  steamVrAppKey,
  swapInExecutable,
  writeSteamVrFiles,
} from "./install.ts";
import { STEAMVR_MANIFEST_FILE } from "./steamVrManifest.ts";
import {
  type BuildCandidate,
  downloadVerified,
  smokeTestExecutable,
  type UpdateProgress,
} from "./updater.ts";

export type InstallerAction = "install" | "update" | "rollback" | "uninstall" | "install-file";
export type InstallerProgress = UpdateProgress;

export type InstallerResult = {
  action: InstallerAction;
  /** The build now in place; `null` after uninstall. */
  installed: BuildInfo | null;
  targetPath: string;
  /** The build it replaced, kept for rollback. */
  previousPath: string | null;
  /** How the bytes arrived: chunks reused + fetched, a full download, or a local copy. */
  mode: "delta" | "full" | "copy" | "none";
  downloadedBytes: number;
  reusedBytes: number;
  /** One line per thing done, for a terminal or a toast. */
  notes: string[];
  /** The running PetPlay is not the build now installed: RESTART (classes/restart.ts) runs it. */
  restartNeeded: boolean;
};

export type InstallerOptions = {
  onProgress?: (progress: InstallerProgress) => void;
  /** Install somewhere else than the installed copy (tests). */
  targetPath?: string;
  /** Leave SteamVR alone (tests; the target is not the installed copy anyway). */
  register?: boolean;
  /** Do not run the staged executable before swapping it in (tests with fake binaries). */
  skipSmokeTest?: boolean;
  fetchImpl?: typeof fetch;
};

const STALE_LOCK_MS = 60 * 60 * 1000;
const LOCK_FILE = ".petplay-update.lock";

/** Where an update or rollback goes: the installed copy when there is one, else this executable. */
export function installerTarget(): string {
  return installState().installed ? installedExecutablePath() : Deno.execPath();
}

/** An earlier operation kept the build it replaced. */
export function hasPreviousBuild(target = installerTarget()): boolean {
  try {
    return Deno.statSync(previousExecutablePath(target)).isFile;
  } catch {
    return false;
  }
}

function requireRelease(options: InstallerOptions): void {
  if (!Deno.build.standalone && options.targetPath == null) {
    throw new Error(
      "Only a release build installs or updates itself. In a source checkout, use git pull and " +
        "deno task steamvr:register.",
    );
  }
}

function stagingPath(target: string): string {
  return Deno.build.os === "windows"
    ? target.replace(/\.exe$/i, "") + ".incoming.exe"
    : `${target}.incoming`;
}

/**
 * Runs `stage(incoming)` to produce the new executable, checks that it starts, swaps it in
 * (keeping the old one) and records it. The common core of install, update and rollback.
 */
async function replaceWith(
  target: string,
  options: InstallerOptions,
  stage: (incoming: string) => Promise<BuildInfo | null>,
  from: string,
): Promise<{ installed: BuildInfo; previousPath: string | null }> {
  const progress = options.onProgress ?? (() => {});
  const incoming = stagingPath(target);
  try {
    const known = await stage(incoming);
    if (Deno.build.os !== "windows") Deno.chmodSync(incoming, 0o755);
    progress({ phase: "testing", receivedBytes: 0, totalBytes: null });
    const installed = known ??
      (options.skipSmokeTest
        ? { version: "unknown", commit: null, built: null, mode: "production" }
        : await smokeTestExecutable(incoming));
    progress({ phase: "installing", receivedBytes: 0, totalBytes: null });
    const previousPath = swapInExecutable(incoming, target);
    writeInstallRecord(target, installed, from);
    return { installed, previousPath };
  } finally {
    try {
      Deno.removeSync(incoming);
    } catch {
      // Moved into place, or never written.
    }
  }
}

/**
 * Installs this executable as the installed copy (replacing, and keeping, an older one) and
 * registers it with SteamVR to start with it. Run again, it repairs a moved or missing
 * registration.
 */
export async function install(options: InstallerOptions = {}): Promise<InstallerResult> {
  requireRelease(options);
  const target = options.targetPath ?? installedExecutablePath();
  const source = Deno.execPath();
  const progress = options.onProgress ?? (() => {});
  const notes: string[] = [];
  return await withInstallLock(dirname(target), async () => {
    let previousPath: string | null = null;
    let mode: InstallerResult["mode"] = "none";
    const build = getBuildInfo();
    if (!samePath(source, target)) {
      mode = "copy";
      ({ previousPath } = await replaceWith(target, options, async (incoming) => {
        const total = Deno.statSync(source).size;
        progress({ phase: "copying", receivedBytes: 0, totalBytes: total });
        await Deno.copyFile(source, incoming);
        progress({ phase: "copying", receivedBytes: total, totalBytes: total });
        // It is this very build, already running: no need to start it to know it works.
        return { ...build };
      }, source));
      notes.push(`Copied PetPlay to ${target}`);
    } else {
      writeInstallRecord(target, build, source);
    }
    if (options.register !== false) notes.push(...await registerWithSteamVr(target, progress));
    notes.push(`${describeBuild(build)} starts with SteamVR from now on.`);
    return {
      action: "install",
      installed: build,
      targetPath: target,
      previousPath,
      mode,
      downloadedBytes: 0,
      reusedBytes: 0,
      notes,
      restartNeeded: false,
    };
  });
}

/** Downloads `candidate` (delta when possible), checks it, and installs it in place. */
export async function update(
  candidate: BuildCandidate,
  options: InstallerOptions = {},
): Promise<InstallerResult> {
  requireRelease(options);
  const target = options.targetPath ?? installerTarget();
  const progress = options.onProgress ?? (() => {});
  return await withInstallLock(dirname(target), async () => {
    let download = { mode: "full" as "delta" | "full", downloadedBytes: 0, reusedBytes: 0 };
    const { installed, previousPath } = await replaceWith(target, options, async (incoming) => {
      download = await downloadVerified(candidate, incoming, {
        localSources: [target, previousExecutablePath(target), Deno.execPath()],
        onProgress: progress,
        fetchImpl: options.fetchImpl,
      });
      return options.skipSmokeTest
        ? {
          version: candidate.version,
          commit: candidate.commit,
          built: candidate.publishedAt,
          mode: "production",
          channel: candidate.channel,
        }
        : null;
    }, candidate.releaseUrl);
    installed.channel ??= candidate.channel;
    const notes = [
      `Installed ${installed.version} at ${target} (${
        download.mode === "delta"
          ? `fetched ${mb(download.downloadedBytes)}, reused ${mb(download.reusedBytes)}`
          : `downloaded ${mb(download.downloadedBytes)}`
      })`,
    ];
    if (options.register !== false && target === installedExecutablePath()) {
      notes.push(...await refreshSteamVrRegistration(target, progress));
    }
    return {
      action: "update",
      installed,
      targetPath: target,
      previousPath,
      ...download,
      notes,
      restartNeeded: true,
    };
  });
}

/**
 * Installs an executable file that is already on disk (a local `deno task build`, or a build a
 * trusted peer just sent, classes/peerBuild.ts) the same way an update is installed: checked
 * against `expectedSha256` when given, started once, swapped in with the old build kept.
 * A file in the target's own directory is moved into place, anything else is copied.
 */
export async function installFile(
  path: string,
  options: InstallerOptions & { expectedSha256?: string; from?: string } = {},
): Promise<InstallerResult> {
  requireRelease(options);
  const target = options.targetPath ?? installerTarget();
  const progress = options.onProgress ?? (() => {});
  if (!exists(path)) throw new Error(`No such file: ${path}`);
  return await withInstallLock(dirname(target), async () => {
    if (options.expectedSha256) {
      progress({ phase: "verifying", receivedBytes: 0, totalBytes: null });
      const { sha256File } = await import("./updater.ts");
      const actual = await sha256File(path);
      if (actual !== options.expectedSha256.toLowerCase()) {
        throw new Error(`${path} is not the expected build (SHA-256 ${actual.slice(0, 12)})`);
      }
    }
    const size = Deno.statSync(path).size;
    const { installed, previousPath } = await replaceWith(target, options, async (incoming) => {
      progress({ phase: "copying", receivedBytes: 0, totalBytes: size });
      if (dirname(path) === dirname(target)) Deno.renameSync(path, incoming);
      else await Deno.copyFile(path, incoming);
      return null;
    }, options.from ?? path);
    const notes = [`Installed ${installed.version} at ${target} (from ${options.from ?? path})`];
    if (options.register !== false && target === installedExecutablePath()) {
      notes.push(...await refreshSteamVrRegistration(target, progress));
    }
    return {
      action: "install-file",
      installed,
      targetPath: target,
      previousPath,
      mode: "copy",
      downloadedBytes: 0,
      reusedBytes: 0,
      notes,
      restartNeeded: true,
    };
  });
}

/** Puts the kept previous build back (and keeps the current one as the new previous). */
export async function rollback(options: InstallerOptions = {}): Promise<InstallerResult> {
  requireRelease(options);
  const target = options.targetPath ?? installerTarget();
  const previous = previousExecutablePath(target);
  if (!exists(previous)) throw new Error(`No previous build kept at ${previous}`);
  const progress = options.onProgress ?? (() => {});
  return await withInstallLock(dirname(target), async () => {
    const { installed, previousPath } = await replaceWith(target, options, async (incoming) => {
      const total = Deno.statSync(previous).size;
      progress({ phase: "copying", receivedBytes: 0, totalBytes: total });
      await Deno.copyFile(previous, incoming);
      return null;
    }, previous);
    const notes = [`Rolled back to ${installed.version} at ${target}`];
    if (options.register !== false && target === installedExecutablePath()) {
      notes.push(...await refreshSteamVrRegistration(target, progress));
    }
    return {
      action: "rollback",
      installed,
      targetPath: target,
      previousPath,
      mode: "copy",
      downloadedBytes: 0,
      reusedBytes: 0,
      notes,
      restartNeeded: true,
    };
  });
}

/** Removes the installed copy, its kept previous build and its SteamVR entry. Settings and logs stay. */
export async function uninstall(options: InstallerOptions = {}): Promise<InstallerResult> {
  const notes: string[] = [];
  const progress = options.onProgress ?? (() => {});
  const target = options.targetPath ?? installedExecutablePath();
  const directory = dirname(target);
  await withInstallLock(directory, async () => {
    progress({ phase: "removing", receivedBytes: 0, totalBytes: null });
    const manifest = join(steamVrAppDir(), STEAMVR_MANIFEST_FILE);
    if (options.register !== false && exists(manifest)) {
      const { unregisterSteamVrApp } = await import("./steamVrRegistration.ts");
      notes.push(`SteamVR: ${unregisterSteamVrApp(manifest, steamVrAppKey())}`);
      Deno.removeSync(steamVrAppDir(), { recursive: true });
    }
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
    for (
      const leftover of [
        INSTALL_RECORD,
        `${executableName()}.old`,
        previousExecutablePath(executableName()),
      ]
    ) {
      try {
        Deno.removeSync(join(directory, leftover));
      } catch {
        // Not there.
      }
    }
  });
  try {
    Deno.removeSync(directory);
  } catch {
    // Not empty (the running copy on Windows), or never created.
  }
  notes.push(
    notes.length === 0
      ? "PetPlay was not installed."
      : "PetPlay is uninstalled. Settings and logs are kept.",
  );
  return {
    action: "uninstall",
    installed: null,
    targetPath: target,
    previousPath: null,
    mode: "none",
    downloadedBytes: 0,
    reusedBytes: 0,
    notes,
    restartNeeded: false,
  };
}

/**
 * After an update or rollback the new build is already in place; a SteamVR registration that
 * cannot be refreshed (SteamVR's config missing or locked) is a warning, not a failed update.
 */
async function refreshSteamVrRegistration(
  target: string,
  progress: (progress: InstallerProgress) => void,
): Promise<string[]> {
  try {
    return await registerWithSteamVr(target, progress);
  } catch (error) {
    return [
      `SteamVR registration not refreshed: ${error instanceof Error ? error.message : error}`,
    ];
  }
}

async function registerWithSteamVr(
  target: string,
  progress: (progress: InstallerProgress) => void,
): Promise<string[]> {
  progress({ phase: "registering", receivedBytes: 0, totalBytes: null });
  const manifest = writeSteamVrFiles(target);
  const { registerSteamVrApp } = await import("./steamVrRegistration.ts");
  return [`SteamVR: ${registerSteamVrApp(manifest, steamVrAppKey(), true)}`];
}

function writeInstallRecord(target: string, build: BuildInfo, from: string): void {
  if (target !== installedExecutablePath()) return;
  try {
    Deno.writeTextFileSync(
      join(installDir(), INSTALL_RECORD),
      JSON.stringify({ ...build, installedAt: new Date().toISOString(), from }, null, 2) + "\n",
    );
  } catch {
    // Non-fatal: the binary is in place and reports its own build.
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
}

// ---------------------------------------------------------------------------------------------
// The lock: one operation at a time per install directory.

export async function withInstallLock<T>(directory: string, run: () => Promise<T>): Promise<T> {
  Deno.mkdirSync(directory, { recursive: true });
  const path = join(directory, LOCK_FILE);
  let held = false;
  for (let attempt = 0; attempt < 2 && !held; attempt++) {
    try {
      const file = Deno.openSync(path, { write: true, createNew: true });
      file.writeSync(new TextEncoder().encode(JSON.stringify({ pid: Deno.pid, at: Date.now() })));
      file.close();
      held = true;
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      if (!lockIsStale(path)) break;
      try {
        Deno.removeSync(path);
      } catch {
        // Someone else took it over.
      }
    }
  }
  if (!held) throw new Error("Another PetPlay install or update is already running.");
  try {
    return await run();
  } finally {
    try {
      Deno.removeSync(path);
    } catch {
      // Already gone (uninstall removed the directory's contents).
    }
  }
}

function lockIsStale(path: string): boolean {
  try {
    const { pid, at } = JSON.parse(Deno.readTextFileSync(path)) as { pid?: number; at?: number };
    if (typeof at !== "number" || Date.now() - at > STALE_LOCK_MS) return true;
    if (Deno.build.os === "linux" && typeof pid === "number") return !exists(`/proc/${pid}`);
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Start-up: a newer download finds an older build installed.

/**
 * When a release starts and a *different* build is installed, ask whether to replace it, instead
 * of starting: one way to update is to download a new PetPlay and run it. Asks in a terminal; a
 * release started without one (double-clicked) reopens itself in one. Replacing is
 * {@link install}, like everywhere else.
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
      const result = await install();
      for (const note of result.notes) console.log(note);
      console.log("You can delete this download.");
    } catch (error) {
      console.error(`Update failed: ${error instanceof Error ? error.message : error}`);
      code = 1;
    }
  } else {
    console.log("The installed PetPlay is unchanged.");
  }
  // A terminal opened for this, or a Windows console, closes the moment PetPlay exits.
  if (Deno.env.get(IN_TERMINAL_ENV) != null || Deno.build.os === "windows") {
    await ask("Press Enter to close.");
  }
  return code;
}
