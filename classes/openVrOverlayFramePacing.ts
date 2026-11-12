/**
 * OpenVR **overlay** frame timing and predicted poses (Aardvark
 * `CVRManager::updateOpenVrPoses` in `vrmanager.cpp`):
 * - Do **not** use `IVRCompositor::WaitGetPoses` in overlay apps.
 * - Wait on a new display frame with `GetTimeSinceLastVsync` + frame index, then
 *   call `GetDeviceToAbsoluteTrackingPose` with
 *   `frameDuration - secondsSinceLastVsync + secondsFromVsyncToPhotons`.
 */
import { playspaceFrame } from "./playspaceFrame.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { WEBXR_CRASH_ON_DROP_WARMUP_FRAMES } from "./webxrCrashOnDrop.ts";
import { FpsCounter } from "./fpsCounter.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";

const MAX_VSYNC_POLLS = 2_000_000;
/**
 * The vsync index stops advancing while SteamVR is in standby (headset off the head). Spinning
 * until it moves kept a core at 100% for as long as the headset sat idle, so one spin gives up
 * after this many frame periods.
 */
const VSYNC_SPIN_LIMIT_FRAMES = 2;
/**
 * Only an index this long without moving is standby, and pacing then idles on a timer until it
 * moves. Over Steam Link the index advances at the scene app's rate, not the display's: with
 * VRChat at ~30 fps, 30-60 ms gaps are routine, and the old two-frame (28 ms at 72 Hz) threshold
 * took them for standby and slept 100 ms, over and over.
 */
const VSYNC_STALL_MS = 500;
const VSYNC_STALLED_POLL_MS = 100;
/** While the index is late, poll it on timers this far apart instead of spinning a core. */
const VSYNC_LATE_POLL_MS = 1;
const DEFAULT_VSYNC_SPIN_TAIL_MS = 1.0;
// A 72 Hz headset has a 13.9 ms frame. Capping the coarse yield at 4 ms meant
// that finishing early in a frame skipped the yield entirely and hammered
// GetTimeSinceLastVsync through FFI for most of the remaining interval. Keep a
// generous corruption guard while allowing a complete ordinary HMD interval.
const MAX_VSYNC_COARSE_YIELD_MS = 50.0;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function matrix3x4RowsToQuaternion(
  m: [
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
  ],
  target: [number, number, number, number] = [0, 0, 0, 1],
): [number, number, number, number] {
  const m00 = m[0][0], m01 = m[0][1], m02 = m[0][2];
  const m10 = m[1][0], m11 = m[1][1], m12 = m[1][2];
  const m20 = m[2][0], m21 = m[2][1], m22 = m[2][2];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1.0) * 2;
    target[0] = (m21 - m12) / s;
    target[1] = (m02 - m20) / s;
    target[2] = (m10 - m01) / s;
    target[3] = 0.25 * s;
    return target;
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1.0 + m00 - m11 - m22) * 2;
    target[0] = 0.25 * s;
    target[1] = (m01 + m10) / s;
    target[2] = (m02 + m20) / s;
    target[3] = (m21 - m12) / s;
    return target;
  }
  if (m11 > m22) {
    const s = Math.sqrt(1.0 + m11 - m00 - m22) * 2;
    target[0] = (m01 + m10) / s;
    target[1] = 0.25 * s;
    target[2] = (m12 + m21) / s;
    target[3] = (m02 - m20) / s;
    return target;
  }
  const s = Math.sqrt(1.0 + m22 - m00 - m11) * 2;
  target[0] = (m02 + m20) / s;
  target[1] = (m12 + m21) / s;
  target[2] = 0.25 * s;
  target[3] = (m10 - m01) / s;
  return target;
}

function readHmdFloatProp(
  vr: OpenVR.IVRSystem,
  prop: OpenVR.TrackedDeviceProperty,
): number | null {
  const errBuf = new Int32Array(1);
  const pErr = Deno.UnsafePointer.of(errBuf) as
    | Deno.PointerValue<OpenVR.TrackedPropertyError>
    | null;
  if (pErr == null) {
    return null;
  }
  const v = vr.GetFloatTrackedDeviceProperty(
    OpenVR.k_unTrackedDeviceIndex_Hmd,
    prop,
    pErr,
  );
  if (errBuf[0] !== OpenVR.TrackedPropertyError.TrackedProp_Success) {
    return null;
  }
  return Number.isFinite(v) && v > 0 ? v : null;
}

