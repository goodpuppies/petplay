/**
 * Standalone remote overlay renderer over Stageforge + Iroh.
 *
 * Runs `petplay/overlayRenderOwner.ts` locally (with this machine's OpenVR runtime and GPU) and
 * connects over a direct Iroh P2P link to a remote PetPlay `webxr` actor (e.g. `pp dev` running
 * on a Linux dev box while this script runs on a Windows SteamVR machine).
 *
 * Usage (standalone, after the host has called ALLOW_DIRECT for this peer's direct endpoint id):
 *   deno run -A --no-check utils/remote-overlay-renderer.ts \
 *     --webxr=<remoteWebxrActorId> \
 *     --endpoint='<json {"id":"...","relay":"..."}>' \
 *     [--mode=panorama|projection] [--banks=0|2|3] [--eye-size=2048] \
 *     [--link-binary=/path/to/petplay-media.exe] [--repl-port=3989]
 *
 * Usage (handshake over stdin, driven by `utils/remote-renderer-attach.ts`):
 *   deno run -A --no-check utils/remote-overlay-renderer.ts --handshake-stdin [--mode=panorama]
 *   1. Prints `REMOTE_RENDERER_DIRECT_ENDPOINT {"id":"...","relay":"..."}`
 *   2. Reads one JSON line `{"webxr":"...","endpoint":{"id":"...","relay":"..."}}` from stdin
 *   3. Connects directly over Iroh and starts `overlayRenderOwner`.
 */
import { parseArgs } from "@std/cli/parse-args";
import { type ActorId, PostalService } from "../submodules/stageforge/mod.ts";
import { irohCarrier, type IrohEndpoint } from "../classes/irohCarrier.ts";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const DIRECT_ENDPOINT_PREFIX = "REMOTE_RENDERER_DIRECT_ENDPOINT ";

type PresentMode = "panorama" | "projection";
type DmabufBanks = 0 | 2 | 3;

type HandshakeInput = {
  webxr: string;
  endpoint: IrohEndpoint;
};

type RendererHealth = {
  running?: boolean;
  receivedScenes?: number;
  publishedFrames?: number;
  sceneVersion?: number;
  transport?: string;
  presentMode?: string;
  dmabufBanks?: number;
  error?: string | null;
  waitTimeouts?: number;
  droppedLateFrames?: number;
};

const args = parseArgs(Deno.args, {
  string: [
    "webxr",
    "endpoint",
    "endpoint-id",
    "endpoint-relay",
    "mode",
    "banks",
    "eye-size",
    "overlay-key",
    "overlay-name",
    "overlay-width",
    "overlay-distance",
    "link-binary",
    "relay",
    "repl-port",
    "connect-timeout-ms",
    "status-interval-ms",
    "ready-file",
    "handshake-file",
  ],
  boolean: ["handshake-stdin", "local", "help"],
  default: {
    mode: "panorama",
    "overlay-width": "3",
    "overlay-distance": "1",
    "connect-timeout-ms": "30000",
    "status-interval-ms": "2000",
    "handshake-stdin": false,
    local: false,
    help: false,
  },
});

if (args.help) {
  console.log(
    "Usage: deno run -A --no-check utils/remote-overlay-renderer.ts [options]\n" +
      "  --webxr=<actorId>             Remote webxr actor id\n" +
      "  --endpoint=<json>             Remote direct Iroh endpoint JSON\n" +
      "  --endpoint-id=<id>            Remote direct Iroh endpoint id (alternative to --endpoint)\n" +
      "  --endpoint-relay=<url>        Remote direct Iroh relay URL\n" +
      "  --handshake-stdin             Print own direct endpoint and read {webxr,endpoint} from stdin\n" +
      "  --mode=panorama|projection    Present mode (default: panorama)\n" +
      "  --banks=0|2|3                 Shared bank count override\n" +
      "  --eye-size=<px>               Eye render target size override\n" +
      "  --link-binary=<path>          Path to petplay-media binary (or PETPLAY_LINK_BINARY)\n" +
      "  --relay=<url>                 Custom Iroh relay URL\n" +
      "  --local                       Use loopback Iroh (single-machine test)\n" +
      "  --repl-port=<port>            Start a local agentRepl HTTP server for this renderer\n" +
      "  --connect-timeout-ms=<ms>     Direct Iroh dial retry timeout (default: 30000)\n" +
      "  --status-interval-ms=<ms>     Heartbeat log interval, 0 disables (default: 2000)",
  );
  Deno.exit(0);
}

