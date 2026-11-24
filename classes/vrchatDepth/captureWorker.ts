/** Runs inside the desktop tool process; owns the only ffmpeg capture while its lease is held. */
import { VrchatWindowStream } from "./windowStream.ts";
import { depthFrameToWire, type RawDepthFrame, WindowDepthDecoder } from "./windowDecoder.ts";
import { SharedDepthFrames } from "./sharedFrames.ts";
import { ColorClassifier } from "./colorCalibration.ts";

/** This runs as a worker: its postMessage takes a transfer list (DOM's global types it as a window). */
const scope = globalThis as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

export type CaptureWorkerConfig = {
  buffer: SharedArrayBuffer;
  capacity: number;
  grid: number;
  foregroundGrid: number;
  owner: string;
  target: string;
  baseUrl: string;
  /**
   * Frames come from the render thread (`gpuDepthSource.ts`) as `{ raw }` messages instead of an
   * ffmpeg capture here; this worker then only forwards them and keeps the lease alive.
   */
  external?: boolean;
};

type ExternalMessage =
  | { raw: RawDepthFrame }
  | { status: unknown }
  | { buildTable: { id: number; samples: Uint8Array; levels: number } };

let stream: VrchatWindowStream | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let stopped = false;
let pending: RawDepthFrame | null = null;
let forwarding = false;
let external = false;
let externalStatus: unknown = null;
let forwardExternal: ((raw: RawDepthFrame) => void) | null = null;

globalThis.onmessage = (
  event: MessageEvent<CaptureWorkerConfig | { stop: true } | ExternalMessage>,
) => {
  if ("raw" in event.data) {
    if (!stopped) forwardExternal?.(event.data.raw);
    return;
  }
  if ("buildTable" in event.data) {
    // 3D calibration's shader table, off the render thread (`gpuDepthSource.ts`).
    const { id, samples, levels } = event.data.buildTable;
    const table = new ColorClassifier(samples, levels).shaderTable(64, 8);
    scope.postMessage(
      { table: { id, data: table.data, width: table.width, height: table.height, size: 64, tiles: 8 } },
      [table.data.buffer],
    );
    return;
  }
  if ("status" in event.data) {
    externalStatus = event.data.status;
    return;
  }
  if ("stop" in event.data) {
    stopped = true;
    pending = null;
    if (heartbeat) clearInterval(heartbeat);
    void stream?.stop().finally(() => {
      scope.postMessage({ stopped: true });
      globalThis.close();
    });
    return;
  }
  if (stream || external) return;
  const config = event.data;
  external = config.external === true;
  const shared = new SharedDepthFrames(config.capacity, config.buffer, config.foregroundGrid ** 2);
  const decoder = new WindowDepthDecoder(config.grid, config.foregroundGrid);
  let sequence = 0;
  const post = async (type: string, payload: unknown) => {
    const response = await fetch(`${config.baseUrl}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: config.target, type, payload, reply: true }),
      signal: AbortSignal.timeout(2000),
    });
    const body = await response.json();
    if (body.result === false) throw new Error(`${type}: capture lease lost`);
    if (!response.ok || body.ok === false) {
      throw new Error(`${type}: HTTP ${response.status} ${JSON.stringify(body.error ?? body).slice(0, 200)}`);
    }
    return body.result;
  };
  /** The intake answers each frame with what webxr wants on the wire (`VRCDEPTHWANTS`). */
  let colors = true;
  const forwardLatest = async () => {
    if (forwarding || stopped) return;
    forwarding = true;
    try {
      while (pending && !stopped) {
        const frame = pending;
        pending = null;
        // The VR scene remains in another process. Its wire conversion happens here, never in
        // the desktop render loop; at most one outgoing frame and one replacement are retained.
        const reply = await post("EXTERNALDEPTHFRAME", {
          owner: config.owner,
          frame: depthFrameToWire(frame, null, { colors }),
        }) as { colors?: boolean } | true;
        if (typeof reply === "object" && typeof reply.colors === "boolean" && reply.colors !== colors) {
          colors = reply.colors;
          // The render thread's GPU source skips its colour readback while nobody uses colours.
          scope.postMessage({ wants: { colors } });
        }
      }
    } catch (error) {
      scope.postMessage({
        error: String(error),
        fatal: String(error).includes("capture lease lost"),
      });
    } finally {
      forwarding = false;
    }
  };
  forwardExternal = (raw) => {
    pending = raw;
    void forwardLatest();
  };
  if (!external) stream = new VrchatWindowStream((frame) => {
    if (stopped) return;
    const raw = decoder.decode(frame);
    if (!raw) return;
    raw.decodedAt = Date.now();
    const notice = shared.write(raw, ++sequence);
    if (notice) scope.postMessage({ frame: notice });
    pending = raw;
    void forwardLatest();
  }, { captureTiming: true });
  stream?.start();
  heartbeat = setInterval(() => {
    if (stopped) return;
    void post("EXTERNALDEPTHHEARTBEAT", {
      owner: config.owner,
      stream: stream ? stream.status() : externalStatus,
      metrics: stream
        ? {
          decodeMs: decoder.decodeMs,
          lastFailure: decoder.lastFailure,
          failures: decoder.failures,
          repeats: decoder.repeats,
        }
        : (externalStatus as { metrics?: unknown } | null)?.metrics ?? null,
    }).catch((error) =>
      scope.postMessage({
        error: String(error),
        fatal: String(error).includes("capture lease lost"),
      })
    );
  }, 1000);
};
