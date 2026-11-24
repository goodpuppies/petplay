#!/usr/bin/env -S deno run -A
/**
 * VRChat depth intake (`markdown/vrchat-depth/README.md`): captures VRChat's desktop window,
 * decodes the debug avatar's depth block and forwards each new VRChat frame to `webxr` as
 * `VRCDEPTHFRAME` (camera pose, the wearer's viewpoint, projection, a downsampled depth grid).
 *
 * Runs as its own process (`{ worker: "process" }`): a decode costs ~25 ms per 1920×1000 frame
 * and must not stall the scene. Off until `STARTVRCDEPTH`.
 */
import { type ActorId, actorState, PostMan, System } from "../submodules/stageforge/mod.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import { depthFrameToWire, WindowDepthDecoder } from "../classes/vrchatDepth/windowDecoder.ts";
import { VrchatWindowStream, type WindowFrame } from "../classes/vrchatDepth/windowStream.ts";
import type { WindowStreamStatus } from "../classes/vrchatDepth/windowStream.ts";
import { VrchatScaleTracker } from "../classes/vrchatDepth/vrchatScale.ts";
import { type VrcDepthFramePayload, type VrcDepthStatus } from "../classes/vrchatDepth/wire.ts";
import {
  BlockCalibration,
  type CalibrationMode,
  type CalibrationPolicy,
  MODE_LAYOUT,
} from "../classes/vrchatDepth/blockCalibration.ts";
import { AvatarBlockLink, DEFAULT_LAYOUT, WorldWatcher } from "../classes/vrchatDepth/blockLayout.ts";
import {
  type BlockFit,
  fitBlock,
  probeFit,
  sameFit,
  type Size,
  windowScale,
} from "../classes/vrchatDepth/blockFit.ts";

/** Depth grid side sent to webxr: enough for a debug mesh, small enough for JSON transport. */
const DEFAULT_GRID = 128;
const RATE_WINDOW_MS = 2000;

/** Kept outside `actorState`, which does not preserve class instances. */
const scaleTracker = new VrchatScaleTracker();
const debugViews = new Set<ActorId>();
const decoder = new WindowDepthDecoder();
let externalOwner: string | null = null;
/** webxr's request (`VRCDEPTHWANTS`): colours are sent only while its debug mesh or scan use them. */
let wantColors = true;
/**
 * Who holds the lease, by priority: a higher claim takes it from a lower one. The debug view (3)
 * captures for itself; the headset source (2, webxr's `headsetDepthSource.ts`) decodes where it
 * draws; the GPU helper (1) captures for VR when neither does.
 */
const LEASE_RANK = { helper: 1, headset: 2, view: 3 } as const;
let externalRank = 0;
/** The headset source was heard from (claim or heartbeat): no helper is needed meanwhile. */
let headsetSeenAt = 0;
const HEADSET_ALIVE_MS = 3000;
let preemptions = 0;
/**
 * VR's capture without the debug view: a hidden `desktopView` in `captureOnly` mode whose GL
 * context binds VRChat's window as a texture (`gpuDepthSource.ts`, ~2.5 ms CPU per frame) instead
 * of ffmpeg plus a full-window CPU decode here (~22 ms). It claims the lease in the background.
 */
const gpuHelper = { actor: null as ActorId | null, starting: null as Promise<void> | null, lastError: null as string | null };
let externalSeenAt = 0;
let externalStatus: WindowStreamStatus | null = null;
let leaseTimer: ReturnType<typeof setInterval> | null = null;
/** Silence after which a lease expires, and the owner whose lease expired last. */
const LEASE_MS = 4000;
let expiredOwner: string | null = null;
let expiredRank = 0;
/** Lease diagnostics: expiries, the silence that caused the last, re-grants, this process's stalls. */
const lease = { expiries: 0, lastSilenceMs: 0, lastExpiredAt: 0, regrants: 0, maxStallMs: 0 };
let lastStallCheck = 0;
let captureEnabled = false;
/** Self-calibration: block colour mode from decode health, layout re-asserted when lost. */
const calibration = new BlockCalibration();
const blockLink = new AvatarBlockLink();
const worlds = new WorldWatcher();
let calibrationTimer: ReturnType<typeof setInterval> | null = null;
let capturingSince = 0;
let layoutAssertedAt = -Infinity;
let layoutReason: string | null = null;
/** No decoded frame for this long while capturing: send the whole layout again. */
const LOST_BLOCK_MS = 10_000;
const REASSERT_EVERY_MS = 30_000;
/**
 * The block's size for VRChat's camera and window (`blockFit.ts`): cell size, grid width, depth
 * plane. Refit from the camera size in decoded headers and the captured window's size; while
 * nothing decodes, probed with ever bigger cells (`probeFit`).
 */
