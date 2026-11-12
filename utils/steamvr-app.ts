#!/usr/bin/env -S deno run -A
/**
 * Registers this checkout with SteamVR as a permanent overlay app, so PetPlay
 * shows up under *Startup / Shutdown → Choose startup overlay apps* and SteamVR
 * starts it by itself.
 *
 * ```sh
 * deno task steamvr:register                    # register + auto-launch on
 * deno task steamvr:register -- --desktop       # ... with server flags
 * deno task steamvr:register -- --no-autolaunch # listed, but off until ticked
 * deno task steamvr:unregister
 * deno task steamvr:status
 * ```
 *
 * `register` writes `petplay.vrmanifest`, its launcher and image into
 * `$XDG_DATA_HOME/petplay/steamvr/` (see `classes/steamVrManifest.ts`), then:
 *
 * - with SteamVR running, registers through the OpenVR API as a background app
 *   (which never starts SteamVR);
 * - with SteamVR stopped, edits SteamVR's `appconfig.json` and the app's
 *   `vrappconfig` directly. SteamVR owns those files while it runs and rewrites
 *   them on exit, so this path refuses to run then.
 *
 * What SteamVR launches is `utils/steamvr-watch.ts --once`: it reuses a server
 * that is already running, or starts one, and stops the server it started when
 * SteamVR exits. Server flags after `register` are baked into the launcher.
 *
 * This replaces the systemd dev install (`deno task install:dev`) for the "with
 * VR" lifetime. Both can be installed at once without starting two servers, but
 * one is enough.
 */
import { dirname, fromFileUrl, join } from "@std/path";
import {
  readText,
  registerSteamVrApp,
  steamConfigDir,
  unregisterSteamVrApp,
  vrAppConfigPath,
  writeAtomic,
} from "../classes/steamVrRegistration.ts";
import { DEFAULT_STEAMVR_PROCESS_NAMES, steamVrRunning } from "../classes/steamVrProcess.ts";
import { steamVrAppDir } from "../classes/appPaths.ts";
import {
  appConfigListsManifest,
  buildSteamVrLauncher,
  buildSteamVrManifest,
  STEAMVR_APP_KEY,
  STEAMVR_IMAGE_FILE,
  STEAMVR_LAUNCHER_FILE,
  STEAMVR_MANIFEST_FILE,
  vrAppConfigAutoLaunch,
} from "../classes/steamVrManifest.ts";

const LOG_PREFIX = "[steamvr-app]";

type Command = "register" | "unregister" | "status";

function help(): string {
  return [
    "steamvr-app — register PetPlay with SteamVR as a startup overlay app (Linux)",
    "",
    "usage: deno run -A utils/steamvr-app.ts <register|unregister|status>",
    "       [--no-autolaunch] [<server args…>]",
    "",
    "  register        write the manifest and launcher, register them, turn auto-launch on",
    "                  (server args are baked into the launcher)",
    "  unregister      turn auto-launch off and remove the registration and files",
    "  status          where the files are and what SteamVR has on record",
    "",
    "  --no-autolaunch register without ticking SteamVR's auto-launch toggle",
  ].join("\n");
}

function home(): string {
  const value = Deno.env.get("HOME")?.trim();
  if (!value) throw new Error("HOME is not set");
  return value;
}

/** Where the generated manifest, launcher and image live (the release installer's too). */
function appDir(): string {
  return steamVrAppDir();
}

function checkoutRoot(): string {
  return dirname(dirname(fromFileUrl(import.meta.url)));
}

function steamVrUp(): boolean {
  return steamVrRunning(DEFAULT_STEAMVR_PROCESS_NAMES);
}