export type OpenVrHmdEmulationPose = {
  matrix: Float32Array;
  position: [number, number, number];
  quaternion: [number, number, number, number];
};

export type CompositorFrameTiming = {
  frameIndex: number;
  numFramePresents: number;
  numMisPresented: number;
  numDroppedFrames: number;
  reprojectionFlags: number;
  systemTimeSeconds: number;
  totalRenderGpuMs: number;
  compositorRenderGpuMs: number;
  compositorRenderCpuMs: number;
  compositorIdleCpuMs: number;
  clientFrameIntervalMs: number;
  presentCallCpuMs: number;
  waitForPresentCpuMs: number;
  submitFrameMs: number;
  waitGetPosesCalledMs: number;
  newPosesReadyMs: number;
  newFrameReadyMs: number;
  compositorUpdateStartMs: number;
  compositorUpdateEndMs: number;
  compositorRenderStartMs: number;
  numVSyncsReadyForUse: number;
  numVSyncsToFirstView: number;
};

export type OpenVrOverlayPaceResult = {
  ok: boolean;
  frameIndex: bigint;
  previousFrameIndex: bigint;
  spins: number;
  spinTimeMs: number;
  yieldedMs: number;
  skippedDisplayFrames: number;
  waitedForVsync: boolean;
};

/** `vsync` — wait for a new display index (default, ~HMD refresh). `fast` — one sample per call, no spin. */
export type OpenVrOverlayPaceMode = "vsync" | "fast";

export class OpenVrOverlayFramePacer {
  private readonly vr: OpenVR.IVRSystem;
  private readonly compositor: OpenVR.IVRCompositor | null;
  private readonly crashOnVsyncIndexGap: boolean;
  private readonly paceMode: OpenVrOverlayPaceMode;
  private readonly label: string;
  private lastVsyncFrameIndex: bigint = 0n;
  private framesSkipped = 0;
  private paceToDisplayCallCount = 0;
  private lastPredictedSeconds = 0;
  private lastHmd: OpenVrHmdEmulationPose | null = null;
  private lastFallbackPaceAt = 0;
  private fallbackVsyncUnavailableLogged = false;
  /** Set when the vsync index stopped advancing (standby); cleared once it moves. */
  private vsyncStalled = false;
  /** `performance.now()` when the vsync index last moved. */
  private vsyncIndexMovedAt = 0;
  private readonly poseArrayBuffer: ArrayBuffer;
  private readonly posePtr: Deno.PointerValue<OpenVR.TrackedDevicePose>;
  /** The cached poses came from the Raw universe and need {@link playspaceFrame}'s anchor. */
  private posesReadRaw = false;
  private readonly vsyncSecondsBuffer = new Float32Array(1);
  private readonly vsyncFrameBuffer = new BigUint64Array(1);
  /**
   * The same frame index as two 32-bit words. Reading the `BigUint64Array` allocates a BigInt, and
   * the vsync spin polls thousands of times a frame: compare the words instead.
   */
  private readonly vsyncFrameWords = new Uint32Array(this.vsyncFrameBuffer.buffer);
  private readonly vsyncSecondsPtr = Deno.UnsafePointer.of(
    this.vsyncSecondsBuffer,
  ) as Deno.PointerValue<number>;
  private readonly vsyncFramePtr = Deno.UnsafePointer.of(
    this.vsyncFrameBuffer,
  ) as Deno.PointerValue<bigint>;
  private readonly poseViews: DataView<ArrayBuffer>[];
  private readonly poseCache: OpenVrHmdEmulationPose[];
  private readonly poseRowsCache: [
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
  ][];
  private displayHzCache: number | null = null;
  private secondsVsyncToPhotonsCache: number | null = null;
  private readonly fpsCounter = new FpsCounter();
  private lastFpsLogAt = 0;
  private readonly logVsyncSpin: boolean;
  /** Off-thread `IVROverlay::WaitFrameSync`, see {@link enableOverlayFrameSync}. */
  private waitFrameSync: ((timeoutMs: number) => Promise<number>) | null = null;
  private lastPaceResult: OpenVrOverlayPaceResult = {
    ok: false,
    frameIndex: 0n,
    previousFrameIndex: 0n,
    spins: 0,
    spinTimeMs: 0,
    yieldedMs: 0,
    skippedDisplayFrames: 0,
    waitedForVsync: false,
  };