let fit: BlockFit = {
  cellPx: DEFAULT_LAYOUT.cellPx,
  gridWidth: DEFAULT_LAYOUT.gridWidth,
  depthSize: DEFAULT_LAYOUT.depthSize,
};
let probeStep = 0;
/** VRChat's camera render size from the latest decoded header (`screenWidth/Height`). */
let cameraSize: Size | null = null;
/** A refit waits this long after the last layout change: the avatar takes a while to apply it. */
const FIT_SETTLE_MS = 15_000;

/** The captured VRChat window's size, from whichever capture is running. */
function captureWindow(): Size | null {
  const window = externalStatus?.window ?? state.stream?.status().window ?? null;
  return window && window.width > 0 && window.height > 0 ? window : null;
}

/** The block fit for `mode` at the current camera and window, when both are known. */
function currentFit(mode: CalibrationMode): BlockFit | null {
  const window = captureWindow();
  if (!cameraSize || !window) return null;
  return fitBlock(cameraSize, windowScale(cameraSize, window), MODE_LAYOUT[mode]);
}

function assertLayout(mode: CalibrationMode, reason: string): void {
  layoutAssertedAt = Date.now();
  layoutReason = reason;
  fit = currentFit(mode) ?? fit;
  void blockLink.send({
    ...DEFAULT_LAYOUT,
    ...MODE_LAYOUT[mode],
    ...fit,
  }).catch((error) => (layoutReason = `${reason}: ${error}`));
}

function calibrationTick(): void {
  if (!captureEnabled) return;
  announceToWebxr();
  const now = Date.now();
  if (worlds.poll()) {
    const mode = calibration.worldChanged(now);
    if (mode) assertLayout(mode, `new world ${worlds.world}`);
  }
  const mode = calibration.observe(now, state.decoded, state.failures);
  if (mode) assertLayout(mode, calibration.reason);
  const lastFrame = Math.max(state.lastFrameAt ?? 0, capturingSince);
  if (now - lastFrame > LOST_BLOCK_MS && now - layoutAssertedAt > REASSERT_EVERY_MS) {
    // Nothing decodes: perhaps VRChat's window shrinks the block below a pixel a cell. Walk the
    // probe's cell sizes (the camera size is unknown until a header decodes).
    const window = captureWindow();
    if (window) {
      cameraSize = null;
      fit = probeFit(window, probeStep++, MODE_LAYOUT[calibration.mode]);
    }
    assertLayout(calibration.mode, `no block decoded${window ? ` (probe ${probeStep}: ${fitLabel(fit)})` : ""}`);
    return;
  }
  if (now - (state.lastFrameAt ?? 0) < LOST_BLOCK_MS) probeStep = 0;
  const want = currentFit(calibration.mode);
  if (want && !sameFit(want, fit) && now - layoutAssertedAt > FIT_SETTLE_MS) {
    assertLayout(calibration.mode, `fit ${fitLabel(want)} for camera ${cameraSize!.width}x${
      cameraSize!.height
    } in window ${captureWindow()!.width}x${captureWindow()!.height}`);
  }
}

function fitLabel(f: BlockFit): string {
  return `${f.cellPx} px cells, ${f.gridWidth} wide, ${f.depthSize}² depth`;
}

/** The camera render size a decoded header reports. */
function noteCameraSize(width: number | undefined, height: number | undefined): void {
  if (width && height && width > 0 && height > 0) {
    cameraSize = { width: Math.round(width), height: Math.round(height) };
  }
}

function startGpuHelper(): void {
  if (gpuHelper.actor || gpuHelper.starting) return;
  gpuHelper.starting = (async () => {
    const actor = await PostMan.create("./desktopView.ts", import.meta.url, { worker: "process" });
    if (!captureEnabled) {
      await PostMan.shutdown(actor);
      return;
    }
    gpuHelper.actor = actor as ActorId;
    gpuHelper.lastError = null;
    PostMan.PostMessage({
      target: actor,
      type: "STARTDESKTOPVIEW",
      payload: { captureOnly: true, gpuCapture: true, depthTarget: state.id, title: "PetPlay depth capture" },
    });
    LogChannel.log("actor", `[vrchatDepth] GPU capture helper ${actor}`);
  })().catch((error) => {
    gpuHelper.lastError = String(error);
    LogChannel.error("actor", `[vrchatDepth] GPU capture helper failed: ${gpuHelper.lastError}`);
  }).finally(() => (gpuHelper.starting = null));
}

