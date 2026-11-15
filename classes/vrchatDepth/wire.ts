/**
 * The decoded depth frame as it travels from the `vrchatDepth` actor to `webxr`. Actor messages
 * between processes are JSON, so the depth grid goes as base64 of 16-bit log codes (`DEPTH_LOG16`)
 * and the colours only while webxr asks for them (`VRCDEPTHWANTS`): each frame crosses several
 * JSON hops at ~40 Hz.
 */
import type { DepthFrameHeader } from "./format.ts";

export type VrcDepthFramePayload = {
  /** `Date.now()` when the window frame holding this block arrived. */
  receivedAt: number;
  decodeMs: number;
  header: DepthFrameHeader;
  /** The depth grid as sent (downsampled from the block), metres, 0 = none. */
  width: number;
  height: number;
  /** Little-endian `encodeDepthLog16` codes, base64. */
  depthLog16Base64?: string;
  /** Older intakes: float32 metres, base64. */
  depthBase64?: string;
  /**
   * The window's sRGB colour at each depth sample (RGBA bytes, alpha 0 = none), when the window
   * shows the block's own view (VRChat's camera pass); null otherwise.
   */
  colorBase64: string | null;
  /**
   * VRChat's playspace scale, world metres per real metre (`vrchatScale.ts`), or null while
   * unknown (the fit then assumes 1).
   */
  worldScale: number | null;
  /** The intake that sent it, for `VRCDEPTHWANTS`. */
  source?: string;
};

export type VrcDepthStatus = {
  /** Block self-calibration (`blockCalibration.ts`), absent from older intakes. */
  calibration?: import("./blockCalibration.ts").CalibrationStatus & {
    world: string | null;
    layoutAssertedAt: number | null;
    layoutReason: string | null;
    /** The block's size for the camera and window (`blockFit.ts`). */
    fit?: import("./blockFit.ts").BlockFit;
    cameraSize?: import("./blockFit.ts").Size | null;
    window?: import("./blockFit.ts").Size | null;
  };
  /** Shared-capture lease (`CLAIMDEPTHCAPTURE`): expiries, re-grants, the intake's own stalls. */
  lease?: {
    owner: string | null;
    expiries: number;
    lastSilenceMs: number;
    lastExpiredAt: number;
    regrants: number;
    maxStallMs: number;
    /** The owner is the GPU capture helper, which a foreground claim (the debug view) preempts. */
    background?: boolean;
    /** The owner's kind: the GPU helper, webxr's headset source, or the debug view. */
    kind?: "helper" | "headset" | "view" | null;
    preemptions?: number;
  };
  /** The capture-only GPU helper (`desktopView` `captureOnly`) the intake runs for VR. */
  gpuHelper?: { actor: string | null; lastError: string | null };
  /** The intake's OS process, for per-process measurements (`utils/vrchat-depth-perf.ts`). */
  pid?: number;
  running: boolean;
  window: { id: number; width: number; height: number; x?: number; y?: number } | null;
  windowFrames: number;
  decoded: number;
  /** Distinct VRChat frames per second over the last couple of seconds. */
  framesPerSecond: number;
  decodeMs: number;
  lastFailure: string | null;
  /** Decode failures by reason, and window frames that repeated the previous VRChat frame. */
  failures: Record<string, number>;
  repeats: number;
  lastError: string | null;
  lastFrameAt: number | null;
  scale: {
    worldScale: number | null;
    avatarEyeHeight: number | null;
    realEyeHeight: number | null;
    realEyeHeightOverride: number | null;
    lastError: string | null;
  };
};

/**
 * 16-bit log depth for the wire: 0 = none, else 1..65535 spanning `near..far` logarithmically,
 * a relative step of ln(far/near)/65534 ≈ 0.021 % (0.2 mm at 1 m), finer than any block mode.
 */
export const DEPTH_LOG16 = { near: 0.01, far: 10000 } as const;
const LOG16_SPAN = Math.log(DEPTH_LOG16.far / DEPTH_LOG16.near);

export function encodeDepthLog16(depth: Float32Array): Uint16Array {
  const out = new Uint16Array(depth.length);
  const k = 65534 / LOG16_SPAN;
  for (let i = 0; i < depth.length; i++) {
    const d = depth[i];
    if (!(d > 0)) continue;
    const q = Math.round(Math.log(d / DEPTH_LOG16.near) * k);
    out[i] = 1 + Math.max(0, Math.min(65534, q));
  }
  return out;
}

export function decodeDepthLog16(codes: Uint16Array): Float32Array {
  const out = new Float32Array(codes.length);
  const k = LOG16_SPAN / 65534;
  for (let i = 0; i < codes.length; i++) {
    const q = codes[i];
    if (q !== 0) out[i] = DEPTH_LOG16.near * Math.exp((q - 1) * k);
  }
  return out;
}

/** The frame's depth grid in metres (0 = none), from either wire form. */
export function payloadDepth(
  payload: Pick<VrcDepthFramePayload, "depthLog16Base64" | "depthBase64">,
): Float32Array {
  if (payload.depthLog16Base64 != null) {
    const bytes = decodeBytesBase64(payload.depthLog16Base64);
    return decodeDepthLog16(new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1));
  }
  return payload.depthBase64 != null
    ? decodeFloat32Base64(payload.depthBase64)
    : new Float32Array(0);
}

export function encodeFloat32Base64(values: Float32Array): string {
  return encodeBytesBase64(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
}

export function encodeBytesBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function decodeFloat32Base64(text: string): Float32Array {
  return new Float32Array(decodeBytesBase64(text).buffer);
}

export function decodeBytesBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
