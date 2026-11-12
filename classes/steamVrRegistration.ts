/**
 * Registering a `.vrmanifest` with SteamVR as a startup overlay app, and removing it: the I/O half
 * of classes/steamVrManifest.ts, shared by the release installer (classes/install.ts) and the
 * checkout tool (utils/steamvr-app.ts).
 *
 * - With SteamVR running, through the OpenVR API as a background client, which never starts
 *   SteamVR. This is the path the in-VR Install button always takes.
 * - With SteamVR stopped, on Linux, by editing SteamVR's `appconfig.json` and the app's
 *   `vrappconfig`. SteamVR owns those files while it runs and rewrites them on exit, so this path
 *   is never taken then. Windows has no such path yet: start SteamVR first.
 */
import { dirname, join } from "@std/path";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { stringToPointer } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { getOpenVrLibraryPath } from "./nativeLibraryPaths.ts";
import { DEFAULT_STEAMVR_PROCESS_NAMES, steamVrRunning } from "./steamVrProcess.ts";
import {
  appConfigListsManifest,
  appConfigWithManifest,
  appConfigWithoutManifest,
  vrAppConfigWithAutoLaunch,
} from "./steamVrManifest.ts";

function home(): string {
  const value = Deno.env.get("HOME")?.trim();
  if (!value) throw new Error("HOME is not set");
  return value;
}

/** Steam's config directory on Linux: native, the `~/.steam` link, or the Flatpak's. */
export function steamConfigDir(): string | null {
  if (Deno.build.os !== "linux") return null;
  const candidates = [
    join(home(), ".local", "share", "Steam"),
    join(home(), ".steam", "steam"),
    join(home(), ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam"),
  ];
  for (const root of candidates) {
    try {
      if (Deno.statSync(join(root, "config")).isDirectory) return join(root, "config");
    } catch {
      // Not this one.
    }
  }
  return null;
}

export function readText(path: string): string | null {
  try {
    return Deno.readTextFileSync(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

/** Writes beside the target and renames, so SteamVR never reads half a file. */
export function writeAtomic(path: string, text: string): void {
  Deno.mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.petplay-tmp`;
  Deno.writeTextFileSync(temp, text);
  Deno.renameSync(temp, path);
}

export function vrAppConfigPath(config: string, appKey: string): string {
  return join(config, "vrappconfig", `${appKey}.vrappconfig`);
}

/**
 * IVRApplications from a background-app client, or `null` when SteamVR is not running
 * (`VRApplication_Background` fails instead of starting it). The client is never shut down: the
 * caller exits soon after, which sidesteps vrclient's Linux shutdown race (see `OpenVrRuntime`).
 */
export function runningSteamVrApplications(): OpenVR.IVRApplications | null {
  // On Linux, look before connecting: no process means no SteamVR, without loading the runtime.
  if (Deno.build.os === "linux" && !steamVrRunning(DEFAULT_STEAMVR_PROCESS_NAMES)) return null;
  if (!OpenVR.isInitialized() && !OpenVR.initializeOpenVR(getOpenVrLibraryPath())) {
    throw new Error("could not load the OpenVR library");
  }
  const error = P.Int32P<OpenVR.InitError>();
  OpenVR.VR_InitInternal(error, OpenVR.ApplicationType.VRApplication_Background);
  const initError = new Deno.UnsafePointerView(error).getInt32();
  if (initError === OpenVR.InitError.VRInitError_Init_NoServerForBackgroundApp) return null;
  if (initError !== OpenVR.InitError.VRInitError_None) {
    throw new Error(`OpenVR init failed: ${OpenVR.InitError[initError]}`);
  }
  const pointer = OpenVR.VR_GetGenericInterface(
    stringToPointer(OpenVR.IVRApplications_Version),
    error,
  );
  if (pointer == null) throw new Error("SteamVR has no IVRApplications interface");
  return new OpenVR.IVRApplications(pointer);
}

function check(what: string, error: OpenVR.ApplicationError): void {
  if (error !== OpenVR.ApplicationError.VRApplicationError_None) {
    throw new Error(`${what}: ${OpenVR.ApplicationError[error]}`);
  }
}

/**
 * Registers `manifestPath` permanently and sets auto-launch for `appKey`.
 * @returns how it was registered, for the user.
 */
export function registerSteamVrApp(
  manifestPath: string,
  appKey: string,
  autoLaunch: boolean,
): string {
  const applications = runningSteamVrApplications();
  if (applications != null) {
    const added = applications.AddApplicationManifest(manifestPath, false);
    if (added !== OpenVR.ApplicationError.VRApplicationError_AppKeyAlreadyExists) {
      check("AddApplicationManifest", added);
    }
    check("SetApplicationAutoLaunch", applications.SetApplicationAutoLaunch(appKey, autoLaunch));
    return "registered with the running SteamVR";
  }
  const config = steamConfigDir();
  if (config == null) {
    throw new Error(
      Deno.build.os === "linux"
        ? "no Steam config directory found; is Steam installed?"
        : "SteamVR is not running; start SteamVR, then install again",
    );
  }
  const appConfig = join(config, "appconfig.json");
  writeAtomic(appConfig, appConfigWithManifest(readText(appConfig), manifestPath));
  const vrAppConfig = vrAppConfigPath(config, appKey);
  writeAtomic(vrAppConfig, vrAppConfigWithAutoLaunch(readText(vrAppConfig), autoLaunch));
  return `added to ${appConfig}; SteamVR picks it up on its next start`;
}

/**
 * Turns auto-launch off and removes `manifestPath` from SteamVR.
 * @returns how it was removed, for the user.
 */
export function unregisterSteamVrApp(manifestPath: string, appKey: string): string {
  const applications = runningSteamVrApplications();
  if (applications != null) {
    if (applications.IsApplicationInstalled(appKey)) {
      applications.SetApplicationAutoLaunch(appKey, false);
    }
    const removed = applications.RemoveApplicationManifest(manifestPath);
    if (removed !== OpenVR.ApplicationError.VRApplicationError_None) {
      return `removed from the running SteamVR (${OpenVR.ApplicationError[removed]})`;
    }
    return "removed from the running SteamVR";
  }
  const config = steamConfigDir();
  if (config == null) return "SteamVR is not running; nothing registered to remove";
  const appConfig = join(config, "appconfig.json");
  const text = readText(appConfig);
  if (appConfigListsManifest(text, manifestPath)) {
    writeAtomic(appConfig, appConfigWithoutManifest(text, manifestPath));
  }
  const vrAppConfig = vrAppConfigPath(config, appKey);
  const vrText = readText(vrAppConfig);
  if (vrText != null) writeAtomic(vrAppConfig, vrAppConfigWithAutoLaunch(vrText, false));
  return `removed from ${appConfig}`;
}
