/**
 * Loopback WebSocket bridge from the media viewer's WebXR mode to the synthetic OpenVR driver.
 *
 *   deno task xrclient [--port 3992] [--origin http://127.0.0.1:4471] [--driver-socket PATH]
 *
 * The viewer connects with `?xr=ws://127.0.0.1:3992/xr`. One headset at a time; disconnecting
 * returns the head and controllers to the driver's defaults. See markdown/webxr-client.md.
 */
import { PostalService } from "../submodules/stageforge/mod.ts";
import { attachOpenVrDriverProxy } from "../classes/petplayOpenVrDriverProxy.ts";
import { parseXrMessage, suggestProfile, XrDriverWriter } from "../classes/xrClientBridge.ts";

const args: Record<string, string | undefined> = {
  port: "3992",
  origin: "http://127.0.0.1:4471",
  hostname: "127.0.0.1",
};
for (let i = 0; i < Deno.args.length; i++) {
  const [flag, inline] = Deno.args[i].split(/=(.*)/s, 2);
  const name = flag.replace(/^--/, "");
  if (!flag.startsWith("--") || !["port", "origin", "driver-socket", "hostname"].includes(name)) {
    throw Error(`unknown argument ${Deno.args[i]}`);
  }
  args[name] = inline ?? Deno.args[++i];
}

function defaultSocket(): string {
  // A scoped lab session names its own socket directory in the SteamVR settings.
  try {
    const settings = JSON.parse(
      Deno.readTextFileSync(`${Deno.env.get("HOME")}/.local/share/Steam/config/steamvr.vrsettings`),
    );
    const directory = settings.driver_petplay?.socketDirectory;
    if (directory) return `${directory}/control.sock`;
  } catch { /* fall through to the default */ }
  return `/run/user/${Deno.uid()}/petplay_ovrdriver/control.sock`;
}
const socketPath = args["driver-socket"] ?? defaultSocket();

const postal = new PostalService();
const driver = await attachOpenVrDriverProxy(postal, socketPath);
async function send<T>(type: string, payload: unknown = null): Promise<T> {
  const value = await postal.PostMessage({ target: driver, type, payload }, true) as T & {
    __actorError?: { message: string };
  };
  if (value?.__actorError) throw Error(value.__actorError.message);
  return value;
}
const profile = await send<Record<string, number | boolean>>("GETDISPLAYPROFILE");
const source = {
  fovTan: {
    left: Number(profile.fovTanLeft ?? 1),
    right: Number(profile.fovTanRight ?? 1),
    up: Number(profile.fovTanUp ?? 1),
    down: Number(profile.fovTanDown ?? 1),
  },
  ipdMeters: Number(profile.ipdMeters),
  displayEyeWidth: Number(profile.displayEyeWidth),
  displayEyeHeight: Number(profile.displayEyeHeight),
};
console.log(`XR_BRIDGE_DRIVER socket=${socketPath} source=${JSON.stringify(source)}`);

let active: WebSocket | null = null;
const port = Number(args.port);
Deno.serve({
  hostname: args.hostname,
  port,
  onListen: () =>
    console.log(`XR_BRIDGE_READY ws://${args.hostname}:${port}/xr origin=${args.origin}`),
}, (req) => {
  if (new URL(req.url).pathname !== "/xr") return new Response("Not found", { status: 404 });
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket required", { status: 426 });
  }
  if (req.headers.get("origin") !== args.origin) {
    return new Response("Origin mismatch", { status: 403 });
  }
  if (active) return new Response("A headset is already connected", { status: 409 });
  const { socket, response } = Deno.upgradeWebSocket(req, { idleTimeout: 10 });
  active = socket;
  const writer = new XrDriverWriter(send);
  let frames = 0, lastSequence = -1, closed = false;
  const report = setInterval(() => {
    console.log(
      `XR_BRIDGE_STATS frames/s=${frames} driverFailures=${writer.failures}${
        writer.lastError ? ` last=${writer.lastError}` : ""
      }`,
    );
    frames = 0;
  }, 5000);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(report);
    if (active === socket) active = null;
    writer.release().then(
      () => console.log("XR_BRIDGE_RELEASED"),
      (error) => console.error("XR_BRIDGE_RELEASE_FAILED", String(error)),
    );
  };
  socket.onopen = () => socket.send(JSON.stringify({ version: 1, type: "xr-bridge", source }));
  socket.onmessage = (event) => {
    try {
      if (typeof event.data !== "string" || event.data.length > 4096) throw Error("Invalid packet");
      const raw = JSON.parse(event.data);
      if (raw?.type === "heartbeat") return;
      const message = parseXrMessage(raw);
      if (message.type === "xr-views") {
        console.log(`XR_VIEWS suggested driver_petplay=${JSON.stringify(suggestProfile(message))}`);
        return;
      }
      // Ordered transport; a non-increasing sequence means a confused or replayed sender.
      if (message.sequence <= lastSequence) throw Error("Stale sequence");
      lastSequence = message.sequence;
      frames++;
      void writer.apply(message);
    } catch (error) {
      socket.close(1008, String(error).slice(0, 100));
      close();
    }
  };
  socket.onclose = close;
  socket.onerror = close;
  console.log("XR_BRIDGE_CONNECTED");
  return response;
});