  constructor(
    vr: OpenVR.IVRSystem,
    compositor: OpenVR.IVRCompositor | null,
    crashOnVsyncIndexGap = false,
    paceMode: OpenVrOverlayPaceMode = "vsync",
    label = "pacer",
    logVsyncSpin = false,
  ) {
    this.vr = vr;
    this.compositor = compositor;
    this.crashOnVsyncIndexGap = crashOnVsyncIndexGap;
    this.paceMode = paceMode;
    this.label = label;
    this.logVsyncSpin = logVsyncSpin;
    const n = OpenVR.TrackedDevicePoseStruct.byteSize * OpenVR.k_unMaxTrackedDeviceCount;
    this.poseArrayBuffer = new ArrayBuffer(n);
    this.posePtr = Deno.UnsafePointer.of(this.poseArrayBuffer) as Deno.PointerValue<
      OpenVR.TrackedDevicePose
    >;
    this.poseViews = Array.from(
      { length: OpenVR.k_unMaxTrackedDeviceCount },
      (_, index) =>
        new DataView(
          this.poseArrayBuffer,
          index * OpenVR.TrackedDevicePoseStruct.byteSize,
          OpenVR.TrackedDevicePoseStruct.byteSize,
        ),
    );
    this.poseCache = Array.from(
      { length: OpenVR.k_unMaxTrackedDeviceCount },
      () => ({
        matrix: new Float32Array(16),
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
      }),
    );
    this.poseRowsCache = Array.from(
      { length: OpenVR.k_unMaxTrackedDeviceCount },
      () => [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
    );
  }

  /**
   * Aardvark `CVRManager::updateOpenVrPoses` (overlay, no `WaitGetPoses`):
   * block for a new vsync index, then `GetDeviceToAbsoluteTrackingPose` for predicted HMD.
   * If `!CanRenderScene` or `GetTimeSinceLastVsync` fails, returns without updating
   * **HMD** cache — do **not** conflate with `IVRInput` (`doInputWork` in Aardvark still
   * runs every `runFrame` after this; see `webxrhost` tick order).
   */
  paceToDisplayAndRefreshPoses(): OpenVrOverlayPaceResult {
    return this.paceToDisplayAndRefreshPosesSync(0);
  }

  /**
   * Raylib overlay path: give the JS worker back to timers for the coarse wait, then use the
   * synchronous OpenVR poll for the last short tail. This keeps the same frame-index gate while
   * avoiding multi-ms busy waits that can phase-lock badly with `setTimeout(0)` rAF.
   */
  async paceToDisplayAndRefreshPosesYielding(
    spinTailMs = DEFAULT_VSYNC_SPIN_TAIL_MS,
  ): Promise<OpenVrOverlayPaceResult> {
    if (this.waitFrameSync && this.paceMode === "vsync") {
      return await this.paceToOverlayFrameSync();
    }
    let yieldedMs = 0;
    if (this.vsyncStalled && this.paceMode === "vsync") {
      const t0 = performance.now();
      await wait(VSYNC_STALLED_POLL_MS);
      return this.paceToDisplayAndRefreshPosesSync(performance.now() - t0);
    }
    if (this.paceMode === "vsync" && this.lastVsyncFrameIndex !== 0n) {
      const gotVsync = this.vr.GetTimeSinceLastVsync(
        this.vsyncSecondsPtr,
        this.vsyncFramePtr,
      );
      if (!gotVsync) {
        yieldedMs = await this.waitForFallbackDisplayInterval();
      } else if (this.vsyncFrameBuffer[0] === this.lastVsyncFrameIndex) {
        this.displayHzCache ??= readHmdFloatProp(
          this.vr,
          OpenVR.TrackedDeviceProperty.Prop_DisplayFrequency_Float,
        ) ?? 90;
        const frameDurationMs = 1000 / this.displayHzCache;
        const secondsSinceLastVsync = this.vsyncSecondsBuffer[0];
        const untilNextVsyncMs = frameDurationMs - secondsSinceLastVsync * 1000;
        const coarseWaitMs = Math.max(0, untilNextVsyncMs - spinTailMs);
        if (coarseWaitMs >= 0.5 && coarseWaitMs <= MAX_VSYNC_COARSE_YIELD_MS) {
          const t0 = performance.now();
          await wait(coarseWaitMs);
          yieldedMs = performance.now() - t0;
        }
        yieldedMs += await this.waitWhileVsyncLate(spinTailMs);
      }
    }
    return this.paceToDisplayAndRefreshPosesSync(yieldedMs);
  }

  /**
   * After the coarse wait, spin at most two spin tails for the index, then poll it on short
   * timers: the compositor is behind the display (an app-limited scene app over Steam Link sets
   * its rate), and spinning through those gaps took a core from the scene app.
   */
  private async waitWhileVsyncLate(spinTailMs: number): Promise<number> {
    const t0 = performance.now();
    const last = this.lastVsyncFrameIndex;
    while (
      performance.now() - this.vsyncIndexMovedAt < VSYNC_STALL_MS &&
      this.vr.GetTimeSinceLastVsync(this.vsyncSecondsPtr, this.vsyncFramePtr) &&
      this.vsyncFrameBuffer[0] === last
    ) {
      if (performance.now() - t0 > 2 * spinTailMs) await wait(VSYNC_LATE_POLL_MS);
    }
    return performance.now() - t0;
  }

  /**
   * Pace like WayVR: block (off the JS thread) in `IVROverlay::WaitFrameSync` until the
   * compositor asks overlays for a frame, with a two-frame timeout, then sample the vsync
   * index once instead of spinning on it. When the compositor stalls, the frame renders on
   * timeout with fresh poses rather than burning a core waiting for the index to move.
   */
  enableOverlayFrameSync(overlayPointer: number | bigint): void {
    const ptr = Deno.UnsafePointer.create(
      typeof overlayPointer === "bigint" ? overlayPointer : BigInt(overlayPointer),
    );
    if (ptr == null) return;
    // IVROverlay function table slot 45 (byte offset 360), as in the generated bindings.
    const fn = Deno.UnsafePointer.create(new Deno.UnsafePointerView(ptr).getBigUint64(360)) as
      | Deno.PointerObject<{ parameters: ["u32"]; result: "i32" }>
      | null;
    if (fn == null) return;
    const waitFrameSync = new Deno.UnsafeFnPointer(
      fn,
      {
        parameters: ["u32"],
        result: "i32",
        nonblocking: true,
      } as const,
    );
    this.waitFrameSync = (timeoutMs) => waitFrameSync.call(timeoutMs);
  }

  disableOverlayFrameSync(): void {
    this.waitFrameSync = null;
  }

  isOverlayFrameSyncEnabled(): boolean {
    return this.waitFrameSync != null;
  }

  /** Ms since vsync at which each `WaitFrameSync` returned (last 600): the compositor's "top of frame" in our clock. */
  readonly frameSyncPhases: number[] = [];

  private async paceToOverlayFrameSync(): Promise<OpenVrOverlayPaceResult> {
    this.displayHzCache ??= readHmdFloatProp(
      this.vr,
      OpenVR.TrackedDeviceProperty.Prop_DisplayFrequency_Float,
    ) ?? 90;
    const timeoutMs = Math.floor(2 * 1000 / this.displayHzCache);
    const t0 = performance.now();
    // WaitFrameSync returns at once when a sync is already pending, which can be the one
    // just rendered; wait once more if the index has not moved.
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.waitFrameSync!(timeoutMs);
      const phase = this.sampleVsyncPhase();
      if (phase) {
        this.frameSyncPhases.push(phase.msSinceVsync);
        if (this.frameSyncPhases.length > 600) this.frameSyncPhases.shift();
      }
      if (
        this.lastVsyncFrameIndex === 0n ||
        !this.vr.GetTimeSinceLastVsync(this.vsyncSecondsPtr, this.vsyncFramePtr) ||
        this.vsyncFrameBuffer[0] !== this.lastVsyncFrameIndex
      ) {
        break;
      }
    }
    return this.paceToDisplayAndRefreshPosesSync(performance.now() - t0, false);
  }

