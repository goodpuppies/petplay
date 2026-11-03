/**
 * Synthetic VR lab control: SteamVR on the synthetic driver, PetPlay, VRChat and OBS, all
 * scriptable. Library in `utils/vrlab/`; the camera-layer check is `utils/vrlab-camera-check.ts`.
 *
 * ```sh
 * deno task vrlab up [--seconds=3600] [--real-config] [--no-vrchat] [--no-eye-capture]
 *                                          # lab → keepalive → PetPlay → VRChat
 * deno task vrlab down [--stop-petplay]      # reverse; the lab restores SteamVR settings
 * deno task vrlab status
 *
 * deno task vrlab hand right 0.1 1.4 -0.35 [pitch yaw roll]   # hold a hand (tracking m, degrees)
 * deno task vrlab hand right release                         # back to the driver trajectory
 * deno task vrlab press left b [ms]          # trigger|grip|a|b|system|stick; b on the left is Y
 * deno task vrlab stick left -0.8 0.6 [ms]   # hold the joystick, then centre it
 *
 * deno task vrlab vrchat restart|launch|quit  # restart resets menus, camera and position
 *
 * deno task vrlab osc /input/LookRight i:1   # raw OSC to VRChat (i:, f:, s:, T, F, or numbers)
 * deno task vrlab tap Jump                   # /input/<name> press and release
 * deno task vrlab chat "hello"               # chatbox
 * deno task vrlab query /usercamera/Mode     # OSCQuery value
 *
 * deno task vrlab menu open                 # Action Menu on the left hand, turned to face the head
 * deno task vrlab menu pick tools|camera|x,y # select an entry by stick direction
 *
 * deno task vrlab camera open [stream|photo|…] [--eyes]   # menu → Tools → Camera, then the mode
 * deno task vrlab camera grab                     # right hand finds and holds the camera
 * deno task vrlab camera calibrate [seconds]      # sweep the held camera while PetPlay calibrates
 * deno task vrlab camera aim px py pz tx ty tz    # held camera to P looking at T (tracking space)
 * deno task vrlab camera pose                     # world and calibrated tracking pose
 *
 * deno task vrlab obs launch                 # OBS under X11 with the websocket on
 * deno task vrlab obs setup                  # Scene: VRChat + "PetPlay VRC Camera" window sources
 * deno task vrlab obs shot [source] [path]   # PNG of a source, default the composite
 *
 * deno task vrlab marker left|right|off      # PetPlay sphere at its own controller pose
 *
 * deno task vrlab dashboard [status|open|close|toggle]   # the SteamVR dashboard (takes input while open)
 *
 * deno task vrlab eye [path.png] [--layers]  # what the headset is shown (VRChat + overlays), eyes side by side
 * ```
 *
 * Needs the desktop session (X11 for OBS window lookup); the Steam client supplies DISPLAY.
 */
import {
  ACTION_MENU,
  aimCamera,
  CAMERA_MODE,
  cameraTrackingPose,
  cameraWorldPose,
  grabCamera,
  openActionMenu,
  openCamera,
  pickActionMenu,
  sweepForCalibration,
} from "./vrlab/camera.ts";
import { euler, type Hand, type HandInput, SyntheticDriver } from "./vrlab/driver.ts";
import { captureEyes } from "./vrlab/eye.ts";
import { dashboardVisible, setDashboard } from "./vrlab/steamvr.ts";
import { launchObs, Obs } from "./vrlab/obs.ts";
import { hideHandMarker, showHandMarker } from "./vrlab/petplay.ts";
import { down, freshVrchat, status, up } from "./vrlab/stack.ts";
import * as vrchat from "./vrlab/vrchat.ts";
import { chatbox, type OscArg, oscQuery, pressInput, sendOsc } from "./vrlab/vrchat.ts";
import { findX11Window } from "./vrlab/x11.ts";
import { desktopEnv } from "./vrlab/util.ts";

const args = Deno.args.filter((arg) => !arg.startsWith("--"));
const flag = (name: string) => Deno.args.includes(`--${name}`);
const option = (name: string) =>
  Deno.args.find((arg) => arg.startsWith(`--${name}=`))?.split("=", 2)[1];
const numbers = (from: number, count: number) => args.slice(from, from + count).map(Number);
const deg = Math.PI / 180;

/** The X11 helpers read DISPLAY from this process; take it from the desktop session when unset. */
function ensureDesktopEnv(): void {
  for (const [key, value] of Object.entries(desktopEnv())) {
    if (!Deno.env.get(key)) Deno.env.set(key, value);
  }
}

function parseOscArg(text: string): OscArg {
  if (text === "T") return true;
  if (text === "F") return false;
  if (text.startsWith("i:")) return { i: Number(text.slice(2)) };
  if (text.startsWith("f:")) return { f: Number(text.slice(2)) };
  if (text.startsWith("s:")) return text.slice(2);
  return Number.isFinite(Number(text)) ? Number(text) : text;
}

async function withDriver<T>(run: (driver: SyntheticDriver) => Promise<T>): Promise<T> {
  const driver = await SyntheticDriver.attach();
  try {
    return await run(driver);
  } finally {
    driver.close();
  }
}

async function withObs<T>(run: (obs: Obs) => Promise<T>): Promise<T> {
  const obs = await Obs.connect();
  try {
    return await run(obs);
  } finally {
    obs.close();
  }
}

const print = (value: unknown) =>
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));

