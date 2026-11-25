/** Experimental projection renderer: own process, tracking, GL resources, and render cadence. */
import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import * as THREE from "three";
import { OpenVrRuntime } from "../classes/openVrRuntime.ts";
import { OpenVrOverlayFramePacer } from "../classes/openVrOverlayFramePacing.ts";
import { OpenVrControllerTipPoseResolver } from "../classes/openVrControllerTipPose.ts";
import { OpenVrProjectionOverlays } from "../classes/openVrProjectionOverlays.ts";
import { OpenVrOverlayTexture } from "../classes/openVrOverlayTexture.ts";
import {
  type DmabufBankPool,
  OverlayPresenterNative,
  type RenderCameras,
} from "../classes/overlayPresenterNative.ts";
import { stringToPointer } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { trackingMatrix34, writeStereoRenderViews } from "../classes/overlayRenderCamera.ts";
import {
  followFrame,
  followKey,
  type FollowPair,
  type RenderAnchors,
  type RenderAnchorSpace,
  resolveRenderAnchors,
  setRenderHandAnchors,
} from "../classes/overlayRenderTracking.ts";
import { WebXROverlayRaylib } from "../classes/webxrOverlayRaylib.ts";
import type { WebXRRaythreeRenderPayload } from "../classes/webxrRaythreeScene.ts";
import {
  OVERLAY_SCENE_WIRE_FORMAT,
  type OverlayScenePacket,
  OverlaySceneWireDecoder,
} from "../classes/overlaySceneWire.ts";
import { wait } from "../classes/utils.ts";
import { setCurrentThreadNice } from "../classes/linuxScheduling.ts";
import { OverlayWristMotionProbe } from "../classes/overlayWristMotionProbe.ts";
import { motionProbeFrame, OverlayMotionProbe } from "../classes/overlayMotionProbe.ts";
import { OverlaySceneInbox } from "../classes/overlaySceneDelivery.ts";

/**
 * `projection`: per-eye projection overlays, reprojected by SteamVR, but SteamVR draws them
 * behind every quad overlay (PetPlay's display screens included).
 * `panorama`: both eyes side by side on one HMD-attached stereo-panorama overlay, as the
 * in-worker renderer did: sorts with other overlays normally, no reprojection.
 */
export type PresentMode = "projection" | "panorama";
export type DmabufBankCount = 0 | 2 | 3;
type PanoramaPacing = "vsync" | "vsync-locked" | "frame-sync" | "presenter";

function defaultDmabufBanks(): DmabufBankCount {
  if (Deno.build.os !== "linux") return 0;
  const raw = Deno.env.get("PETPLAY_DMABUF_BANKS");
  if (raw === "0") return 0;
  if (raw === "2") return 2;
  if (raw === "3") return 3;
  return 3;
}

type Start = {
  webxrTarget?: string;
  overlayKey?: string;
  overlayName?: string;
  eyeSize?: number;
  presentMode?: PresentMode;
  dmabufBanks?: DmabufBankCount;
  overlayWidthInMeters?: number;
  overlayDistance?: number;
};
const state = actorState({
  name: "overlay_renderer",
  running: false,
  stopRequested: false,
  webxrTarget: null as string | null,
  eyeSize: null as number | null,
  error: null as string | null,
  sceneVersion: 0,
  renderFrameId: 0,
  publishedFrames: 0,
  waitTimeouts: 0,
  trackingInvalid: 0,
  resolvedAnchors: 0,
  /** Tracked poses of the last rendered frame: what the user last saw. */
  renderedAnchors: {} as Record<string, number[]>,
  /**
   * Released grabs (FOLLOWRELEASE): their carried items hold this pose, the last one shown, until
   * a scene arrives without them, so letting go does not carry the window on with the hand while
   * the worker's landed scene is in flight.
   */
  followFreeze: new Map<string, { pose: number[]; at: number }>(),
  receivedScenes: 0,
  lastDecodeMs: 0,
  lastPacketBytes: 0,
  lastSceneIntervalMs: 0,
  freezeScene: false,
  freezeRendering: false,
  /**
   * Presenter paths: after the frame-sync wait, drop a frame that would reach the display a
   * vsync later than its poses were predicted for, instead of submitting it late. The compositor
   * reprojects the previous frame; the next frame samples fresh poses.
   */
  dropLateFrames: false,
  /** Render thread niceness, read back after setting (null until set). */
  renderThreadNice: null as { tid: number; nice: number; error?: string } | null,
  droppedLateFrames: 0,
  // Preserve the established raster/publication calibration while asymmetric frusta are audited.
  // This chooses optical parameters only; render eye views remain independent of IR-time poses.
  projectionMode: "scene-compatible" as "headset" | "scene-compatible",
  presentMode: "projection" as PresentMode,
  /**
   * Linux projection mode: number of pre-bound DMA-BUF overlay banks (2 or 3) flipped via
   * ShowOverlay/HideOverlay with zero per-frame SetOverlayTexture calls. 0 = legacy GL submit.
   */
  dmabufBanks: defaultDmabufBanks() as DmabufBankCount,
  /**
   * Panorama only: whole display frames to predict the head pose beyond the next vsync. The
   * panorama is head-locked and never reprojected, so any gap between the predicted and the
   * displayed pose shows up as the world swimming with the head.
   */
  panoramaExtraPredictionFrames: 0,
  /**
   * Panorama only. `vsync`: start each frame at the vsync, as the in-worker renderer did, so every
   * frame reaches the compositor at the same point. `frame-sync`: start at `WaitFrameSync`, which
   * returns anywhere from 1 to 10 ms after the vsync. `presenter`: exactly the projection path's
   * loop (fast pacer, render, native GPU finish + `WaitFrameSync` + publish), so the two modes
   * differ only in the combine pass and the overlay type.
   */
  panoramaPacing: "vsync-locked" as PanoramaPacing,
  /**
   * Vsync-paced / vsync-locked panorama: hold each present until this many ms after the frame's
   * vsync (after the GPU fence completes in `vsync-locked`). SteamVR latches overlays ~8.5 ms
   * after vsync; flipping at 10.5 ms places every frame cleanly in the same latch window.
   */
  panoramaPresentMinMs: 10.5,
  /** Diagnostic only: match projection's alternating submitted source images. */
  panoramaTextureRotation: false,
  lastRenderImages: null as { left: number; right: number; output: number } | null,
  lastPresent: null as unknown,
  motionProbe: false,
  wristMotionProbe: false,
  /** Anchored items per tracking space in the last rendered scene. */
  anchorSpaces: {} as Record<string, number>,
  /** `GetEyeToHeadTransform` per eye (column-major), as the render eye views use it. */
  eyeToHead: null as { left: number[]; right: number[] } | null,
  lastRenderTracking: null as { head: number[]; predictedSecondsToPhotons: number } | null,
  transport: "OpenGL baseline (compositor image reuse is not resolved)",
});
let latest: WebXRRaythreeRenderPayload | null = null;
/** Panorama frames: [ms after vsync at frame sync, ms after vsync at present, vsyncs between them, predicted ms]. */
const panoramaPhase: [number, number, number, number][] = [];
let loop: Promise<void> | null = null;
let registered = false;
let receivedStream: string | null = null;
let receivedSequence = 0;
let receivedAt = 0;
let inbox = new OverlaySceneInbox();
let wireDecoder = new OverlaySceneWireDecoder();
let motionProbe: OverlayMotionProbe | null = null;
let wristProbe: OverlayWristMotionProbe | null = null;
let workProbe = false;
const workRows: Record<string, unknown>[] = [];
/**
 * Frame timeline probe: `[ms, kind, ...fields]` rows for loop phases and message handling, so a
 * missed compositor frame can be attributed to render, GPU/compositor wait, decode or GC. Heap
 * readings bracket each phase; a drop between two readings means a GC ran in between.
 */