async function stopGpuHelper(): Promise<void> {
  await gpuHelper.starting;
  const actor = gpuHelper.actor;
  gpuHelper.actor = null;
  if (!actor) return;
  await PostMan.PostMessage({ target: actor, type: "STOPDESKTOPVIEW", payload: null }, true)
    .catch(() => {});
  await PostMan.shutdown(actor).catch((error) =>
    LogChannel.error("actor", `[vrchatDepth] GPU capture helper shutdown: ${error}`)
  );
}

function startLocalCapture(): void {
  if (!captureEnabled || externalOwner || state.stream) return;
  state.stream = new VrchatWindowStream(onFrame);
  state.stream.start();
}

function startLeaseTimer(): void {
  if (leaseTimer) clearInterval(leaseTimer);
  lastStallCheck = Date.now();
  leaseTimer = setInterval(() => {
    const now = Date.now();
    // This timer runs once a second: a longer gap is this process stalling.
    lease.maxStallMs = Math.max(lease.maxStallMs, now - lastStallCheck - 1000);
    lastStallCheck = now;
    if (!externalOwner || now - externalSeenAt <= LEASE_MS) return;
    lease.expiries++;
    lease.lastSilenceMs = now - externalSeenAt;
    lease.lastExpiredAt = now;
    LogChannel.log("actor", `[vrchatDepth] capture lease of ${externalOwner} expired after ${lease.lastSilenceMs} ms of silence`);
    expiredOwner = externalOwner;
    expiredRank = externalRank;
    releaseCapture(externalOwner);
  }, 1000);
}

/**
 * Whether `owner` holds the lease. A lease that expired over a stall (here or in the relay; queued
 * heartbeats arrive after the expiry timer) goes back to its owner when it is heard from again and
 * nobody else claimed it, instead of dropping the view to its slow path.
 */
function holdsLease(owner: string): boolean {
  if (externalOwner === owner) return true;
  if (externalOwner !== null || owner !== expiredOwner) return false;
  externalOwner = owner;
  externalRank = expiredRank;
  expiredOwner = null;
  lease.regrants++;
  LogChannel.log("actor", `[vrchatDepth] capture lease re-granted to ${owner} after a stall`);
  const stream = state.stream;
  state.stream = null;
  void stream?.stop();
  startLeaseTimer();
  return true;
}

function releaseCapture(owner: string): boolean {
  if (externalOwner !== owner) return false;
  const rank = externalRank;
  externalOwner = null;
  externalRank = 0;
  externalStatus = null;
  if (leaseTimer) clearInterval(leaseTimer);
  leaseTimer = null;
  if (rank === LEASE_RANK.headset) headsetSeenAt = 0;
  // A live headset source claims again within seconds and needs neither fallback.
  if (Date.now() - headsetSeenAt < HEADSET_ALIVE_MS) return true;
  startLocalCapture();
  if (captureEnabled) startGpuHelper();
  return true;
}

/** Tells webxr who the intake is, whether depth runs, and VRChat's playspace scale. */
function announceToWebxr(): void {
  if (!state.webxr) return;
  PostMan.PostMessage({
    target: state.webxr,
    type: "VRCDEPTHINTAKE",
    payload: { intake: state.id, running: captureEnabled },
  });
  PostMan.PostMessage({
    target: state.webxr,
    type: "VRCDEPTHSCALE",
    payload: { worldScale: scaleTracker.scale() },
  });
}

const state = actorState({
  name: "vrchat-depth",
  webxr: null as ActorId | null,
  stream: null as VrchatWindowStream | null,
  grid: DEFAULT_GRID,
  decoded: 0,
  decodeMs: 0,
  lastFailure: null as string | null,
  failures: {} as Record<string, number>,
  repeats: 0,
  lastFrameAt: null as number | null,
  frameTimes: [] as number[],
});