async function main(): Promise<void> {
  const [command, sub] = args;
  switch (command) {
    case "up":
      return await up({
        seconds: Number(option("seconds") ?? 3600),
        realConfig: flag("real-config"),
        vrchat: !flag("no-vrchat"),
        eyeCapture: !flag("no-eye-capture"),
        displayProfile: option("display-profile") as "lab" | "beyond75" | undefined,
        executable: option("executable"),
      });
    case "down":
      return await down({ stopPetplay: flag("stop-petplay") });
    case "status":
      return print(await status());
    case "hand": {
      const hand = sub as Hand;
      if (args[2] === "release") return void await withDriver((d) => d.release(hand));
      const [x, y, z, pitch = 0, yaw = 0, roll = 0] = numbers(2, 6);
      return void await withDriver((d) =>
        d.setPose(hand, {
          position: [x, y, z],
          rotation: euler(pitch * deg, yaw * deg, roll * deg),
        })
      );
    }
    case "press": {
      const control = args[2];
      const input: HandInput = control === "trigger" || control === "grip"
        ? { [control]: 1 }
        : control === "stick"
        ? { joystickClick: true }
        : { [control]: true };
      return void await withDriver((d) => d.press(sub as Hand, input, Number(args[3] ?? 150)));
    }
    case "stick": {
      const [x, y, ms = 400] = numbers(2, 3);
      return void await withDriver((d) => d.press(sub as Hand, { joystick: [x, y] }, ms));
    }
    case "vrchat":
      if (sub === "restart") return await freshVrchat();
      if (sub === "launch") return print(`VRChat in a world (${await vrchat.launch()})`);
      if (sub === "quit") return await vrchat.quit();
      break;
    case "osc":
      return await sendOsc(sub, ...args.slice(2).map(parseOscArg));
    case "tap":
      return await pressInput(sub, Number(args[2] ?? 300));
    case "chat":
      return await chatbox(args.slice(1).join(" "));
    case "query":
      return print(await oscQuery(sub));
    case "menu":
      if (sub === "open") return void await withDriver((d) => openActionMenu(d));
      if (sub === "pick") {
        const named = ACTION_MENU[args[2] as keyof typeof ACTION_MENU];
        const direction = named ?? (args[2].split(",").map(Number) as [number, number]);
        return void await withDriver((d) => pickActionMenu(d, direction));
      }
      break;
    case "camera":
      switch (sub) {
        case "open": {
          const mode = CAMERA_MODE[(args[2] ?? "stream") as keyof typeof CAMERA_MODE];
          const run = `${Deno.cwd()}/logs/vrlab/camera-open-${Date.now()}`;
          return print(
            await withDriver((d) =>
              openCamera(
                d,
                mode,
                flag("eyes")
                  ? async (step) =>
                    print((await captureEyes(`${run}-${step}.png`, { driver: d })).path)
                  : undefined,
              )
            ),
          );
        }
        case "grab":
          return print(await withDriver((d) => grabCamera(d)));
        case "calibrate":
          return print(
            await withDriver(async (d) =>
              sweepForCalibration(d, (await d.handPose("right")).position, Number(args[2] ?? 14))
            ),
          );
        case "aim": {
          const [px, py, pz, tx, ty, tz] = numbers(2, 6);
          return print(await withDriver((d) => aimCamera(d, [px, py, pz], [tx, ty, tz])));
        }
        case "pose":
          return print({
            world: await cameraWorldPose(),
            tracking: await cameraTrackingPose().catch((e) => String(e)),
          });
      }
      break;
    case "obs":
      switch (sub) {
        case "launch":
          return await launchObs();
        case "setup":
          ensureDesktopEnv();
          return await withObs(async (obs) => {
            const scene = (await obs.request<{ currentProgramSceneName: string }>("GetSceneList"))
              .currentProgramSceneName;
            for (
              const [source, window] of [["VRChat", "VRChat"], [
                "PetPlay Layer",
                "PetPlay VRC Camera",
              ]]
            ) {
              const found = findX11Window(window);
              if (!found) {
                throw new Error(
                  `no "${window}" window (start VRChat / \`deno task client camera\` first)`,
                );
              }
              await obs.captureWindow(scene, source, found);
            }
            print(`scene "${scene}": VRChat with the PetPlay layer above it`);
          });
        case "shot": {
          const path = args[3] ?? `${Deno.cwd()}/logs/vrlab/obs-${Date.now()}.png`;
          Deno.mkdirSync(`${Deno.cwd()}/logs/vrlab`, { recursive: true });
          return print(
            await withObs(async (obs) => {
              const source = args[2] ??
                (await obs.request<{ currentProgramSceneName: string }>("GetSceneList"))
                  .currentProgramSceneName;
              return await obs.screenshot(source, path);
            }),
          );
        }
      }
      break;
    case "dashboard": {
      const want = sub === "open"
        ? true
        : sub === "close"
        ? false
        : sub === "toggle"
        ? !dashboardVisible()
        : null;
      if (want !== null) await withDriver((d) => setDashboard(d, want));
      return print({ dashboardVisible: dashboardVisible() });
    }
    case "eye": {
      Deno.mkdirSync(`${Deno.cwd()}/logs/vrlab`, { recursive: true });
      return print(
        await captureEyes(sub ?? `${Deno.cwd()}/logs/vrlab/eye-${Date.now()}.png`, {
          layers: flag("layers"),
        }),
      );
    }
    case "marker":
      return print(
        sub === "off"
          ? (await hideHandMarker("left"), await hideHandMarker("right"))
          : await showHandMarker(sub as Hand),
      );
  }
  console.error("usage: see the header of utils/vrlab.ts");
  Deno.exit(2);
}

try {
  await main();
  Deno.exit(0);
} catch (error) {
  console.error(`vrlab: ${error instanceof Error ? error.message : error}`);
  Deno.exit(1);
}