let timeline: unknown[][] | null = null;
const TIMELINE_LIMIT = 60000;
function mark(kind: string, ...fields: unknown[]) {
  if (timeline && timeline.length < TIMELINE_LIMIT) {
    timeline.push([performance.now(), kind, Deno.memoryUsage().heapUsed, ...fields]);
  }
}
/** Render thread's cumulative [on-CPU ns, runqueue-wait ns, timeslices] from schedstat. */
function schedstat(): number[] {
  return Deno.readTextFileSync("/proc/thread-self/schedstat").trim().split(" ").map(Number);
}
// Open only for the native-controller diagnostic; shared with Vulkan capture's
// CLOCK_MONOTONIC domain. Ordinary rendering keeps no extra FFI clock calls.
function createProbeClock() {
  const library = Deno.dlopen(
    "libc.so.6",
    {
      clock_gettime: { parameters: ["i32", "buffer"], result: "i32" },
    } as const,
  );
  const time = new BigInt64Array(2);
  return {
    close: () => library.close(),
    now: () => {
      if (library.symbols.clock_gettime(1, time)) throw new Error("Probe CLOCK_MONOTONIC failed");
      return Number(time[0]) + Number(time[1]) / 1e9;
    },
  };
}
let probeClock: ReturnType<typeof createProbeClock> | null = null;
let probeStartMs = 0;
let probeDurationMs = 0;
let probeHead: THREE.Matrix4 | null = null;
let probeGeneration = 0;
// Bounded, diagnostic-only CPU publication log. It does not measure compositor consumption.
const probeRows: Record<string, unknown>[] = [];
const runtime = new OpenVrRuntime("PetPlay independent renderer");
function health() {
  return { ...state, pid: Deno.pid, latestSceneFrame: latest?.frame.frameCount ?? null };
}
/** A released grab whose landed scene never arrives stops holding after this long. */
const FOLLOW_FREEZE_MAX_MS = 1000;