  private async waitForFallbackDisplayInterval(): Promise<number> {
    this.displayHzCache ??= readHmdFloatProp(
      this.vr,
      OpenVR.TrackedDeviceProperty.Prop_DisplayFrequency_Float,
    ) ?? 90;
    const frameDurationMs = 1000 / this.displayHzCache;
    const now = performance.now();
    const elapsedSinceFallback = this.lastFallbackPaceAt > 0
      ? now - this.lastFallbackPaceAt
      : frameDurationMs;
    const waitMs = Math.max(0, frameDurationMs - elapsedSinceFallback);
    if (waitMs <= 0) {
      return 0;
    }
    const t0 = performance.now();
    await wait(waitMs);
    return performance.now() - t0;
  }

  private paceToDisplayAndRefreshPosesSync(
    yieldedMs: number,
    spin = this.paceMode === "vsync",
  ): OpenVrOverlayPaceResult {
    this.paceToDisplayCallCount++;
    this.fpsCounter.mark(performance.now());
    if (this.compositor != null && !this.compositor.CanRenderScene()) {
      return this.setLastPaceResult({
        ok: false,
        frameIndex: this.lastVsyncFrameIndex,
        previousFrameIndex: this.lastVsyncFrameIndex,
        spins: 0,
        spinTimeMs: 0,
        yieldedMs,
        skippedDisplayFrames: 0,
        waitedForVsync: false,
      });
    }

    const useVsyncSpin = spin;
    let previousFrameIndex = this.lastVsyncFrameIndex;
    let currentFrameIndex = this.lastVsyncFrameIndex;
    let spins = 0;
    let spinTime = 0;
    let skippedDisplayFrames = 0;
    if (useVsyncSpin) {
      const last = this.lastVsyncFrameIndex;
      let newIndex = last;
      const spinStart = performance.now();
      this.displayHzCache ??= readHmdFloatProp(
        this.vr,
        OpenVR.TrackedDeviceProperty.Prop_DisplayFrequency_Float,
      ) ?? 90;
      // Stalled: check once without spinning (the async caller already idled on a timer).
      const stallMs = this.vsyncStalled ? 0 : VSYNC_SPIN_LIMIT_FRAMES * 1000 / this.displayHzCache;
      const words = this.vsyncFrameWords;
      this.vsyncFrameBuffer[0] = last;
      const lastLow = words[0], lastHigh = words[1];
      while (newIndex === last) {
        if (!this.vr.GetTimeSinceLastVsync(this.vsyncSecondsPtr, this.vsyncFramePtr)) {
          return this.refreshPosesWithFallbackTiming(
            last,
            spins,
            performance.now() - spinStart,
            yieldedMs,
          );
        }
        if (words[0] !== lastLow || words[1] !== lastHigh) {
          newIndex = this.vsyncFrameBuffer[0];
          break;
        }
        if (
          ++spins > MAX_VSYNC_POLLS ||
          (spins % 1024 === 0 && performance.now() - spinStart > stallMs)
        ) {
          const spinTime = performance.now() - spinStart;
          if (!this.vsyncStalled && performance.now() - this.vsyncIndexMovedAt >= VSYNC_STALL_MS) {
            this.vsyncStalled = true;
            LogChannel.log(
              "webxrv2",
              `[${this.label}] vsync index stalled at ${last} (SteamVR standby?); idling every ${VSYNC_STALLED_POLL_MS}ms until it moves`,
            );
          }
          return this.setLastPaceResult({
            ok: false,
            frameIndex: newIndex,
            previousFrameIndex: last,
            spins,
            spinTimeMs: spinTime,
            yieldedMs,
            skippedDisplayFrames: 0,
            waitedForVsync: false,
          });
        }
      }
      spinTime = performance.now() - spinStart;
      this.vsyncIndexMovedAt = performance.now();
      if (this.vsyncStalled) {
        this.vsyncStalled = false;
        LogChannel.log(
          "webxrv2",
          `[${this.label}] vsync index moving again (${last} -> ${newIndex})`,
        );
      }

      if (last !== 0n && last + 1n < newIndex) {
        skippedDisplayFrames = Number(newIndex - last - 1n);
        this.framesSkipped += skippedDisplayFrames;
        const skipped = BigInt(skippedDisplayFrames);
        if (
          this.crashOnVsyncIndexGap && last !== 0n &&
          this.paceToDisplayCallCount > WEBXR_CRASH_ON_DROP_WARMUP_FRAMES
        ) {
          throw new Error(
            `[openVrOverlayFramePacer] vsync frame index gap: last=${last} new=${newIndex} (dropped ${skipped} display frame(s); set --webxr-crash-on-dropped-frame=off to disable)`,
          );
        }
      }
      this.lastVsyncFrameIndex = newIndex;
      previousFrameIndex = last;
      currentFrameIndex = newIndex;

      if (this.logVsyncSpin && (this.paceToDisplayCallCount % 30 === 0 || spinTime > 5)) {
        const yieldPart = yieldedMs > 0 ? `, yielded=${yieldedMs.toFixed(2)}ms` : "";
        LogChannel.log(
          "webxrv2",
          `[${this.label}] vsync: spins=${spins}, time=${
            spinTime.toFixed(2)
          }ms${yieldPart}, idx=${newIndex}, skipped=${this.framesSkipped}`,
        );
      }

      this.vr.GetTimeSinceLastVsync(this.vsyncSecondsPtr, this.vsyncFramePtr);
    } else {
      if (!this.vr.GetTimeSinceLastVsync(this.vsyncSecondsPtr, this.vsyncFramePtr)) {
        return this.refreshPosesWithFallbackTiming(
          this.lastVsyncFrameIndex,
          0,
          0,
          yieldedMs,
        );
      }
      const newIndex = this.vsyncFrameBuffer[0];
      if (this.lastVsyncFrameIndex !== 0n && this.lastVsyncFrameIndex + 1n < newIndex) {
        skippedDisplayFrames = Number(newIndex - this.lastVsyncFrameIndex - 1n);
        this.framesSkipped += skippedDisplayFrames;
      }
      previousFrameIndex = this.lastVsyncFrameIndex;
      this.lastVsyncFrameIndex = newIndex;
      currentFrameIndex = newIndex;
    }
    const secondsSinceLastVsync = this.vsyncSecondsBuffer[0];

    this.displayHzCache ??= readHmdFloatProp(
      this.vr,
      OpenVR.TrackedDeviceProperty.Prop_DisplayFrequency_Float,
    ) ?? 90;
    this.secondsVsyncToPhotonsCache ??= readHmdFloatProp(
      this.vr,
      OpenVR.TrackedDeviceProperty.Prop_SecondsFromVsyncToPhotons_Float,
    ) ?? 0;

    const frameDuration = 1.0 / this.displayHzCache;
    const vsyncToPhotons = this.secondsVsyncToPhotonsCache;
    const predictedSecondsFromNow = Math.max(
      0,
      frameDuration * (1 + this.extraPredictionFrames) - secondsSinceLastVsync + vsyncToPhotons,
    );
    this.lastPredictedSeconds = predictedSecondsFromNow;

    this.posesReadRaw = playspaceFrame.active;
    this.vr.GetDeviceToAbsoluteTrackingPose(
      playspaceFrame.universe,
      predictedSecondsFromNow,
      this.posePtr,
      OpenVR.k_unMaxTrackedDeviceCount,
    );

    this.lastHmd = this.readHmdPoseAtIndex(
      OpenVR.k_unTrackedDeviceIndex_Hmd,
    );

    const advancedOneFrame = previousFrameIndex !== 0n &&
      currentFrameIndex === previousFrameIndex + 1n;

    return this.setLastPaceResult({
      ok: true,
      frameIndex: currentFrameIndex,
      previousFrameIndex,
      spins,
      spinTimeMs: spinTime,
      yieldedMs,
      skippedDisplayFrames,
      waitedForVsync: useVsyncSpin
        ? spins > 1 || yieldedMs > 0 || advancedOneFrame
        : this.waitFrameSync != null && currentFrameIndex !== previousFrameIndex,
    });
  }