function parsePresentMode(raw: string): PresentMode {
  if (raw === "panorama" || raw === "projection") return raw;
  throw new Error(`Invalid --mode=${raw}; expected "panorama" or "projection"`);
}

function parseBanks(raw: string | undefined): DmabufBanks | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  if (n === 0 || n === 2 || n === 3) return n;
  throw new Error(`Invalid --banks=${raw}; expected 0, 2, or 3`);
}

function parseOptionalInt(raw: string | undefined, name: string): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid --${name}=${raw}`);
  return n;
}

function parseCliTarget(): HandshakeInput | null {
  const webxr = args.webxr?.trim();
  let endpoint: IrohEndpoint | null = null;
  if (args.endpoint) {
    endpoint = JSON.parse(args.endpoint) as IrohEndpoint;
  } else if (args["endpoint-id"]) {
    endpoint = {
      id: args["endpoint-id"].trim(),
      ...(args["endpoint-relay"] ? { relay: args["endpoint-relay"].trim() } : {}),
    };
  }
  if (!webxr && !endpoint) return null;
  if (!webxr || !endpoint?.id) {
    throw new Error("Both --webxr and --endpoint (or --endpoint-id) are required together");
  }
  return { webxr, endpoint };
}

async function readHandshakeLine(): Promise<HandshakeInput> {
  const reader = Deno.stdin.readable.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const nl = buffer.indexOf("\n");
      if (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        if (line.length > 0) {
          const parsed = JSON.parse(line) as HandshakeInput;
          if (!parsed?.webxr || !parsed?.endpoint?.id) {
            throw new Error(`Invalid handshake payload: ${line}`);
          }
          return parsed;
        }
        buffer = buffer.slice(nl + 1);
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error("Stdin closed before receiving remote renderer handshake");
}

const presentMode = parsePresentMode(args.mode);
const dmabufBanks = parseBanks(args.banks);
const eyeSize = parseOptionalInt(args["eye-size"], "eye-size");
const overlayWidthInMeters = Number(args["overlay-width"]);
const overlayDistance = Number(args["overlay-distance"]);
const connectTimeoutMs = Math.max(1000, Number(args["connect-timeout-ms"]) || 30000);
const statusIntervalMs = Math.max(0, Number(args["status-interval-ms"]) || 2000);
const replPort = parseOptionalInt(args["repl-port"], "repl-port");

const postal = new PostalService();
const carrier = irohCarrier({
  binary: args["link-binary"] || undefined,
  local: args.local,
  relay: args.relay || undefined,
});
postal.registerRemoteCarrier(carrier);

let rendererActor: ActorId | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;
let exiting = false;

async function shutdown(code = 0): Promise<void> {
  if (exiting) return;
  exiting = true;
  if (statusTimer != null) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  if (rendererActor) {
    try {
      await Promise.race([
        postal.PostMessage({ target: rendererActor, type: "STOPOVERLAYRENDERER", payload: null }, true),
        wait(3000),
      ]);
    } catch {
      // Best-effort stop during teardown.
    }
  }
  await postal.shutdownAll({ reason: "remote-renderer-exit", timeoutMs: 3000, bestEffort: true });
  postal.closeRemote("remote-renderer-exit");
  await carrier.stop().catch(() => {});
  Deno.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  try {
    Deno.addSignalListener(signal, () => {
      console.log(`[remote-renderer] received ${signal}; shutting down`);
      void shutdown(0);
    });
  } catch {
    // SIGTERM is not supported on Windows.
  }
}

try {
  const directEndpointFn = postal.functions.DIRECT_ENDPOINT as
    | (() => Promise<IrohEndpoint | null>)
    | undefined;
  const connectDirectFn = postal.functions.CONNECT_DIRECT as
    | ((payload: { endpoint: IrohEndpoint; actors?: ActorId[] }) => Promise<{
      peerId: string | null;
      tier: string;
    }>)
    | undefined;
  if (!directEndpointFn || !connectDirectFn) {
    throw new Error("PostalService is missing DIRECT_ENDPOINT / CONNECT_DIRECT system handlers");
  }

  const directEndpoint = await directEndpointFn();
  if (!directEndpoint?.id) {
    throw new Error("Failed to acquire local Iroh direct endpoint");
  }
  console.log(`${DIRECT_ENDPOINT_PREFIX}${JSON.stringify(directEndpoint)}`);
  if (args["ready-file"]) {
    const readyPayload = JSON.stringify({ pid: Deno.pid, endpoint: directEndpoint });
    const tmpPath = `${args["ready-file"]}.tmp`;
    Deno.writeTextFileSync(tmpPath, readyPayload);
    Deno.renameSync(tmpPath, args["ready-file"]);
  }

  let target = parseCliTarget();
  if (args["handshake-file"]) {
    console.error(`[remote-renderer] waiting for handshake file ${args["handshake-file"]}...`);
    const handshakeDeadline = performance.now() + 60_000;
    while (performance.now() < handshakeDeadline) {
      try {
        const raw = Deno.readTextFileSync(args["handshake-file"]).trim();
        if (raw.length > 0) {
          const parsed = JSON.parse(raw) as HandshakeInput;
          if (parsed?.webxr && parsed?.endpoint?.id) {
            target = parsed;
            try {
              Deno.removeSync(args["handshake-file"]);
            } catch {
              // Ignore cleanup race.
            }
            break;
          }
        }
      } catch {
        // Not written yet.
      }
      await wait(150);
    }
    if (!target) {
      throw new Error(`Timed out waiting for handshake file ${args["handshake-file"]}`);
    }
  } else if (args["handshake-stdin"] || !target) {
    console.error("[remote-renderer] waiting for {webxr,endpoint} handshake on stdin...");
    target = await readHandshakeLine();
  }

  // Retry direct dial briefly in case the host is still applying ALLOW_DIRECT.
  const deadline = performance.now() + connectTimeoutMs;
  let lastConnectError: unknown = null;
  let connected: { peerId: string | null; tier: string } | null = null;
  while (performance.now() < deadline) {
    try {
      connected = await connectDirectFn({
        endpoint: target.endpoint,
        actors: [target.webxr as ActorId],
      });
      break;
    } catch (error) {
      lastConnectError = error;
      await wait(500);
    }
  }
  if (!connected) {
    throw new Error(
      `Failed to establish direct Iroh connection to ${target.endpoint.id} within ${connectTimeoutMs}ms: ${lastConnectError}`,
    );
  }
  console.log(
    `[remote-renderer] connected (${connected.tier}) to peer=${connected.peerId ?? target.endpoint.id} -> webxr=${target.webxr}`,
  );

  rendererActor = await postal.add("../petplay/overlayRenderOwner.ts", import.meta.url);

  if (replPort != null) {
    Deno.env.set("PETPLAY_AGENT_REPL_PORT", String(replPort));
    const replActor = await postal.add("../petplay/agentRepl.ts", import.meta.url);
    await postal.PostMessage({
      target: replActor,
      type: "REGISTER_ACTORS",
      payload: {
        overlayRenderer: rendererActor,
        webxr: target.webxr as ActorId,
      },
    }, true);
    console.log(`[remote-renderer] local agentRepl listening on http://127.0.0.1:${replPort}`);
  }

  const startStatus = await postal.PostMessage({
    target: rendererActor,
    type: "STARTOVERLAYRENDERER",
    payload: {
      webxrTarget: target.webxr,
      overlayKey: args["overlay-key"] || `petplay.webxr.remote.${Deno.pid}`,
      overlayName: args["overlay-name"] || "PetPlay Remote Overlay",
      eyeSize,
      presentMode,
      ...(dmabufBanks !== undefined ? { dmabufBanks } : {}),
      overlayWidthInMeters: Number.isFinite(overlayWidthInMeters) ? overlayWidthInMeters : 3,
      overlayDistance: Number.isFinite(overlayDistance) ? overlayDistance : 1,
    },
  }, true) as RendererHealth;
  console.log(
    `[remote-renderer] overlayRenderOwner started (${rendererActor}) mode=${startStatus.presentMode ?? presentMode} banks=${startStatus.dmabufBanks ?? "default"}`,
  );

  if (statusIntervalMs > 0) {
    statusTimer = setInterval(async () => {
      if (!rendererActor || exiting) return;
      try {
        const health = await postal.PostMessage({
          target: rendererActor,
          type: "__HEALTH__",
          payload: null,
        }, true) as RendererHealth;
        console.log(
          `[remote-renderer] running=${Boolean(health.running)} scenes=${health.receivedScenes ?? 0} ` +
            `published=${health.publishedFrames ?? 0} ver=${health.sceneVersion ?? 0} ` +
            `mode=${health.presentMode ?? "?"} banks=${health.dmabufBanks ?? "?"} ` +
            `transport="${health.transport ?? ""}"` +
            (health.error ? ` ERROR="${health.error}"` : ""),
        );
      } catch (error) {
        console.error(`[remote-renderer] health poll failed: ${error}`);
      }
    }, statusIntervalMs);
  }
} catch (error) {
  console.error("[remote-renderer] fatal:", error);
  await shutdown(1);
}
