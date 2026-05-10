/**
 * OpenVR **overlay** frame timing and predicted poses (Aardvark
 * `CVRManager::updateOpenVrPoses` in `vrmanager.cpp`):
 * - Do **not** use `IVRCompositor::WaitGetPoses` in overlay apps.
 * - Wait on a new display frame with `GetTimeSinceLastVsync` + frame index, then
 *   call `GetDeviceToAbsoluteTrackingPose` with
 *   `frameDuration - secondsSinceLastVsync + secondsFromVsyncToPhotons`.
 */
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { WEBXR_CRASH_ON_DROP_WARMUP_FRAMES } from "./webxrCrashOnDrop.ts";
import { FpsCounter } from "./fpsCounter.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";

const MAX_VSYNC_POLLS = 2_000_000;
const DEFAULT_VSYNC_SPIN_TAIL_MS = 1.0;
const MAX_VSYNC_COARSE_YIELD_MS = 4.0;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function matrix3x4RowsToQuaternion(
  m: [
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
  ],
): [number, number, number, number] {
  const m00 = m[0][0], m01 = m[0][1], m02 = m[0][2];
  const m10 = m[1][0], m11 = m[1][1], m12 = m[1][2];
  const m20 = m[2][0], m21 = m[2][1], m22 = m[2][2];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1.0) * 2;
    return [
      (m21 - m12) / s,
      (m02 - m20) / s,
      (m10 - m01) / s,
      0.25 * s,
    ];
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1.0 + m00 - m11 - m22) * 2;
    return [
      0.25 * s,
      (m01 + m10) / s,
      (m02 + m20) / s,
      (m21 - m12) / s,
    ];
  }
  if (m11 > m22) {
    const s = Math.sqrt(1.0 + m11 - m00 - m22) * 2;
    return [
      (m01 + m10) / s,
      0.25 * s,
      (m12 + m21) / s,
      (m02 - m20) / s,
    ];
  }
  const s = Math.sqrt(1.0 + m22 - m00 - m11) * 2;
  return [
    (m02 + m20) / s,
    (m12 + m21) / s,
    0.25 * s,
    (m10 - m01) / s,
  ];
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
  private readonly poseArrayBuffer: ArrayBuffer;
  private readonly posePtr: Deno.PointerValue<OpenVR.TrackedDevicePose>;
  private displayHzCache: number | null = null;
  private secondsVsyncToPhotonsCache: number | null = null;
  private readonly fpsCounter = new FpsCounter();
  private lastFpsLogAt = 0;
  private readonly logVsyncSpin: boolean;
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
    let yieldedMs = 0;
    if (this.paceMode === "vsync" && this.lastVsyncFrameIndex !== 0n) {
      const floatBuf = new Float32Array(1);
      const frameBuf = new BigUint64Array(1);
      const pSec = Deno.UnsafePointer.of(floatBuf) as Deno.PointerValue<number>;
      const pFrame = Deno.UnsafePointer.of(frameBuf) as Deno.PointerValue<bigint>;
      if (this.vr.GetTimeSinceLastVsync(pSec, pFrame) && frameBuf[0] === this.lastVsyncFrameIndex) {
        this.displayHzCache ??= readHmdFloatProp(
          this.vr,
          OpenVR.TrackedDeviceProperty.Prop_DisplayFrequency_Float,
        ) ?? 90;
        const frameDurationMs = 1000 / this.displayHzCache;
        const secondsSinceLastVsync = floatBuf[0];
        const untilNextVsyncMs = frameDurationMs - secondsSinceLastVsync * 1000;
        const coarseWaitMs = Math.max(0, untilNextVsyncMs - spinTailMs);
        if (coarseWaitMs >= 0.5 && coarseWaitMs <= MAX_VSYNC_COARSE_YIELD_MS) {
          const t0 = performance.now();
          await wait(coarseWaitMs);
          yieldedMs = performance.now() - t0;
        }
      }
    }
    return this.paceToDisplayAndRefreshPosesSync(yieldedMs);
  }

  private paceToDisplayAndRefreshPosesSync(yieldedMs: number): OpenVrOverlayPaceResult {
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

    const floatBuf = new Float32Array(1);
    const frameBuf = new BigUint64Array(1);
    const pSec = Deno.UnsafePointer.of(floatBuf) as Deno.PointerValue<number>;
    const pFrame = Deno.UnsafePointer.of(frameBuf) as Deno.PointerValue<bigint>;

    const useVsyncSpin = this.paceMode === "vsync";
    let previousFrameIndex = this.lastVsyncFrameIndex;
    let currentFrameIndex = this.lastVsyncFrameIndex;
    let spins = 0;
    let spinTime = 0;
    let skippedDisplayFrames = 0;
    if (useVsyncSpin) {
      const last = this.lastVsyncFrameIndex;
      let newIndex = last;
      const spinStart = performance.now();
      while (newIndex === last) {
        if (!this.vr.GetTimeSinceLastVsync(pSec, pFrame)) {
          return this.setLastPaceResult({
            ok: false,
            frameIndex: last,
            previousFrameIndex: last,
            spins,
            spinTimeMs: performance.now() - spinStart,
            yieldedMs,
            skippedDisplayFrames: 0,
            waitedForVsync: false,
          });
        }
        newIndex = frameBuf[0];
        if (++spins > MAX_VSYNC_POLLS) {
          const spinTime = performance.now() - spinStart;
          LogChannel.log(
            "webxrv2",
            `[${this.label}] vsync spin timeout: spins=${spins}, time=${
              spinTime.toFixed(2)
            }ms, last=${last}, newIndex=${newIndex}`,
          );
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

      this.vr.GetTimeSinceLastVsync(pSec, pFrame);
    } else {
      if (!this.vr.GetTimeSinceLastVsync(pSec, pFrame)) {
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
      const newIndex = frameBuf[0];
      if (this.lastVsyncFrameIndex !== 0n && this.lastVsyncFrameIndex + 1n < newIndex) {
        skippedDisplayFrames = Number(newIndex - this.lastVsyncFrameIndex - 1n);
        this.framesSkipped += skippedDisplayFrames;
      }
      previousFrameIndex = this.lastVsyncFrameIndex;
      this.lastVsyncFrameIndex = newIndex;
      currentFrameIndex = newIndex;
    }
    const secondsSinceLastVsync = floatBuf[0];

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
    const predictedSecondsFromNow = frameDuration - secondsSinceLastVsync + vsyncToPhotons;
    this.lastPredictedSeconds = predictedSecondsFromNow;

    this.vr.GetDeviceToAbsoluteTrackingPose(
      OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding,
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
      waitedForVsync: useVsyncSpin && (spins > 1 || yieldedMs > 0 || advancedOneFrame),
    });
  }

  private async inspectProjectionLayer(device: GPUDevice) {}

  private setLastPaceResult(result: OpenVrOverlayPaceResult): OpenVrOverlayPaceResult {
    this.lastPaceResult = result;
    return result;
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
    const poseView = new DataView(
      this.poseArrayBuffer,
      index * OpenVR.TrackedDevicePoseStruct.byteSize,
      OpenVR.TrackedDevicePoseStruct.byteSize,
    );
    const hmdPose = OpenVR.TrackedDevicePoseStruct.read(
      poseView,
    ) as unknown as OpenVR.TrackedDevicePose;
    if (!hmdPose.bPoseIsValid) {
      return null;
    }
    const m = hmdPose.mDeviceToAbsoluteTracking.m;
    return {
      matrix: new Float32Array([
        m[0][0],
        m[1][0],
        m[2][0],
        0,
        m[0][1],
        m[1][1],
        m[2][1],
        0,
        m[0][2],
        m[1][2],
        m[2][2],
        0,
        m[0][3],
        m[1][3],
        m[2][3],
        1,
      ]),
      position: [m[0][3], m[1][3], m[2][3]],
      quaternion: matrix3x4RowsToQuaternion(
        m as [
          [number, number, number, number],
          [number, number, number, number],
          [number, number, number, number],
        ],
      ),
    };
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
    return new OpenVrOverlayFramePacer(vr, null, crashOnVsyncIndexGap, paceMode, label, logVsyncSpin);
  }
  const cp = Deno.UnsafePointer.create(
    typeof compositorPointer === "bigint" ? compositorPointer : BigInt(compositorPointer),
  );
  if (cp == null) {
    return new OpenVrOverlayFramePacer(vr, null, crashOnVsyncIndexGap, paceMode, label, logVsyncSpin);
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