function status(): VrcDepthStatus {
  const stream = externalStatus ?? state.stream?.status();
  const now = Date.now();
  const recent = state.frameTimes.filter((t) => now - t < RATE_WINDOW_MS);
  return {
    running: state.stream != null || externalOwner != null,
    window: stream?.window ?? null,
    windowFrames: stream?.frames ?? 0,
    decoded: state.decoded,
    framesPerSecond: recent.length / (RATE_WINDOW_MS / 1000),
    decodeMs: state.decodeMs,
    lastFailure: state.lastFailure,
    failures: { ...state.failures },
    repeats: state.repeats,
    lastError: stream?.lastError ?? null,
    lastFrameAt: state.lastFrameAt,
    scale: {
      worldScale: scaleTracker.scale(),
      avatarEyeHeight: scaleTracker.avatarEyeHeight,
      realEyeHeight: scaleTracker.realEyeHeight,
      realEyeHeightOverride: scaleTracker.realEyeHeightOverride,
      lastError: scaleTracker.lastError,
    },
    calibration: {
      ...calibration.status(now),
      world: worlds.world,
      layoutAssertedAt: Number.isFinite(layoutAssertedAt) ? layoutAssertedAt : null,
      layoutReason,
      fit,
      cameraSize,
      window: captureWindow(),
    },
    lease: {
      owner: externalOwner,
      background: externalOwner != null && externalRank < LEASE_RANK.view,
      kind: (Object.keys(LEASE_RANK) as (keyof typeof LEASE_RANK)[])
        .find((k) => LEASE_RANK[k] === externalRank) ?? null,
      preemptions,
      ...lease,
    },
    gpuHelper: { actor: gpuHelper.actor, lastError: gpuHelper.lastError },
    pid: Deno.pid,
  };
}

function onFrame(frame: WindowFrame): void {
  decoder.grid = state.grid;
  const raw = decoder.decode(frame);
  state.decodeMs = decoder.decodeMs;
  state.lastFailure = decoder.lastFailure;
  state.failures = { ...decoder.failures };
  state.repeats = decoder.repeats;
  if (raw) acceptFrame(depthFrameToWire(raw, scaleTracker.scale(), { colors: wantColors }));
}
function acceptFrame(payload: VrcDepthFramePayload): void {
  state.decoded++;
  noteCameraSize(payload.header.screenWidth, payload.header.screenHeight);
  state.lastFrameAt = payload.receivedAt;
  state.frameTimes.push(payload.receivedAt);
  while (state.frameTimes.length && payload.receivedAt - state.frameTimes[0] > RATE_WINDOW_MS) {
    state.frameTimes.shift();
  }
  payload.worldScale = scaleTracker.scale();
  payload.source = state.id;
  if (!wantColors) payload.colorBase64 = null;
  if (state.webxr) PostMan.PostMessage({ target: state.webxr, type: "VRCDEPTHFRAME", payload });
  for (const target of debugViews) {
    PostMan.PostMessage({ target, type: "VRCDEPTHDEBUGSOURCE", payload });
  }
}

async function stop(): Promise<VrcDepthStatus> {
  captureEnabled = false;
  await stopGpuHelper();
  externalOwner = null;
  externalRank = 0;
  externalStatus = null;
  if (leaseTimer) clearInterval(leaseTimer);
  leaseTimer = null;
  const stream = state.stream;
  state.stream = null;
  await stream?.stop();
  scaleTracker.stop();
  if (calibrationTimer) clearInterval(calibrationTimer);
  calibrationTimer = null;
  state.frameTimes = [];
  if (state.webxr) {
    PostMan.PostMessage({ target: state.webxr, type: "VRCDEPTHSTOPPED", payload: null });
  }
  return status();
}