function writeAppFiles(serverArgs: readonly string[]): string {
  const dir = appDir();
  const root = checkoutRoot();
  Deno.mkdirSync(dir, { recursive: true });
  writeAtomic(
    join(dir, STEAMVR_MANIFEST_FILE),
    buildSteamVrManifest({ binaryPath: STEAMVR_LAUNCHER_FILE, imagePath: STEAMVR_IMAGE_FILE }),
  );
  const launcher = join(dir, STEAMVR_LAUNCHER_FILE);
  writeAtomic(
    launcher,
    buildSteamVrLauncher({
      workingDirectory: root,
      command: [
        Deno.execPath(),
        "run",
        "-A",
        "--env-file",
        join(root, "utils", "steamvr-watch.ts"),
        "--once",
        ...serverArgs,
      ],
    }),
  );
  Deno.chmodSync(launcher, 0o755);
  Deno.copyFileSync(join(root, "resources", "PetPlay.png"), join(dir, STEAMVR_IMAGE_FILE));
  console.log(
    `${LOG_PREFIX} wrote ${dir}/{${STEAMVR_MANIFEST_FILE},${STEAMVR_LAUNCHER_FILE},${STEAMVR_IMAGE_FILE}}`,
  );
  return join(dir, STEAMVR_MANIFEST_FILE);
}

function register(serverArgs: readonly string[], autoLaunch: boolean): number {
  const manifest = writeAppFiles(serverArgs);
  console.log(`${LOG_PREFIX} ${registerSteamVrApp(manifest, STEAMVR_APP_KEY, autoLaunch)}`);
  console.log(
    [
      `${LOG_PREFIX} PetPlay is a SteamVR startup overlay app (${STEAMVR_APP_KEY})`,
      `  auto-launch   ${autoLaunch ? "on" : "off"} (SteamVR → Settings → Startup / Shutdown)`,
      `  server args   ${serverArgs.length > 0 ? serverArgs.join(" ") : "(none)"}`,
      `  launch log    ~/.local/state/petplay/steamvr-launch.log (the server's own log is in ./logs)`,
      `  remove        deno task steamvr:unregister`,
    ].join("\n"),
  );
  return 0;
}

function unregister(): number {
  const manifest = join(appDir(), STEAMVR_MANIFEST_FILE);
  console.log(`${LOG_PREFIX} ${unregisterSteamVrApp(manifest, STEAMVR_APP_KEY)}`);
  try {
    Deno.removeSync(appDir(), { recursive: true });
    console.log(`${LOG_PREFIX} removed ${appDir()}`);
  } catch {
    // Never registered from here.
  }
  return 0;
}

function status(): number {
  const dir = appDir();
  const manifest = join(dir, STEAMVR_MANIFEST_FILE);
  const launcher = readText(join(dir, STEAMVR_LAUNCHER_FILE));
  const config = steamConfigDir();
  const appConfig = config == null ? null : readText(join(config, "appconfig.json"));
  const vrAppConfig = config == null ? null : readText(vrAppConfigPath(config, STEAMVR_APP_KEY));
  console.log(`app key       ${STEAMVR_APP_KEY}`);
  console.log(`files         ${readText(manifest) == null ? "(not written)" : dir}`);
  console.log(`launches      ${launcher?.match(/^command=\((.*)\)$/m)?.[1] ?? "(nothing)"}`);
  console.log(`steam config  ${config ?? "(not found)"}`);
  console.log(`registered    ${appConfigListsManifest(appConfig, manifest) ? "yes" : "no"}`);
  console.log(`auto-launch   ${vrAppConfigAutoLaunch(vrAppConfig) ? "on" : "off"}`);
  console.log(
    `steamvr       ${steamVrUp() ? "running (its unsaved changes are not shown)" : "stopped"}`,
  );
  return 0;
}

function main(): number {
  const args = [...Deno.args];
  if (args.includes("--help") || args.includes("-h")) {
    console.log(help());
    return 0;
  }
  if (Deno.build.os !== "linux") {
    console.error(`${LOG_PREFIX} Linux only for now: the launcher is a bash script.`);
    return 2;
  }
  const command = (args.shift() ?? "status") as Command;
  const autoLaunch = !args.includes("--no-autolaunch");
  const serverArgs = args.filter((arg) => arg !== "--no-autolaunch" && arg !== "--");
  switch (command) {
    case "register":
      return register(serverArgs, autoLaunch);
    case "unregister":
      return unregister();
    case "status":
      return status();
    default:
      console.error(`${LOG_PREFIX} unknown command "${command}"\n`);
      console.error(help());
      return 2;
  }
}

try {
  Deno.exit(main());
} catch (error) {
  console.error(`${LOG_PREFIX} ${error instanceof Error ? error.message : error}`);
  Deno.exit(1);
}
