/**
 * OpenVR **overlay** frame timing and predicted poses (Aardvark
 * `CVRManager::updateOpenVrPoses` in `vrmanager.cpp`):
 * - Do **not** use `IVRCompositor::WaitGetPoses` in overlay apps.
 * - Wait on a new display frame with `GetTimeSinceLastVsync` + frame index, then
 *   call `GetDeviceToAbsoluteTrackingPose` with
 *   `frameDuration - secondsSinceLastVsync + secondsFromVsyncToPhotons`.
 */
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";

const MAX_VSYNC_POLLS = 2_000_000;

function matrix3x4RowsToQuaternion(
  m: [[number, number, number, number], [number, number, number, number], [number, number, number, number]],
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
  const pErr = Deno.UnsafePointer.of(errBuf) as Deno.PointerValue<OpenVR.TrackedPropertyError> | null;
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

export class OpenVrOverlayFramePacer {
  private readonly vr: OpenVR.IVRSystem;
  private readonly compositor: OpenVR.IVRCompositor | null;
  private lastVsyncFrameIndex: bigint = 0n;
  private framesSkipped = 0;
  private lastPredictedSeconds = 0;
  private lastHmd: OpenVrHmdEmulationPose | null = null;
  private readonly poseArrayBuffer: ArrayBuffer;
  private readonly posePtr: Deno.PointerValue<OpenVR.TrackedDevicePose>;
  private displayHzCache: number | null = null;
  private secondsVsyncToPhotonsCache: number | null = null;

  constructor(vr: OpenVR.IVRSystem, compositor: OpenVR.IVRCompositor | null) {
    this.vr = vr;
    this.compositor = compositor;
    const n = OpenVR.TrackedDevicePoseStruct.byteSize * OpenVR.k_unMaxTrackedDeviceCount;
    this.poseArrayBuffer = new ArrayBuffer(n);
    this.posePtr = Deno.UnsafePointer.of(this.poseArrayBuffer) as Deno.PointerValue<OpenVR.TrackedDevicePose>;
  }

  /**
   * Block until a new display frame, then fill predicted HMD tracking for that frame
   * (Aardvark `updateOpenVrPoses`).
   */
  paceToDisplayAndRefreshPoses(): void {
    if (this.compositor != null && !this.compositor.CanRenderScene()) {
      return;
    }

    const floatBuf = new Float32Array(1);
    const frameBuf = new BigUint64Array(1);
    const pSec = Deno.UnsafePointer.of(floatBuf) as Deno.PointerValue<number>;
    const pFrame = Deno.UnsafePointer.of(frameBuf) as Deno.PointerValue<bigint>;

    const last = this.lastVsyncFrameIndex;
    let spins = 0;
    let newIndex = last;
    while (newIndex === last) {
      if (!this.vr.GetTimeSinceLastVsync(pSec, pFrame)) {
        return;
      }
      newIndex = frameBuf[0];
      if (++spins > MAX_VSYNC_POLLS) {
        return;
      }
    }

    if (last + 1n < newIndex) {
      this.framesSkipped++;
    }
    this.lastVsyncFrameIndex = newIndex;

    this.vr.GetTimeSinceLastVsync(pSec, pFrame);
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
  }

  getCachedHmdEmulation(): OpenVrHmdEmulationPose | null {
    return this.lastHmd;
  }

  getLastPredictedSecondsToPhotons(): number {
    return this.lastPredictedSeconds;
  }

  getFramesSkippedCount(): number {
    return this.framesSkipped;
  }

  private readHmdPoseAtIndex(
    index: number,
  ): OpenVrHmdEmulationPose | null {
    const poseView = new DataView(
      this.poseArrayBuffer,
      index * OpenVR.TrackedDevicePoseStruct.byteSize,
      OpenVR.TrackedDevicePoseStruct.byteSize,
    );
    const hmdPose = OpenVR.TrackedDevicePoseStruct.read(poseView) as unknown as OpenVR.TrackedDevicePose;
    if (!hmdPose.bPoseIsValid) {
      return null;
    }
    const m = hmdPose.mDeviceToAbsoluteTracking.m;
    return {
      matrix: new Float32Array([
        m[0][0], m[1][0], m[2][0], 0,
        m[0][1], m[1][1], m[2][1], 0,
        m[0][2], m[1][2], m[2][2], 0,
        m[0][3], m[1][3], m[2][3], 1,
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
    return new OpenVrOverlayFramePacer(vr, null);
  }
  const cp = Deno.UnsafePointer.create(
    typeof compositorPointer === "bigint" ? compositorPointer : BigInt(compositorPointer),
  );
  if (cp == null) {
    return new OpenVrOverlayFramePacer(vr, null);
  }
  return new OpenVrOverlayFramePacer(
    vr,
    new OpenVR.IVRCompositor(cp),
  );
}