new PostMan(
  state,
  {
    __INIT__: (_payload: void) => {},
    __SHUTDOWN__: async (_payload: unknown) => {
      await stop();
    },
    __HEALTH__: (_payload: unknown) => status(),
    ASSIGNWEBXR: (payload: ActorId) => {
      state.webxr = payload;
      announceToWebxr();
    },
    /** Starts the window capture; `grid` sets the depth grid side sent to webxr (16..512). */
    /** `gpuCapture: false` keeps VR on the ffmpeg path instead of the GPU helper. */
    STARTVRCDEPTH: (payload: { grid?: number; gpuCapture?: boolean } | null) => {
      if (payload?.grid) state.grid = Math.max(16, Math.min(512, Math.round(payload.grid)));
      scaleTracker.start();
      captureEnabled = true;
      capturingSince = Date.now();
      worlds.poll(); // skip the log so far: only worlds entered from now on count as changes
      calibrationTimer ??= setInterval(calibrationTick, 1000);
      startLocalCapture();
      if (payload?.gpuCapture !== false && Date.now() - headsetSeenAt >= HEADSET_ALIVE_MS) {
        startGpuHelper();
      }
      announceToWebxr();
      return status();
    },
    /** The wearer's real eye height in metres, replacing the estimate from VRChat's PlayerHeight. */
    SETVRCDEPTHREALEYEHEIGHT: (payload: { meters: number | null }) => {
      scaleTracker.realEyeHeightOverride = payload.meters && payload.meters > 0
        ? payload.meters
        : null;
      return status();
    },
    STOPVRCDEPTH: async (_payload: void) => await stop(),
    /** Block colour calibration: "auto" (default) picks by decode health; "1d"/"3d" fix it. */
    SETVRCDEPTHCALIBRATION: (payload: { policy: CalibrationPolicy }) => {
      if (!["auto", "1d", "3d"].includes(payload.policy)) throw new Error("policy: auto|1d|3d");
      const mode = calibration.setPolicy(payload.policy, Date.now());
      assertLayout(mode, `policy ${payload.policy}`);
      return status();
    },
    GETVRCDEPTHSTATUS: (_payload: void) => status(),
    VRCDEPTHWANTS: (payload: { colors?: boolean }) => {
      if (typeof payload?.colors === "boolean") wantColors = payload.colors;
    },
    /**
     * `headset`: webxr's headset source; `background` without it: the GPU helper; neither: the
     * debug view. A higher claim takes the lease (`LEASE_RANK`).
     */
    CLAIMDEPTHCAPTURE: async (payload: { owner: string; background?: boolean; headset?: boolean }) => {
      const rank = payload.headset ? LEASE_RANK.headset
        : payload.background ? LEASE_RANK.helper
        : LEASE_RANK.view;
      if (rank === LEASE_RANK.headset) headsetSeenAt = Date.now();
      if (externalOwner && externalOwner !== payload.owner) {
        if (rank <= externalRank) throw new Error("depth capture already owned");
        // The previous owner hears `false` on its next heartbeat and claims again later.
        preemptions++;
        LogChannel.log("actor", `[vrchatDepth] ${payload.owner} takes the capture from ${externalOwner}`);
      }
      externalOwner = payload.owner;
      externalRank = rank;
      // The headset source captures for VR itself: the helper isn't needed while it lives.
      if (rank === LEASE_RANK.headset) void stopGpuHelper();
      expiredOwner = null;
      externalSeenAt = Date.now();
      const stream = state.stream;
      state.stream = null;
      await stream?.stop();
      startLeaseTimer();
      return { grid: state.grid };
    },
    RELEASEDEPTHCAPTURE: (payload: { owner: string }) => releaseCapture(payload.owner),
    EXTERNALDEPTHHEARTBEAT: (
      payload: {
        owner: string;
        stream: WindowStreamStatus;
        metrics: {
          decodeMs: number;
          lastFailure: string | null;
          failures: Record<string, number>;
          repeats: number;
          /** The headset source decodes itself: its count and last frame feed calibration. */
          decoded?: number;
          lastFrameAt?: number | null;
          /** The latest decoded header's camera render size. */
          camera?: Size | null;
        };
      },
    ) => {
      if (!holdsLease(payload.owner)) return false;
      externalSeenAt = Date.now();
      if (externalRank === LEASE_RANK.headset) headsetSeenAt = externalSeenAt;
      externalStatus = payload.stream;
      noteCameraSize(payload.metrics.camera?.width, payload.metrics.camera?.height);
      Object.assign(state, payload.metrics);
      return true;
    },
    EXTERNALDEPTHFRAME: (payload: { owner: string; frame: VrcDepthFramePayload }) => {
      if (!holdsLease(payload.owner)) return false;
      externalSeenAt = Date.now();
      acceptFrame(payload.frame);
      return { colors: wantColors };
    },
    REGISTERDEPTHDEBUGVIEW: (payload: { actorId: ActorId }) => {
      debugViews.add(payload.actorId);
      return true;
    },
    UNREGISTERDEPTHDEBUGVIEW: (payload: { actorId: ActorId }) => {
      debugViews.delete(payload.actorId);
      return true;
    },
  } as const,
);