  private refreshPosesWithFallbackTiming(
    previousFrameIndex: bigint,
    spins: number,
    spinTimeMs: number,
    yieldedMs: number,
  ): OpenVrOverlayPaceResult {
    this.displayHzCache ??= readHmdFloatProp(
      this.vr,
      OpenVR.TrackedDeviceProperty.Prop_DisplayFrequency_Float,
    ) ?? 90;
    this.secondsVsyncToPhotonsCache ??= readHmdFloatProp(
      this.vr,
      OpenVR.TrackedDeviceProperty.Prop_SecondsFromVsyncToPhotons_Float,
    ) ?? 0;

    if (!this.fallbackVsyncUnavailableLogged) {
      this.fallbackVsyncUnavailableLogged = true;
      LogChannel.log(
        "webxrv2",
        `[${this.label}] GetTimeSinceLastVsync unavailable; pacing from Prop_DisplayFrequency_Float=${
          this.displayHzCache.toFixed(2)
        } Hz`,
      );
    }

    const frameDuration = 1.0 / this.displayHzCache;
    const predictedSecondsFromNow = Math.max(
      0,
      frameDuration * (1 + this.extraPredictionFrames) + this.secondsVsyncToPhotonsCache,
    );
    this.lastPredictedSeconds = predictedSecondsFromNow;
    this.posesReadRaw = playspaceFrame.active;
    this.vr.GetDeviceToAbsoluteTrackingPose(
      playspaceFrame.universe,
      predictedSecondsFromNow,
      this.posePtr,
      OpenVR.k_unMaxTrackedDeviceCount,
    );
    this.lastHmd = this.readHmdPoseAtIndex(OpenVR.k_unTrackedDeviceIndex_Hmd);
    this.lastFallbackPaceAt = performance.now();

    const frameIndex = previousFrameIndex + 1n;
    this.lastVsyncFrameIndex = frameIndex;
    return this.setLastPaceResult({
      ok: true,
      frameIndex,
      previousFrameIndex,
      spins,
      spinTimeMs,
      yieldedMs,
      skippedDisplayFrames: 0,
      waitedForVsync: yieldedMs > 0 || previousFrameIndex !== 0n,
    });
  }

