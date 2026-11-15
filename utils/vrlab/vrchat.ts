/**
 * VRChat under Proton: OSC input (UDP 9000), OSCQuery state, the output log, and launch.
 *
 * OSC reaches VRChat even when its startup log says `OSC enabled: False`. Known behaviour of the
 * camera endpoints in this build: `/usercamera/Mode` stores a mode but does not open a closed
 * camera (open it from the Action Menu, see `camera.ts`), and `/usercamera/Pose` is read-only and
 * only sent while the camera moves.
 */
import { desktopEnv, pidsMatching, sleep, waitFor } from "./util.ts";

export const VRCHAT_APP_ID = 438100;
const LOG_DIR = `${Deno.env.get("HOME")}/.local/share/Steam/steamapps/compatdata/${VRCHAT_APP_ID}` +
  "/pfx/drive_c/users/steamuser/AppData/LocalLow/VRChat/VRChat";

export type OscArg = number | boolean | string | { f: number } | { i: number };

/** Plain numbers are sent as floats unless they are integers; wrap as `{i}` / `{f}` to force a type. */
export function encodeOsc(address: string, args: OscArg[]): Uint8Array {
  const encoder = new TextEncoder();
  const padded = (bytes: Uint8Array) => {
    const out = new Uint8Array((bytes.length + 4) & ~3);
    out.set(bytes);
    return out;
  };
  let tags = ",";
  const payload: Uint8Array[] = [];
  for (const arg of args) {
    if (typeof arg === "boolean") tags += arg ? "T" : "F";
    else if (typeof arg === "string") {
      tags += "s";
      payload.push(padded(encoder.encode(arg)));
    } else {
      const isInt = typeof arg === "object" ? "i" in arg : Number.isInteger(arg);
      const value = typeof arg === "object" ? ("i" in arg ? arg.i : arg.f) : arg;
      const bytes = new Uint8Array(4);
      const view = new DataView(bytes.buffer);
      if (isInt) view.setInt32(0, value, false);
      else view.setFloat32(0, value, false);
      tags += isInt ? "i" : "f";
      payload.push(bytes);
    }
  }
  const parts = [padded(encoder.encode(address)), padded(encoder.encode(tags)), ...payload];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

let socket: Deno.DatagramConn | null = null;

export async function sendOsc(address: string, ...args: OscArg[]): Promise<void> {
  socket ??= Deno.listenDatagram({ hostname: "127.0.0.1", port: 0, transport: "udp" });
  await socket.send(encodeOsc(address, args), {
    hostname: "127.0.0.1",
    port: 9000,
    transport: "udp",
  });
}

/** `/input/<name>` buttons are momentary ints: press for `ms`, then release. */
export async function pressInput(name: string, ms = 300): Promise<void> {
  await sendOsc(`/input/${name}`, { i: 1 });
  await sleep(ms);
  await sendOsc(`/input/${name}`, { i: 0 });
}

export async function chatbox(text: string, immediate = true): Promise<void> {
  await sendOsc("/chatbox/input", text, immediate);
}

export function latestLog(): string | null {
  try {
    const logs = [...Deno.readDirSync(LOG_DIR)]
      .filter((entry) => entry.name.startsWith("output_log_"))
      .map((entry) => entry.name)
      .sort();
    return logs.length ? `${LOG_DIR}/${logs.at(-1)}` : null;
  } catch {
    return null;
  }
}

export function readLog(): string {
  const path = latestLog();
  return path ? Deno.readTextFileSync(path) : "";
}

/** VRChat's OSCQuery HTTP port from this session's log (it changes per launch). */
export function oscQueryPort(): number | null {
  const match = [...readLog().matchAll(/Advertising Service \S+ of type OSCQuery on (\d+)/g)].at(
    -1,
  );
  return match ? Number(match[1]) : null;
}

/** Current value of an OSCQuery node, e.g. `/usercamera/Mode` → `[2]`. */
export async function oscQuery(path: string): Promise<unknown[] | null> {
  const port = oscQueryPort();
  if (port == null) throw new Error("VRChat has not advertised OSCQuery yet");
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!response.ok) return null;
  return (await response.json()).VALUE ?? null;
}

export function isRunning(): boolean {
  return pidsMatching("VRChat.exe").length > 0;
}

export function inWorld(): boolean {
  return /Entering Room:/.test(readLog());
}

/**
 * Launches VRChat through Steam (VR mode, since SteamVR is running) and waits for a world.
 * `instance` (`wrld_…:id~…`) joins that instance instead of the home world, through the same
 * `vrchat://launch` URL a web link uses.
 */
export async function launch(timeoutMs = 240_000, instance?: string): Promise<string> {
  if (!isRunning()) {
    const previous = latestLog();
    const url = instance
      ? [`vrchat://launch?ref=vrchat.com&id=${instance}`]
      : [];
    new Deno.Command(`${Deno.env.get("HOME")}/.local/share/Steam/steam.sh`, {
      args: ["-applaunch", String(VRCHAT_APP_ID), ...url],
      env: desktopEnv(),
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn().unref();
    await waitFor("a new VRChat log", () => latestLog() !== previous && latestLog(), 120_000);
  }
  await waitFor("VRChat to enter a world", inWorld, timeoutMs, 2_000);
  const log = readLog();
  return /Connected to petplay/.test(log)
    ? "vr (synthetic headset)"
    : /Initialized\. Connected to/.test(log)
    ? "vr"
    : "desktop";
}

/** Ends VRChat: SIGTERM to the Windows process lets Proton shut it down. */
export async function quit(): Promise<void> {
  for (const pid of pidsMatching("VRChat.exe")) {
    try {
      Deno.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  await waitFor("VRChat to exit", () => !isRunning(), 30_000).catch(() => {});
}

/**
 * A fresh session: menus closed, camera closed, avatar back at the world's spawn. The cheapest
 * reset for VRChat's UI state, which the scripted menu paths depend on.
 */
export async function restart(timeoutMs = 240_000): Promise<string> {
  await quit();
  return await launch(timeoutMs);
}
