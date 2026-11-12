/**
 * Where PetPlay keeps its files, per user and per OS. Nothing goes next to the executable or in
 * the current directory: a release is usually run from the downloads folder and may be deleted.
 *
 * | | Linux | Windows |
 * |---|---|---|
 * | config: settings, layouts, capture permission | `$XDG_CONFIG_HOME/petplay` | `%APPDATA%\PetPlay` |
 * | state: logs, SteamVR launch log | `$XDG_STATE_HOME/petplay` | `%LOCALAPPDATA%\PetPlay` |
 * | data: SteamVR manifest and launcher | `$XDG_DATA_HOME/petplay` | `%LOCALAPPDATA%\PetPlay` |
 * | temp: per-run scratch, extracted helpers | `$XDG_CACHE_HOME/petplay/tmp` | `%LOCALAPPDATA%\PetPlay\tmp` |
 * | install: the installed executable | `$XDG_DATA_HOME/petplay/bin` | `%LOCALAPPDATA%\Programs\PetPlay` |
 *
 * A source checkout keeps its scratch in the repo's `tmp/` (its tools expect it there); everything
 * else is the same for a checkout and a release.
 */
import { fromFileUrl, join } from "@std/path";

const windows = Deno.build.os === "windows";

function env(name: string): string | undefined {
  const value = Deno.env.get(name);
  return value == null || value === "" ? undefined : value;
}

function home(): string {
  return env("HOME") ?? env("USERPROFILE") ?? Deno.cwd();
}

function localAppData(): string {
  return env("LOCALAPPDATA") ?? join(home(), "AppData", "Local");
}

/** Settings, layouts, the screen-capture permission token. */
export function configDir(): string {
  if (windows) return join(env("APPDATA") ?? join(home(), "AppData", "Roaming"), "PetPlay");
  return join(env("XDG_CONFIG_HOME") ?? join(home(), ".config"), "petplay");
}

/** Logs and other records of past runs. */
export function stateDir(): string {
  if (windows) return join(localAppData(), "PetPlay");
  return join(env("XDG_STATE_HOME") ?? join(home(), ".local", "state"), "petplay");
}

export function logsDir(): string {
  return join(stateDir(), "logs");
}

/** Files PetPlay installs for itself: the SteamVR manifest, launcher and image. */
export function dataDir(): string {
  if (windows) return join(localAppData(), "PetPlay");
  return join(env("XDG_DATA_HOME") ?? join(home(), ".local", "share"), "petplay");
}

/** The SteamVR manifest, launcher and image (one registration: release install or checkout). */
export function steamVrAppDir(): string {
  return join(dataDir(), "steamvr");
}

/** Where the installed executable lives. */
export function installDir(): string {
  if (windows) return join(localAppData(), "Programs", "PetPlay");
  return join(dataDir(), "bin");
}

export function installedExecutablePath(): string {
  return join(installDir(), windows ? "petplay.exe" : "petplay");
}

/** The repository root of a source checkout; `null` in a compiled build. */
export function checkoutRoot(): string | null {
  return Deno.build.standalone ? null : fromFileUrl(new URL("../", import.meta.url));
}

/**
 * Scratch shared by PetPlay's processes: per-run directories, extracted helpers, overlay claims.
 * Safe to delete while PetPlay is not running.
 */
export function tempDir(): string {
  const checkout = checkoutRoot();
  if (checkout != null) return join(checkout, "tmp");
  if (windows) return join(localAppData(), "PetPlay", "tmp");
  return join(env("XDG_CACHE_HOME") ?? join(home(), ".cache"), "petplay", "tmp");
}

/**
 * Windows builds before these paths kept settings in `.config\petplay` under whatever directory
 * PetPlay was started from (usually Downloads). Moves them to {@link configDir} once.
 */
export function migrateLegacyWindowsConfig(): void {
  if (!windows) return;
  const legacy = join(Deno.cwd(), ".config", "petplay");
  const target = configDir();
  try {
    if (!Deno.statSync(legacy).isDirectory) return;
  } catch {
    return;
  }
  try {
    Deno.statSync(target);
    return; // Already has settings of its own; leave both alone.
  } catch {
    // Not there yet.
  }
  try {
    Deno.mkdirSync(join(target, ".."), { recursive: true });
    Deno.renameSync(legacy, target);
    console.log(`[petplay] moved settings from ${legacy} to ${target}`);
  } catch (error) {
    console.warn(`[petplay] could not move settings from ${legacy}: ${error}`);
  }
}