  private async inspectProjectionLayer(device: GPUDevice) {}

  private setLastPaceResult(result: OpenVrOverlayPaceResult): OpenVrOverlayPaceResult {
    this.lastPaceResult = result;
    return result;
  }

  /**
   * Whole display frames to predict poses beyond the next vsync, for a caller that shows each
   * frame later than that (e.g. one that holds its present past the next vsync).
   */
  extraPredictionFrames = 0;
  private readonly phaseSecondsBuffer = new Float32Array(1);
  private readonly phaseFrameBuffer = new BigUint64Array(1);

  /**
   * Where in the display frame "now" is: ms since the last vsync and that vsync's index. Leaves
   * the pacing state alone, so it can be sampled anywhere (e.g. right before a present).
   */
  sampleVsyncPhase(): { msSinceVsync: number; frameIndex: bigint } | null {
    const ok = this.vr.GetTimeSinceLastVsync(
      Deno.UnsafePointer.of(this.phaseSecondsBuffer) as Deno.PointerValue<number>,
      Deno.UnsafePointer.of(this.phaseFrameBuffer) as Deno.PointerValue<bigint>,
    );
    if (!ok) return null;
    return {
      msSinceVsync: this.phaseSecondsBuffer[0] * 1000,
      frameIndex: this.phaseFrameBuffer[0],
    };
  }