new PostMan(
  state,
  {
    __INIT__: () => {},
    __HEALTH__: () => health(),
    FOLLOWRELEASE: (payload: { space: RenderAnchorSpace; pair?: FollowPair; seq: number }) => {
      const frame = followFrame(state.renderedAnchors, payload.space, payload.pair);
      const pose = frame ? Array.from(frame.elements) : null;
      if (pose) {
        state.followFreeze.set(followKey(payload.space, payload.pair), {
          pose,
          at: performance.now(),
        });
      }
      if (state.webxrTarget) {
        PostMan.PostMessage({
          target: state.webxrTarget,
          type: "FOLLOWRELEASED",
          payload: { seq: payload.seq, pose },
        });
      }
    },
    STARTOVERLAYRENDERER: (options: Start) => {
      if (loop) throw new Error("Renderer already started; stop it before reconfiguration");
      state.webxrTarget = options.webxrTarget ?? null;
      state.eyeSize = options.eyeSize ?? null;
      state.presentMode = options.presentMode ?? "projection";
      if (options.dmabufBanks != null) state.dmabufBanks = options.dmabufBanks;
      state.stopRequested = false;
      state.error = null;
      latest = null;
      inbox = new OverlaySceneInbox();
      wireDecoder = new OverlaySceneWireDecoder();
      receivedStream = null;
      receivedSequence = 0;
      loop = run(options).catch((error) => {
        state.error = String(error);
        console.error("[overlay_renderer]", error);
        if (state.webxrTarget) {
          PostMan.PostMessage({
            target: state.webxrTarget,
            type: "OVERLAYRENDERSTATUS",
            payload: { actorId: state.id, status: health() },
          });
        }
      })
        .finally(() => {
          loop = null;
          state.running = false;
        });
      return health();
    },
    WEBXRVIEWFRAME: receiveScene,
    WEBXRVIEWFRAMEPACKET: (packet: OverlayScenePacket) => {
      if (state.freezeScene) return;
      decodePacket(packet);
    },
    SETPRESENTMODE: (mode: PresentMode) => {
      if (mode !== "projection" && mode !== "panorama") {
        throw new Error(`Unknown present mode ${mode}`);
      }
      state.presentMode = mode;
      return health();
    },
    SETEYESIZE: (eyeSize: number) => {
      if (!Number.isInteger(eyeSize) || eyeSize < 64 || eyeSize > 4096) {
        throw new Error(`Invalid eye size ${eyeSize}`);
      }
      state.eyeSize = eyeSize;
      return health();
    },
    GETPANORAMAPHASE: () => panoramaPhase.slice(),
    /** `durationMs`, or `{ durationMs, intervalUs }` for finer sampling than 1 ms. */
    PROFILECPU: async (request: number | { durationMs: number; intervalUs?: number }) => {
      const { captureCpuProfile } = await import("../classes/cpuProfile.ts");
      return typeof request === "number"
        ? await captureCpuProfile(request)
        : await captureCpuProfile(request.durationMs, request.intervalUs);
    },
    SETRENDERWORKPROBE: (enabled: boolean) => {
      workProbe = enabled;
      workRows.length = 0;
      return { enabled };
    },
    GETRENDERWORKPROBE: () => ({ enabled: workProbe, rows: workRows.slice() }),
    SETFRAMETIMELINE: (enabled: boolean) => {
      timeline = enabled ? [] : null;
      return { enabled };
    },
    /** Returns and clears collected rows; collection continues while enabled. */
    TAKEFRAMETIMELINE: () => {
      mark("take");
      const rows = timeline ?? [];
      if (timeline) timeline = [];
      return rows;
    },
    SETWRISTMOTIONPROBE: (enabled: boolean) => {
      if (motionProbe) throw new Error("Disable isolated motion probe first");
      wristProbe = enabled ? new OverlayWristMotionProbe() : null;
      state.wristMotionProbe = enabled;
      if (enabled) inbox.invalidateAdoptedAssets();
      probeClock?.close();
      probeClock = enabled ? createProbeClock() : null;
      return { enabled, scope: "Full scene with wrist marker and render-generation tag" };
    },
    GETWRISTMOTIONPROBE: () => ({ enabled: !!wristProbe, rows: wristProbe?.rows.slice() ?? [] }),
    SETMOTIONPROBE: (
      options: { enabled: boolean; durationMs?: number; nativeController?: boolean },
    ) => {
      if (options.enabled && wristProbe) throw new Error("Disable full-scene wrist probe first");
      probeClock?.close();
      probeClock = options.enabled && options.nativeController ? createProbeClock() : null;
      if (options.enabled) {
        const duration = options.durationMs ?? 30000;
        if (!Number.isFinite(duration) || duration < 100 || duration > 60000) {
          throw new Error("Probe duration must be 100..60000 ms");
        }
        // Use established optics if available; no IR-time camera or hand pose is used.
        motionProbe = new OverlayMotionProbe(
          latest?.frame ?? motionProbeFrame(256),
          options.nativeController ?? false,
        );
        probeStartMs = performance.now();
        probeDurationMs = duration;
        probeHead = null;
        probeGeneration = 0;
        probeRows.length = 0;
      } else motionProbe = null;
      state.motionProbe = !!motionProbe;
      return health();
    },
    GETMOTIONPROBE: () => ({
      scope: "CPU render/publication only; compositor capture required to measure delivery",
      active: state.motionProbe,
      rows: probeRows.slice(),
    }),
    SETRENDERERDEBUG: (value: {
      panoramaExtraPredictionFrames?: number;
      panoramaPacing?: PanoramaPacing;
      panoramaPresentMinMs?: number;
      panoramaTextureRotation?: boolean;
      freezeScene?: boolean;
      freezeRendering?: boolean;
      dropLateFrames?: boolean;
      renderThreadNice?: number;
      projectionMode?: "headset" | "scene-compatible";
      dmabufBanks?: DmabufBankCount;
    }) => {
      state.panoramaExtraPredictionFrames = value.panoramaExtraPredictionFrames ??
        state.panoramaExtraPredictionFrames;
      state.panoramaPresentMinMs = value.panoramaPresentMinMs ?? state.panoramaPresentMinMs;
      state.panoramaTextureRotation = value.panoramaTextureRotation ??
        state.panoramaTextureRotation;
      if (value.panoramaPacing != null) {
        if (!["vsync", "vsync-locked", "frame-sync", "presenter"].includes(value.panoramaPacing)) {
          throw new Error("Unknown panorama pacing");
        }
        state.panoramaPacing = value.panoramaPacing;
      }
      const wasFrozen = state.freezeScene;
      state.freezeScene = value.freezeScene ?? state.freezeScene;
      state.freezeRendering = value.freezeRendering ?? state.freezeRendering;
      state.dropLateFrames = value.dropLateFrames ?? state.dropLateFrames;
      // Handlers run on the render loop's own thread, so this targets the render thread.
      if (value.renderThreadNice != null) {
        state.renderThreadNice = setCurrentThreadNice(value.renderThreadNice);
      }
      if (value.projectionMode != null) {
        if (value.projectionMode !== "headset" && value.projectionMode !== "scene-compatible") {
          throw new Error("Unknown projection comparison mode");
        }
        state.projectionMode = value.projectionMode;
      }
      if (value.dmabufBanks != null) {
        if (value.dmabufBanks !== 0 && value.dmabufBanks !== 2 && value.dmabufBanks !== 3) {
          throw new Error("dmabufBanks must be 0, 2, or 3");
        }
        state.dmabufBanks = value.dmabufBanks;
      }
      // Re-prime the complete asset baseline after rejecting frozen deliveries.
      if (wasFrozen && !state.freezeScene && registered) register();
      return health();
    },
    STOPOVERLAYRENDERER: async () => {
      state.stopRequested = true;
      await loop;
      return health();
    },
    __SHUTDOWN__: async () => {
      state.stopRequested = true;
      await loop;
    },
  } as const,
);
function decodePacket(packet: OverlayScenePacket) {
  mark("decode0", packet.data.length);
  const start = performance.now();
  const decoded = wireDecoder.decode(packet);
  state.lastDecodeMs = performance.now() - start;
  mark("decode1", decoded.stale);
  state.lastPacketBytes = packet.data.length;
  if (decoded.stale) acknowledge(decoded);
  else receiveScene(decoded.payload);
}
function receiveScene(payload: WebXRRaythreeRenderPayload) {
  // Hold credit while frozen; a new registration supplies a full baseline on resume.
  if (state.freezeScene) return;
  if (
    payload.delivery?.stream === receivedStream && payload.delivery.sequence <= receivedSequence
  ) {
    // A newer scene already arrived and carried these assets too. Still return the credit:
    // the sender holds it until this receipt, and both credits lost stalls every scene.
    acknowledge(payload);
    return;
  }
  // Persist dependencies before returning credit: a newer snapshot may replace this one
  // before drawing, including the scene that first introduced an asset.
  mark("inbox0");
  inbox.receive(payload);
  mark("inbox1");
  latest = payload;
  receivedStream = payload.delivery?.stream ?? null;
  receivedSequence = payload.delivery?.sequence ?? 0;
  state.sceneVersion = payload.frame.frameCount;
  const now = performance.now();
  state.lastSceneIntervalMs = receivedAt ? now - receivedAt : 0;
  receivedAt = now;
  state.receivedScenes++;
  acknowledge(payload);
}
function register() {
  if (!state.webxrTarget) return;
  PostMan.PostMessage({
    target: state.webxrTarget,
    type: "REGISTERWEBXRVIEW",
    payload: {
      actorId: state.id,
      label: "projection-renderer",
      wireFormat: OVERLAY_SCENE_WIRE_FORMAT,
      // Eye views and anchored items come from this renderer's own tracking.
      ownsTracking: true,
    },
  });
  registered = true;
}
function acknowledge(payload: Pick<WebXRRaythreeRenderPayload, "delivery">) {
  PostMan.PostMessage({
    target: state.webxrTarget!,
    type: "WEBXRVIEWFRAMEACK",
    payload: { actorId: state.id, delivery: payload.delivery },
  });
}
function projection(system: OpenVR.IVRSystem, eye: OpenVR.Eye) {
  const rows = system.GetProjectionMatrix(eye, .05, 100).m;
  const data = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) data[c * 4 + r] = rows[r][c];
  return data;
}
async function run(options: Start) {
  let renderer: WebXROverlayRaylib | null = null;
  let overlays: OpenVrProjectionOverlays | null = null;
  let bankOverlays: OpenVrProjectionOverlays[] = [];
  let bankPool: DmabufBankPool | null = null;
  let activeBank = -1;
  let pendingPanorama: { bank: number; showHandle: bigint; fence: Deno.PointerValue } | null =
    null;
  let pendingProjection: {
    bank: number;
    showHandles: readonly [bigint, bigint];
    fence: Deno.PointerValue;
    cameras: RenderCameras;
  } | null = null;
  const makeCamerasBuffer = (): RenderCameras => ({
    leftEyeViewMatrix: new Float32Array(16),
    rightEyeViewMatrix: new Float32Array(16),
    leftEyeProjectionMatrix: new Float32Array(16),
    rightEyeProjectionMatrix: new Float32Array(16),
  });
  const pendingProjectionCameras: [RenderCameras, RenderCameras] = [
    makeCamerasBuffer(),
    makeCamerasBuffer(),
  ];
  let pendingProjectionCamSlot = 0;
  let activeDmabufBanks: DmabufBankCount | null = null;
  let presenter = null as OverlayPresenterNative | null;
  let presenterLoadError: string | null = null;
  // Panorama is the main mode and presents without it; load the native helper only for the
  // projection path and `panoramaPacing: "presenter"`.
  let overlayPointer: Deno.PointerValue = null;
  let ipcResourceManagerPointer: Deno.PointerValue = null;
  const nativePresenter = () => presenter ??= new OverlayPresenterNative(overlayPointer!);
  const tryNativePresenter = (): OverlayPresenterNative | null => {
    if (presenter) return presenter;
    if (presenterLoadError) return null;
    try {
      return nativePresenter();
    } catch (err) {
      presenterLoadError = err instanceof Error ? err.message : String(err);
      console.warn("[overlay_renderer] Native presenter unavailable; falling back to OpenGL:", presenterLoadError);
      return null;
    }
  };
  let panorama: OpenVrOverlayTexture | null = null;
  let panoramaBankOverlays: OpenVrOverlayTexture[] = [];
  const clearPendingBanks = () => {
    if (pendingPanorama) {
      presenter?.deleteGpuFence(pendingPanorama.fence);
      pendingPanorama = null;
    }
    if (pendingProjection) {
      presenter?.deleteGpuFence(pendingProjection.fence);
      pendingProjection = null;
    }
  };
  const teardownDmabufBanks = () => {
    clearPendingBanks();
    renderer?.setExternalEyeBanks(null);
    renderer?.setExternalOutputBanks(null);
    for (const bank of bankOverlays) bank.cleanup();
    bankOverlays = [];
    for (const bank of panoramaBankOverlays) bank.cleanup();
    panoramaBankOverlays = [];
    bankPool?.destroy();
    bankPool = null;
    activeBank = -1;
  };
  const acquireIpcResourceManager = (): Deno.PointerValue => {
    if (ipcResourceManagerPointer) return ipcResourceManagerPointer;
    const errPtr = P.Int32P<OpenVR.InitError>();
    const ptr = OpenVR.VR_GetGenericInterface(
      stringToPointer("IVRIPCResourceManagerClient_003"),
      errPtr,
    );
    const err = new Deno.UnsafePointerView(errPtr).getInt32();
    if (!ptr || err !== OpenVR.InitError.VRInitError_None) return null;
    ipcResourceManagerPointer = ptr;
    return ptr;
  };
  try {
    const pointers = runtime.initialize({
      system: "required",
      overlay: "required",
      renderModels: "required",
    });
    const system = new OpenVR.IVRSystem(pointers.system!);
    const fastPacer = new OpenVrOverlayFramePacer(
      system,
      null,
      false,
      "fast",
      "independent-renderer",
    );
    const vsyncPacer = new OpenVrOverlayFramePacer(
      system,
      null,
      false,
      "vsync",
      "independent-panorama",
    );
    const displayHzRaw = system.GetFloatTrackedDeviceProperty(
      OpenVR.k_unTrackedDeviceIndex_Hmd,
      OpenVR.TrackedDeviceProperty.Prop_DisplayFrequency_Float,
      null,
    );
    const displayPeriodMs = Number.isFinite(displayHzRaw) && displayHzRaw > 1
      ? 1000 / displayHzRaw
      : 1000 / 75;
    // Own vsync-locked wake: run once per HMD vsync at `phaseMs` after the tick. Unlike
    // `vsyncLockedScheduler`, if a fresh vsync already started (e.g. `await wait(0)` returned at
    // 2 ms of N+1), run it immediately instead of skipping N+1 and sleeping a full 13.3 ms.
    let lastLockedVsync: bigint | null = null;
    const VSYNC_LOCKED_PHASE_MS = 1.5;
    const waitVsyncLocked = async () => {
      for (;;) {
        const phase = fastPacer.sampleVsyncPhase();
        if (!phase || phase.msSinceVsync < 0 || phase.msSinceVsync > displayPeriodMs * 2) {
          await wait(displayPeriodMs);
          return;
        }
        if (lastLockedVsync === null || phase.frameIndex > lastLockedVsync) {
          const untilPhase = VSYNC_LOCKED_PHASE_MS - phase.msSinceVsync;
          if (untilPhase > 0.5) {
            await wait(untilPhase);
            continue;
          }
          lastLockedVsync = phase.frameIndex;
          return;
        }
        const untilNext = displayPeriodMs - phase.msSinceVsync + VSYNC_LOCKED_PHASE_MS;
        await wait(Math.max(1, Math.min(displayPeriodMs, untilNext)));
      }
    };
    const tip = new OpenVrControllerTipPoseResolver(pointers.system!, pointers.renderModels!);
    overlayPointer = pointers.overlay;
    renderer = new WebXROverlayRaylib(options.eyeSize);
    renderer.initialize(options.overlayName ?? "PetPlay independent renderer");
    const overlayKey = options.overlayKey ?? `petplay.independent.${Deno.pid}`;
    const overlayName = options.overlayName ?? "PetPlay independent renderer";
    const overlayInterface = new OpenVR.IVROverlay(pointers.overlay!);
    overlays = new OpenVrProjectionOverlays(Deno.UnsafePointer.value(pointers.overlay!));
    panorama = new OpenVrOverlayTexture(Deno.UnsafePointer.value(pointers.overlay!));
    let panoramaReady = false;
    let activeMode: PresentMode | null = null;
    let activeEyeSize: number | null = state.eyeSize;
    const normalPanoramaDistance = options.overlayDistance ?? 1;
    let dashboardVisible = overlayInterface.IsDashboardVisible();
    const applyPanoramaLayering = (ov: OpenVrOverlayTexture, behindDashboard: boolean) => {
      // When the SteamVR dashboard is open, drop to sortOrder 0 and push behind the ~2m
      // dashboard (stereopanorama samples by view ray, so distance only affects OpenVR's
      // equal-sortOrder tie-breaker). Otherwise use sortOrder 1 to stay above desktop quads (0).
      ov.setSortOrder(behindDashboard ? 0 : 1);
      ov.setHmdDistance(behindDashboard ? 100 : normalPanoramaDistance);
    };
    const leftEye = trackingMatrix34(system.GetEyeToHeadTransform(OpenVR.Eye.Eye_Left).m);
    const rightEye = trackingMatrix34(system.GetEyeToHeadTransform(OpenVR.Eye.Eye_Right).m);
    state.eyeToHead = { left: leftEye.toArray(), right: rightEye.toArray() };
    const headsetProjections = {
      leftEyeProjectionMatrix: projection(system, OpenVR.Eye.Eye_Left),
      rightEyeProjectionMatrix: projection(system, OpenVR.Eye.Eye_Right),
    };
    const cameras: RenderCameras = {
      leftEyeViewMatrix: new Float32Array(16),
      rightEyeViewMatrix: new Float32Array(16),
      leftEyeProjectionMatrix: new Float32Array(16),
      rightEyeProjectionMatrix: new Float32Array(16),
    };
    const lookRotation = new Float32Array(16);
    const lookRotationMatrix = new THREE.Matrix4();
    const sampledHeadScratch = new THREE.Matrix4();
    const lastRenderHeadScratch = new Array<number>(16).fill(0);
    const zFlip = new THREE.Matrix4().makeScale(1, 1, -1);
    let shownLeft = 0;
    let shownPanorama = 0;
    let registeredAt = performance.now();
    let activeEpoch: string | null = null;
    let activeProbe: OverlayMotionProbe | null = null;
    let activeWristProbe: OverlayWristMotionProbe | null = null;
    let lastReportAt = 0;
    state.running = true;
    register();
    while (!state.stopRequested) {
      if (runtime.pollRuntimeEvents().exiting) {
        state.error = "SteamVR requested renderer shutdown";
        break;
      }
      // Re-register while empty; a scene-worker reload can replace the registry.
      if (!state.freezeScene && performance.now() - Math.max(registeredAt, receivedAt) > 5000) {
        register();
        registeredAt = performance.now();
      }
      if (motionProbe && performance.now() - probeStartMs > probeDurationMs) {
        motionProbe = null;
        state.motionProbe = false;
      }
      const probe = motionProbe;
      const wrist = wristProbe;
      if (wrist !== activeWristProbe) {
        inbox.invalidateAdoptedAssets();
        activeWristProbe = wrist;
      }
      if (probe !== activeProbe) {
        renderer.resetSceneAssets();
        inbox.invalidateAdoptedAssets();
        activeEpoch = null;
        activeProbe = probe;
      }
      const scene = inbox.current();
      const payload = probe?.payload ?? scene?.payload;
      if (!payload || state.freezeRendering) {
        await wait(10);
        continue;
      }
      if (payload.delivery && activeEpoch !== payload.delivery.epoch) {
        renderer.resetSceneAssets();
        activeEpoch = payload.delivery.epoch;
      }
      const desiredDmabufBanks: DmabufBankCount = state.dmabufBanks;
      const eyeSizeChanged = state.eyeSize != null && state.eyeSize !== activeEyeSize;
      if (
        activeMode !== state.presentMode ||
        activeDmabufBanks !== desiredDmabufBanks ||
        eyeSizeChanged
      ) {
        teardownDmabufBanks();
        if (eyeSizeChanged && state.eyeSize != null) {
          renderer.setRequestedEyeSize(state.eyeSize);
          activeEyeSize = state.eyeSize;
        }
        if (state.presentMode === "panorama") {
          overlays.cleanup();
          panorama.cleanup();
          panoramaReady = false;
          presenter?.resetVisibility();
          let bankReady = false;
          if (desiredDmabufBanks === 2 || desiredDmabufBanks === 3) {
            const native = tryNativePresenter();
            const ipcPtr = native?.hasDmabufBanks ? acquireIpcResourceManager() : null;
            const outSize = renderer.getPreferredOutputSize();
            const pool = native && ipcPtr
              ? native.createDmabufBankPool(
                ipcPtr,
                outSize.width,
                outSize.height,
                desiredDmabufBanks,
                1,
              )
              : null;
            if (pool && native) {
              try {
                for (let b = 0; b < desiredDmabufBanks; b++) {
                  const bankOv = new OpenVrOverlayTexture(
                    Deno.UnsafePointer.value(pointers.overlay!),
                  );
                  bankOv.initialize(0, {
                    key: `${overlayKey}.panorama.bank${b}`,
                    name: `${overlayName} (panorama bank ${b})`,
                    widthInMeters: options.overlayWidthInMeters,
                    distance: dashboardVisible ? 100 : normalPanoramaDistance,
                    mode: "stereo-panorama",
                    // Above desktop quad overlays (0), below SteamVR dashboard.
                    sortOrder: dashboardVisible ? 0 : 1,
                    attachToHmd: true,
                    // OpenGL FBO is bottom-up while Vulkan/DMA-BUF samples top-down.
                    flipVertical: true,
                    skipInitialTextureAndShow: true,
                  });
                  const bindErr = native.bindDmabufOverlay(
                    bankOv.getHandle(),
                    pool.slots[b].sharedHandle,
                  );
                  if (bindErr !== 0) {
                    throw new Error(`bindDmabufOverlay(panorama bank ${b}) failed: ${bindErr}`);
                  }
                  panoramaBankOverlays.push(bankOv);
                }
                bankPool = pool;
                renderer.setExternalOutputBanks(pool.slots, outSize.width, outSize.height);
                state.transport =
                  `DMA-BUF ${desiredDmabufBanks}-bank panorama flip (${outSize.width}x${outSize.height})`;
                bankReady = true;
              } catch (err) {
                console.warn(
                  "[overlay_renderer] DMA-BUF panorama bank setup failed, falling back to GL:",
                  err,
                );
                for (const bank of panoramaBankOverlays) bank.cleanup();
                panoramaBankOverlays = [];
                pool.destroy();
                renderer.setExternalOutputBanks(null);
              }
            } else {
              const reason = !native
                ? (presenterLoadError || "native presenter unavailable")
                : !native.hasDmabufBanks
                ? "native library lacks DMA-BUF bank symbols"
                : !ipcPtr
                ? "IVRIPCResourceManagerClient_003 unavailable"
                : (native.getDmabufBankLastError() || "pool creation failed");
              console.warn(
                `[overlay_renderer] DMA-BUF panorama banks unavailable (${reason}); using GL`,
              );
              state.transport = `OpenGL panorama fallback (${reason})`;
            }
          }
          if (!bankReady && !state.transport.startsWith("OpenGL panorama fallback")) {
            state.transport = "OpenGL panorama";
          }
        } else {
          panorama.cleanup();
          panoramaReady = false;
          overlays.cleanup();
          presenter?.resetVisibility();
          let bankReady = false;
          if (desiredDmabufBanks === 2 || desiredDmabufBanks === 3) {
            const native = tryNativePresenter();
            const ipcPtr = native?.hasDmabufBanks ? acquireIpcResourceManager() : null;
            const eyeSize = renderer.getPreferredEyeSize();
            const pool = native && ipcPtr
              ? native.createDmabufBankPool(ipcPtr, eyeSize, eyeSize, desiredDmabufBanks, 2)
              : null;
            if (pool && native) {
              try {
                const extBanks: {
                  left: { fbo: number; colorTexture: number; depthRbo: number };
                  right: { fbo: number; colorTexture: number; depthRbo: number };
                }[] = [];
                for (let b = 0; b < desiredDmabufBanks; b++) {
                  const bankOv = new OpenVrProjectionOverlays(
                    Deno.UnsafePointer.value(pointers.overlay!),
                  );
                  bankOv.initialize({
                    key: `${overlayKey}.bank${b}`,
                    name: `${overlayName} bank ${b}`,
                    sortOrder: 0,
                  });
                  bankOv.applyTextureBounds(true);
                  const [lh, rh] = bankOv.getHandles();
                  const leftSlot = pool.slots[b * 2];
                  const rightSlot = pool.slots[b * 2 + 1];
                  const bindL = native.bindDmabufOverlay(lh, leftSlot.sharedHandle);
                  const bindR = native.bindDmabufOverlay(rh, rightSlot.sharedHandle);
                  if (bindL !== 0 || bindR !== 0) {
                    throw new Error(`bindDmabufOverlay failed: left=${bindL} right=${bindR}`);
                  }
                  bankOverlays.push(bankOv);
                  extBanks.push({ left: leftSlot, right: rightSlot });
                }
                bankPool = pool;
                renderer.setExternalEyeBanks(extBanks, eyeSize, eyeSize);
                state.transport =
                  `DMA-BUF ${desiredDmabufBanks}-bank visibility flip (${eyeSize}x${eyeSize})`;
                bankReady = true;
              } catch (err) {
                console.warn("[overlay_renderer] DMA-BUF bank setup failed, falling back to GL:", err);
                for (const bank of bankOverlays) bank.cleanup();
                bankOverlays = [];
                pool.destroy();
                renderer.setExternalEyeBanks(null);
              }
            } else {
              const reason = !native
                ? (presenterLoadError || "native presenter unavailable")
                : !native.hasDmabufBanks
                ? "native library lacks DMA-BUF bank symbols"
                : !ipcPtr
                ? "IVRIPCResourceManagerClient_003 unavailable"
                : (native.getDmabufBankLastError() || "pool creation failed");
              console.warn(`[overlay_renderer] DMA-BUF banks unavailable (${reason}); using GL`);
              state.transport = `OpenGL fallback (${reason})`;
            }
          } else {
            state.transport = "OpenGL baseline (compositor image reuse is not resolved)";
          }
          if (!bankReady) {
            overlays.initialize({ key: overlayKey, name: overlayName, sortOrder: 0 });
          }
        }
        shownLeft = 0;
        shownPanorama = 0;
        activeMode = state.presentMode;
        activeDmabufBanks = desiredDmabufBanks;
      }
      const panoramaMode = activeMode === "panorama";
      const nextDashboardVisible = overlayInterface.IsDashboardVisible();
      if (nextDashboardVisible !== dashboardVisible) {
        dashboardVisible = nextDashboardVisible;
        if (panoramaMode) {
          for (const bank of panoramaBankOverlays) {
            applyPanoramaLayering(bank, dashboardVisible);
          }
          if (panoramaReady && panorama) {
            applyPanoramaLayering(panorama, dashboardVisible);
          }
        }
      }
      // Vsync pacing starts each frame at the display vsync (panorama's default); otherwise
      // frames start right after the previous presentation's wait.
      const vsyncPaced = panoramaMode && state.panoramaPacing === "vsync";
      const vsyncLocked = panoramaMode && state.panoramaPacing === "vsync-locked";
      const usePipelinedPanorama = vsyncLocked && bankPool !== null &&
        panoramaBankOverlays.length >= 3 && (presenter?.hasAsyncFence ?? false);
      const usePipelinedProjection = !panoramaMode && bankPool !== null &&
        bankOverlays.length >= 3 && (presenter?.hasAsyncFence ?? false);
      if (!usePipelinedPanorama && pendingPanorama) clearPendingBanks();
      if (!usePipelinedProjection && pendingProjection) clearPendingBanks();
      const pacer = vsyncPaced ? vsyncPacer : fastPacer;
      pacer.extraPredictionFrames = panoramaMode
        ? state.panoramaExtraPredictionFrames + (usePipelinedPanorama ? 1 : 0)
        : (usePipelinedProjection ? 1 : 0);
      mark("pace0");
      if (vsyncPaced) await pacer.paceToDisplayAndRefreshPosesYielding();
      else {
        if (vsyncLocked || usePipelinedProjection) {
          await waitVsyncLocked();
        } else if (panoramaMode && state.panoramaPacing === "frame-sync") {
          overlayInterface.WaitFrameSync(100);
        }
        pacer.paceToDisplayAndRefreshPoses();
      }
      const syncPhase = pacer.sampleVsyncPhase();
      mark("sample", syncPhase ? Number(syncPhase.frameIndex) : null, syncPhase?.msSinceVsync);
      const hmd = pacer.getCachedHmdEmulation();
      if (!hmd) {
        state.trackingInvalid++;
        await wait(10);
        continue;
      }
      const sampleMs = performance.now();
      const sampleMonotonicSeconds = probeClock?.now();
      const predictionMs = pacer.getLastPredictedSecondsToPhotons() * 1000;
      const sampledHead = sampledHeadScratch.fromArray(hmd.matrix);
      if (probe && !probeHead) probeHead = sampledHead.clone();
      const head = probe ? probeHead! : sampledHead;
      for (let i = 0; i < 16; i++) lastRenderHeadScratch[i] = head.elements[i]!;
      state.lastRenderTracking = {
        head: lastRenderHeadScratch,
        predictedSecondsToPhotons: pacer.getLastPredictedSecondsToPhotons(),
      };
      writeStereoRenderViews(head, leftEye, rightEye, cameras);
      // The panorama combine resamples around the head rotation the eyes were rendered from.
      lookRotation.set(lookRotationMatrix.copy(head).invert().multiply(zFlip).elements);
      // Compare only the optical frusta; eye views always come from fresh render tracking.
      const projections = state.projectionMode === "scene-compatible"
        ? payload.frame
        : headsetProjections;
      for (let i = 0; i < 16; i++) {
        cameras.leftEyeProjectionMatrix[i] = projections.leftEyeProjectionMatrix[i];
        cameras.rightEyeProjectionMatrix[i] = projections.rightEyeProjectionMatrix[i];
      }
      let probeSample = probe?.sample(
        sampleMs - probeStartMs + predictionMs,
        head,
        ++probeGeneration,
      );
      if (probe?.nativeController && probeSample) {
        const index = system.GetTrackedDeviceIndexForControllerRole(
          OpenVR.TrackedControllerRole.TrackedControllerRole_LeftHand,
        );
        const pose = pacer.getCachedTrackedDevicePose(index);
        if (!pose) throw new Error("Motion image probe requires a valid left controller");
        // Deliberately use the raw device transform: matches the native relative-quad
        // baseline without introducing render-model tip offsets or IR-time input.
        probeSample = {
          x: pose.matrix[12],
          anchors: { head: head.elements, "right-ray": pose.matrix },
        };
      }
      const anchors: RenderAnchors = probeSample?.anchors ?? { head: hmd.matrix };
      if (!probe) {
        for (
          const [hand, role] of [[
            "left",
            OpenVR.TrackedControllerRole.TrackedControllerRole_LeftHand,
          ], ["right", OpenVR.TrackedControllerRole.TrackedControllerRole_RightHand]] as const
        ) {
          const index = system.GetTrackedDeviceIndexForControllerRole(role);
          const pose = pacer.getCachedTrackedDevicePose(index);
          if (pose) {
            const resolved = tip.resolve(index, pose);
            setRenderHandAnchors(anchors, hand, resolved.matrix, payload.renderGripOffsets?.[hand]);
          }
        }
      }
      state.anchorSpaces = {};
      const followAnchors: Record<string, number[]> = {};
      for (const [key, freeze] of state.followFreeze) followAnchors[key] = freeze.pose;
      const followCounts: Partial<Record<string, number>> = {};
      state.resolvedAnchors = resolveRenderAnchors(
        payload,
        anchors,
        state.anchorSpaces,
        followAnchors,
        followCounts,
      );
      // A scene without items carried in a frozen frame is the worker's landed one.
      for (const [key, freeze] of state.followFreeze) {
        if (!followCounts[key] || performance.now() - freeze.at > FOLLOW_FREEZE_MAX_MS) {
          state.followFreeze.delete(key);
        }
      }
      for (const [space, matrix] of Object.entries(anchors)) {
        if (!matrix) continue;
        let dst = state.renderedAnchors[space];
        if (!dst || dst.length !== matrix.length) {
          dst = new Array<number>(matrix.length);
          state.renderedAnchors[space] = dst;
        }
        for (let i = 0; i < matrix.length; i++) dst[i] = matrix[i]!;
      }
      const useDmabufProjection = !panoramaMode && bankPool !== null && bankOverlays.length >= 2;
      const useDmabufPanorama = panoramaMode && bankPool !== null &&
        panoramaBankOverlays.length >= 2;
      const bankCount = useDmabufProjection
        ? bankOverlays.length
        : useDmabufPanorama
        ? panoramaBankOverlays.length
        : 0;
      const lastRenderedBank: number = usePipelinedPanorama && pendingPanorama
        ? pendingPanorama.bank
        : usePipelinedProjection && pendingProjection
        ? pendingProjection.bank
        : activeBank;
      const nextBank: number = bankCount >= 2 ? (lastRenderedBank + 1) % bankCount : -1;
      if (useDmabufProjection) {
        if (!renderer.selectExternalEyeBank(nextBank)) {
          throw new Error(`Invalid DMA-BUF bank index ${nextBank}`);
        }
      } else {
        if (!renderer.useEyeTargetsOtherThan([shownLeft])) {
          throw new Error("No eligible render targets");
        }
      }
      if (useDmabufPanorama) {
        if (!renderer.selectExternalOutputBank(nextBank)) {
          throw new Error(`Invalid DMA-BUF panorama bank index ${nextBank}`);
        }
      } else if (
        panoramaMode && state.panoramaTextureRotation &&
        !renderer.useOutputTargetOtherThan([shownPanorama])
      ) {
        throw new Error("No eligible panorama output targets");
      }
      const wristMarker = wrist?.marker(payload, { ...cameras, ...headsetProjections });
      const restoreWristTag = wrist?.append(payload, head);
      mark(
        "render0",
        scene?.assetVersion ?? null,
        state.receivedScenes,
        ...(timeline ? schedstat() : []),
      );
      const renderStartMs = performance.now();
      const publishedBefore = state.publishedFrames;
      let renderWork: ReturnType<typeof renderer.renderRaythreeFrame>;
      try {
        renderWork = renderer.renderRaythreeFrame(payload, {
          skipCombine: !panoramaMode,
          drawDesktopSurfaces: !panoramaMode,
          cameras,
          lookRotation,
        });
      } finally {
        restoreWristTag?.();
      }
      const renderEndMs = performance.now();
      // A frame predicted for the vsync after its sample that would only be submitted after the
      // following one shows stale poses; dropping it lets the compositor reproject instead.
      const onTime = state.dropLateFrames
        ? () => {
          const now = pacer.sampleVsyncPhase();
          return !syncPhase || !now || now.frameIndex - syncPhase.frameIndex < 2n;
        }
        : undefined;
      mark(
        "render1",
        renderWork!.textBatchRebuilds,
        renderWork!.textGeometryBuilds,
        renderWork!.batchGeometries,
        renderWork!.batchMaterials,
        renderWork!.textVerticesUploaded,
        ...(timeline ? schedstat() : []),
      );
      if (!probe && scene) inbox.markAdopted(scene);
      state.renderFrameId++;
      const renderedEyes = renderer.getEyeTextureHandles();
      state.lastRenderImages = renderedEyes
        ? { ...renderedEyes, output: renderer.getTextureHandle() }
        : null;
      if (panoramaMode) {
        const texture = renderer.getTextureHandle();
        const presenterPaced = state.panoramaPacing === "presenter";
        let published = true;
        if (vsyncPaced && syncPhase) {
          for (;;) {
            const now = pacer.sampleVsyncPhase();
            if (!now || now.frameIndex !== syncPhase.frameIndex) break;
            const remainingMs = state.panoramaPresentMinMs - now.msSinceVsync;
            if (remainingMs <= 0) break;
            await wait(remainingMs > 1.5 ? remainingMs - 1 : 0);
          }
        }
        if (useDmabufPanorama) {
          const native = nativePresenter();
          const showHandle: bigint = panoramaBankOverlays[nextBank].getHandle();
          const hideHandle = activeBank >= 0 ? panoramaBankOverlays[activeBank].getHandle() : null;
          let result;
          if (usePipelinedPanorama) {
            // 1-frame async GPU fence pipeline across 3 banks: flush this frame's bank with a
            // non-blocking fence, then wait for the PREVIOUS frame's bank (which has already had
            // ~13.3 ms to finish on the GPU in parallel with VRChat) and flip it into view.
            const fence = native.createGpuFence();
            const ready = pendingPanorama;
            pendingPanorama = { bank: nextBank, showHandle, fence };
            if (!ready) {
              published = false;
              state.lastPresent = { mode: "panorama-dmabuf-bank-prime", bank: nextBank };
            } else {
              const fin = native.waitGpuFence(ready.fence);
              if (fin.error) {
                throw new Error(`Panorama DMA-BUF async fence wait failed: ${JSON.stringify(fin)}`);
              }
              if (syncPhase && state.panoramaPresentMinMs > 0) {
                const effectivePhaseMs = (syncPhase.msSinceVsync % displayPeriodMs) +
                  (performance.now() - sampleMs);
                const remainingMs = state.panoramaPresentMinMs - effectivePhaseMs;
                if (remainingMs > 0) {
                  await wait(remainingMs);
                }
              }
              const flipHide = activeBank >= 0 && activeBank !== ready.bank
                ? panoramaBankOverlays[activeBank].getHandle()
                : null;
              result = native.flipPanoramaBank(ready.showHandle, flipHide, onTime);
              state.lastPresent = { mode: "panorama-dmabuf-bank-pipelined", bank: ready.bank, ...result };
              if ("dropped" in result && result.dropped) {
                state.droppedLateFrames++;
                published = false;
              } else if (result.waitResult === OpenVR.OverlayError.VROverlayError_TimedOut) {
                state.waitTimeouts++;
                published = false;
              } else if (result.error) {
                throw new Error(`Panorama DMA-BUF bank flip failed: ${JSON.stringify(result)}`);
              } else {
                activeBank = ready.bank;
              }
            }
          } else {
            if (vsyncLocked) {
              // Wait for the GPU fence first; only hold after it if we finished before the
              // compositor's safe latch window (`panoramaPresentMinMs`), so slow GPU frames
              // flip immediately instead of adding hold time on top of GPU latency.
              const fin = native.finishGpuFence();
              if (fin.error) {
                throw new Error(`Panorama DMA-BUF fence wait failed: ${JSON.stringify(fin)}`);
              }
              if (syncPhase && state.panoramaPresentMinMs > 0) {
                const effectivePhaseMs = (syncPhase.msSinceVsync % displayPeriodMs) +
                  (performance.now() - sampleMs);
                const remainingMs = state.panoramaPresentMinMs - effectivePhaseMs;
                if (remainingMs > 0) {
                  await wait(remainingMs);
                }
              }
              result = native.flipPanoramaBank(
                showHandle,
                activeBank !== nextBank ? hideHandle : null,
                onTime,
              );
            } else {
              result = native.presentPanoramaBank(
                showHandle,
                activeBank !== nextBank ? hideHandle : null,
                presenterPaced,
                onTime,
              );
            }
            state.lastPresent = { mode: "panorama-dmabuf-bank", bank: nextBank, ...result };
            if ("dropped" in result && result.dropped) {
              state.droppedLateFrames++;
              published = false;
            } else if (result.waitResult === OpenVR.OverlayError.VROverlayError_TimedOut) {
              state.waitTimeouts++;
              published = false;
            } else if (result.error) {
              throw new Error(`Panorama DMA-BUF bank flip failed: ${JSON.stringify(result)}`);
            } else {
              activeBank = nextBank;
            }
          }
        } else {
          if (!panoramaReady) {
            panorama.initialize(texture, {
              key: `${overlayKey}.panorama`,
              name: `${overlayName} (panorama)`,
              widthInMeters: options.overlayWidthInMeters,
              distance: dashboardVisible ? 100 : normalPanoramaDistance,
              mode: "stereo-panorama",
              sortOrder: dashboardVisible ? 0 : 1,
              attachToHmd: true,
              flipVertical: false,
            });
            panoramaReady = true;
          }
          panorama.setTextureHandle(texture);
          if (presenterPaced) {
            const native = nativePresenter();
            const result = native.presentTexture(panorama.getHandle(), texture, onTime);
            state.lastPresent = { mode: "panorama-presenter", ...result };
            if ("dropped" in result && result.dropped) {
              state.droppedLateFrames++;
              published = false;
            } else if (result.waitResult === OpenVR.OverlayError.VROverlayError_TimedOut) {
              state.waitTimeouts++;
              published = false;
            } else if (result.error) {
              throw new Error(`Panorama publication failed: ${JSON.stringify(result)}`);
            }
          } else if (!panorama.present()) throw new Error("Panorama texture rejected");
          else state.lastPresent = { mode: "panorama", texture };
        }
        const presentPhase = pacer.sampleVsyncPhase();
        const presented = (presenterPaced || useDmabufPanorama)
          ? state.lastPresent as { gpuFinishMs?: number; waitMs?: number; publicationMs?: number }
          : {};
        mark(
          published ? "present" : "drop",
          presentPhase ? Number(presentPhase.frameIndex) : null,
          presentPhase?.msSinceVsync,
          presented.gpuFinishMs,
          presented.waitMs,
          presented.publicationMs,
          published ? 0 : -1,
        );
        if (published && syncPhase && presentPhase) {
          panoramaPhase.push([
            syncPhase.msSinceVsync,
            presentPhase.msSinceVsync,
            Number(presentPhase.frameIndex - syncPhase.frameIndex),
            pacer.getLastPredictedSecondsToPhotons() * 1000,
          ]);
          if (panoramaPhase.length > 600) panoramaPhase.shift();
        }
        if (published) {
          shownPanorama = texture;
          state.publishedFrames++;
        }
      } else if (useDmabufProjection) {
        const native = nativePresenter();
        const showHandles: readonly [bigint, bigint] = bankOverlays[nextBank].getHandles();
        if (usePipelinedProjection) {
          // 1-frame async GPU fence pipeline across 3 projection banks: flush this frame's bank
          // with a non-blocking fence + saved cameras, then wait for the previous frame's bank
          // (already ~13.3 ms in flight on the GPU) and flip its poses + visibility into view.
          const fence = native.createGpuFence();
          const camBuf = pendingProjectionCameras[pendingProjectionCamSlot];
          pendingProjectionCamSlot ^= 1;
          camBuf.leftEyeViewMatrix.set(cameras.leftEyeViewMatrix);
          camBuf.rightEyeViewMatrix.set(cameras.rightEyeViewMatrix);
          camBuf.leftEyeProjectionMatrix.set(cameras.leftEyeProjectionMatrix);
          camBuf.rightEyeProjectionMatrix.set(cameras.rightEyeProjectionMatrix);
          const ready = pendingProjection;
          pendingProjection = { bank: nextBank, showHandles, fence, cameras: camBuf };
          if (!ready) {
            state.lastPresent = { mode: "projection-dmabuf-bank-prime", bank: nextBank };
          } else {
            const fin = native.waitGpuFence(ready.fence);
            if (fin.error) {
              throw new Error(`Projection DMA-BUF async fence wait failed: ${JSON.stringify(fin)}`);
            }
            if (syncPhase && state.panoramaPresentMinMs > 0) {
              const effectivePhaseMs = (syncPhase.msSinceVsync % displayPeriodMs) +
                (performance.now() - sampleMs);
              const remainingMs = state.panoramaPresentMinMs - effectivePhaseMs;
              if (remainingMs > 0) {
                await wait(remainingMs);
              }
            }
            const hideHandles = activeBank >= 0 && activeBank !== ready.bank
              ? bankOverlays[activeBank].getHandles()
              : null;
            const result = native.flipProjectionBank(
              ready.showHandles,
              hideHandles,
              ready.cameras,
              onTime,
            );
            state.lastPresent = {
              mode: "projection-dmabuf-bank-pipelined",
              bank: ready.bank,
              ...result,
            };
            const dropped = "dropped" in result && result.dropped;
            if (dropped) state.droppedLateFrames++;
            const phase = timeline ? pacer.sampleVsyncPhase() : null;
            mark(
              dropped ? "drop" : "present",
              phase ? Number(phase.frameIndex) : null,
              phase?.msSinceVsync,
              result.gpuFinishMs,
              result.waitMs,
              result.publicationMs,
              result.waitResult,
            );
            if (dropped) { /* compositor keeps reprojecting the previously visible bank */ }
            else if (result.waitResult === OpenVR.OverlayError.VROverlayError_TimedOut) {
              state.waitTimeouts++;
            } else if (result.error) {
              throw new Error(
                `DMA-BUF bank projection publication failed: ${JSON.stringify(result)}`,
              );
            } else {
              activeBank = ready.bank;
              state.publishedFrames++;
            }
          }
        } else {
          const hideHandles = activeBank >= 0 && activeBank !== nextBank
            ? bankOverlays[activeBank].getHandles()
            : null;
          const result = native.presentProjectionBank(showHandles, hideHandles, cameras, onTime);
          state.lastPresent = { mode: "projection-dmabuf-bank", bank: nextBank, ...result };
          const dropped = "dropped" in result && result.dropped;
          if (dropped) state.droppedLateFrames++;
          const phase = timeline ? pacer.sampleVsyncPhase() : null;
          mark(
            dropped ? "drop" : "present",
            phase ? Number(phase.frameIndex) : null,
            phase?.msSinceVsync,
            result.gpuFinishMs,
            result.waitMs,
            result.publicationMs,
            result.waitResult,
          );
          if (dropped) { /* compositor keeps reprojecting the previously visible bank */ }
          else if (result.waitResult === OpenVR.OverlayError.VROverlayError_TimedOut) {
            state.waitTimeouts++;
          } else if (result.error) {
            throw new Error(`DMA-BUF bank projection publication failed: ${JSON.stringify(result)}`);
          } else {
            activeBank = nextBank;
            state.publishedFrames++;
          }
        }
      } else {
        const textures = renderer.getEyeTextureHandles();
        if (!textures) throw new Error("Missing eye targets");
        const native = nativePresenter();
        const result = native.present(overlays.getHandles(), textures, cameras, onTime);
        state.lastPresent = result;
        const dropped = "dropped" in result && result.dropped;
        if (dropped) state.droppedLateFrames++;
        const phase = timeline ? pacer.sampleVsyncPhase() : null;
        mark(
          dropped ? "drop" : "present",
          phase ? Number(phase.frameIndex) : null,
          phase?.msSinceVsync,
          result.gpuFinishMs,
          result.waitMs,
          result.publicationMs,
          result.waitResult,
        );
        if (dropped) { /* the compositor keeps reprojecting the previous frame */ }
        else if (result.waitResult === OpenVR.OverlayError.VROverlayError_TimedOut) {
          state.waitTimeouts++;
        } else if (result.error) {
          throw new Error(`Projection publication failed: ${JSON.stringify(result)}`);
        } else {
          shownLeft = textures.left;
          state.publishedFrames++;
        }
      }
      if (workProbe && workRows.length < 2000) {
        workRows.push({
          sceneVersion: state.sceneVersion,
          freezeScene: state.freezeScene,
          sampleMs,
          publicationEndMs: performance.now(),
          renderStartMs,
          renderEndMs,
          decodeMs: state.lastDecodeMs,
          packetBase64Bytes: state.lastPacketBytes,
          receivedScenes: state.receivedScenes,
          ...renderWork!,
        });
      }
      if (wrist && wrist.rows.length < 10000) {
        const phase = pacer.sampleVsyncPhase();
        wrist.rows.push({
          generation: wrist.generation,
          sampleMonotonicSeconds,
          publicationMonotonicSeconds: probeClock?.now(),
          predictionMs,
          marker: wristMarker,
          head: head.toArray(),
          leftProjection: Array.from(headsetProjections.leftEyeProjectionMatrix),
          sourceLeftProjection: Array.from(cameras.leftEyeProjectionMatrix),
          sampleVsync: syncPhase ? String(syncPhase.frameIndex) : null,
          samplePhaseMs: syncPhase?.msSinceVsync,
          publicationVsync: phase ? String(phase.frameIndex) : null,
          publicationPhaseMs: phase?.msSinceVsync,
          renderStartMs,
          renderEndMs,
          published: state.publishedFrames > publishedBefore,
          textures: state.lastRenderImages,
        });
      }
      if (probe && probeRows.length < 10000) {
        const endPhase = pacer.sampleVsyncPhase();
        probeRows.push({
          generation: probeGeneration,
          hmdActivity: system.GetTrackedDeviceActivityLevel(OpenVR.k_unTrackedDeviceIndex_Hmd),
          sampleVsync: syncPhase ? String(syncPhase.frameIndex) : null,
          samplePhaseMs: syncPhase?.msSinceVsync,
          publicationVsync: endPhase ? String(endPhase.frameIndex) : null,
          publicationPhaseMs: endPhase?.msSinceVsync,
          mode: activeMode,
          pacing: panoramaMode ? state.panoramaPacing : "presenter",
          sampleMs,
          sampleMonotonicSeconds,
          publicationMonotonicSeconds: probeClock?.now(),
          elapsedMs: sampleMs - probeStartMs,
          predictionMs,
          targetMs: sampleMs - probeStartMs + predictionMs,
          x: probeSample!.x,
          renderStartMs,
          renderEndMs,
          publicationEndMs: performance.now(),
          published: state.publishedFrames > publishedBefore,
          textures: state.lastRenderImages,
          present: state.lastPresent,
        });
      }
      if (state.webxrTarget && performance.now() - lastReportAt > 500) {
        mark("status");
        PostMan.PostMessage({
          target: state.webxrTarget!,
          type: "OVERLAYRENDERSTATUS",
          payload: { actorId: state.id, status: health() },
        });
        lastReportAt = performance.now();
      }
      mark("yield", ...(timeline ? schedstat() : []));
      await wait(0);
      mark("resume", ...(timeline ? schedstat() : []));
    }
  } finally {
    if (registered && state.webxrTarget) {
      PostMan.PostMessage({
        target: state.webxrTarget,
        type: "UNREGISTERWEBXRVIEW",
        payload: { actorId: state.id },
      });
    }
    registered = false;
    motionProbe = null;
    wristProbe = null;
    state.wristMotionProbe = false;
    probeClock?.close();
    probeClock = null;
    state.motionProbe = false;
    latest = null;
    teardownDmabufBanks();
    overlays?.cleanup();
    panorama?.cleanup();
    presenter?.close();
    renderer?.cleanup();
    // This child owns all native dependants; avoid the known Linux library-teardown race.
    runtime.deferReleaseToProcessExit();
  }
}