  /** `Compositor_FrameTiming` (plain C layout: the double makes it 8-aligned, 192 bytes). */
  private readonly frameTimingBuffer = new ArrayBuffer(192);
  private readonly frameTimingView = new DataView(this.frameTimingBuffer);

  /**
   * The compositor's own timing for one of its frames (`IVRCompositor::GetFrameTiming`). The `*Ms`
   * phase fields are measured from that frame's start, so `compositorRenderStartMs` is where in
   * the frame the compositor begins composing — the deadline an overlay update has to beat.
   */
  readCompositorFrameTiming(framesAgo = 0): CompositorFrameTiming | null {
    if (this.compositor == null) return null;
    const view = this.frameTimingView;
    view.setUint32(0, 192, true);
    const ok = this.compositor.GetFrameTiming(
      Deno.UnsafePointer.of(this.frameTimingBuffer) as Deno.PointerValue<
        OpenVR.Compositor_FrameTiming
      >,
      framesAgo,
    );
    if (!ok) return null;
    const f = (offset: number) => view.getFloat32(offset, true);
    return {
      frameIndex: view.getUint32(4, true),
      numFramePresents: view.getUint32(8, true),
      numMisPresented: view.getUint32(12, true),
      numDroppedFrames: view.getUint32(16, true),
      reprojectionFlags: view.getUint32(20, true),
      systemTimeSeconds: view.getFloat64(24, true),
      totalRenderGpuMs: f(40),
      compositorRenderGpuMs: f(44),
      compositorRenderCpuMs: f(48),
      compositorIdleCpuMs: f(52),
      clientFrameIntervalMs: f(56),
      presentCallCpuMs: f(60),
      waitForPresentCpuMs: f(64),
      submitFrameMs: f(68),
      waitGetPosesCalledMs: f(72),
      newPosesReadyMs: f(76),
      newFrameReadyMs: f(80),
      compositorUpdateStartMs: f(84),
      compositorUpdateEndMs: f(88),
      compositorRenderStartMs: f(92),
      numVSyncsReadyForUse: view.getUint32(176, true),
      numVSyncsToFirstView: view.getUint32(180, true),
    };
  }

  getLastPaceResult(): OpenVrOverlayPaceResult {
    return this.lastPaceResult;
  }

  getCachedHmdEmulation(): OpenVrHmdEmulationPose | null {
    return this.lastHmd;
  }

  getCachedTrackedDevicePose(index: number): OpenVrHmdEmulationPose | null {
    if (!Number.isInteger(index) || index < 0 || index >= OpenVR.k_unMaxTrackedDeviceCount) {
      return null;
    }
    return this.readHmdPoseAtIndex(index);
  }

  getLastPredictedSecondsToPhotons(): number {
    return this.lastPredictedSeconds;
  }

  getFramesSkippedCount(): number {
    return this.framesSkipped;
  }

  maybeLogFps(): void {
    const now = performance.now();
    if (now - this.lastFpsLogAt >= 1000) {
      this.lastFpsLogAt = now;
      const fps = this.fpsCounter.getFps();
      const mode = this.paceMode === "vsync" ? "vsync" : "fast";
      LogChannel.log("fps", `[${this.label}] ${fps.toFixed(1)} Hz (${mode})`);
    }
  }

  private readHmdPoseAtIndex(
    index: number,
  ): OpenVrHmdEmulationPose | null {
    const poseView = this.poseViews[index];
    const poseValidOffset = OpenVR.HmdMatrix34Struct.byteSize +
      OpenVR.HmdVector3Struct.byteSize * 2 + 4;
    if (poseView.getUint8(poseValidOffset) === 0) {
      return null;
    }
    const m = this.poseRowsCache[index];
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 4; column++) {
        m[row][column] = poseView.getFloat32((row * 4 + column) * 4, true);
      }
    }
    if (this.posesReadRaw) playspaceFrame.poseRowsFromRaw(m);
    const pose = this.poseCache[index];
    const matrix = pose.matrix;
    matrix[0] = m[0][0];
    matrix[1] = m[1][0];
    matrix[2] = m[2][0];
    matrix[3] = 0;
    matrix[4] = m[0][1];
    matrix[5] = m[1][1];
    matrix[6] = m[2][1];
    matrix[7] = 0;
    matrix[8] = m[0][2];
    matrix[9] = m[1][2];
    matrix[10] = m[2][2];
    matrix[11] = 0;
    matrix[12] = m[0][3];
    matrix[13] = m[1][3];
    matrix[14] = m[2][3];
    matrix[15] = 1;
    pose.position[0] = m[0][3];
    pose.position[1] = m[1][3];
    pose.position[2] = m[2][3];
    matrix3x4RowsToQuaternion(m, pose.quaternion);
    return pose;
  }
}

export function tryCreateOpenVrOverlayFramePacer(
  systemPointer: number | bigint | null,
  compositorPointer: number | bigint | null,
  enabled: boolean,
  /** When `true`, `paceToDisplayAndRefreshPoses` throws if the vsync index skips (after the first sample). */
  crashOnVsyncIndexGap = false,
  paceMode: OpenVrOverlayPaceMode = "vsync",
  label = "pacer",
  logVsyncSpin = false,
): OpenVrOverlayFramePacer | null {
  if (!enabled || systemPointer == null) {
    return null;
  }
  const sp = Deno.UnsafePointer.create(
    typeof systemPointer === "bigint" ? systemPointer : BigInt(systemPointer),
  );
  if (sp == null) {
    return null;
  }
  const vr = new OpenVR.IVRSystem(sp);
  if (compositorPointer == null) {
    return new OpenVrOverlayFramePacer(
      vr,
      null,
      crashOnVsyncIndexGap,
      paceMode,
      label,
      logVsyncSpin,
    );
  }
  const cp = Deno.UnsafePointer.create(
    typeof compositorPointer === "bigint" ? compositorPointer : BigInt(compositorPointer),
  );
  if (cp == null) {
    return new OpenVrOverlayFramePacer(
      vr,
      null,
      crashOnVsyncIndexGap,
      paceMode,
      label,
      logVsyncSpin,
    );
  }
  return new OpenVrOverlayFramePacer(
    vr,
    new OpenVR.IVRCompositor(cp),
    crashOnVsyncIndexGap,
    paceMode,
    label,
    logVsyncSpin,
  );
}
