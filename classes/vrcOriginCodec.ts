/**
 * Decoder for VRChat avatar world-origin OSC parameters.
 *
 * Supports three protocols, preferred in this order:
 * 0. `PetPlay/OriginV2/*` (Modular Avatar prefab, VRChat SDK 3.10+ contact SenderLocalPosition):
 *    - Two receivers at world origin report the local position of a sender at `anchor * 2^-N`
 *      (`Pos`) and of a second sender `2^(F-N)` ahead of it along the anchor's yaw (`Fwd`), F = 3.
 *    - `position = Pos * 2^N`, `yaw = atan2(dx, dz)` of `Fwd - Pos`; `|Fwd - Pos| = 2^(F-N)` gives N.
 *    - `Pos` / `Fwd` themselves are 1 while the sender is inside its receiver (validity).
 *    - The scale is a power of two and the receiver sits at exactly 0, so the decode carries the
 *      float32 precision of the world coordinate; range is `2^N` m (N = 13 -> 8192 m).
 * 1. `PetPlay/Origin/*` (release-grade local-only Modular Avatar prefab):
 *    - 6 overlapping proximity contacts (`Pos{X,Y,Z}{Pos,Neg}`):
 *      - Receivers sit at `±RECEIVER_OFFSET` (2.5 m) with `RECEIVER_RADIUS` (3.0 m) on each axis.
 *      - Senders move to `s = (RECEIVER_OFFSET / RANGE_METERS) * worldCoord` with `RANGE_METERS = 512`.
 *      - Around world origin (`|worldCoord| <= 102.4 m`), both Pos and Neg are strictly positive
 *        (`pos + neg == 1/3`), avoiding VRChat's proximity-zero edge glitch without any offset hack.
 *      - Outside the overlap band, the active receiver is strictly > 1/3.
 *      - Both 0 means the rig is inactive or out of range.
 *    - 2 PhysBone angle outputs (`YawMag_Angle`, `YawSign_Angle`):
 *      - `YawMag` rest vector is `(0, 0, 1)`, deflected to `(sin(yaw), 0, cos(yaw))` -> `cos(yaw) = cos(pi * mag)`.
 *      - `YawSign` rest vector is `(1, 0, 0)`, deflected to `(sin(yaw), 0, cos(yaw))` -> `sin(yaw) = cos(pi * sign)`.
 *      - `yaw = atan2(cos(pi * sign), cos(pi * mag))` is continuous across all 360 degrees.
 *
 * 2. Legacy `CustomObjectSync/*` (VRLabs Custom Object Sync 1.0.4):
 *    - `Position{X,Y,Z}` in `[0, 1]` -> `(v - 0.5) * 2^(maxRadius + 1)` (default `maxRadius = 8` -> ±256 m).
 *    - `RotationY` in `[0, 1]` -> `v * 2 * pi`, or raw `AngleMagY_Angle` + `AngleSignY_Angle`.
 */

export type Vec3 = [number, number, number];

export type VrcOriginSource = "petplay-origin-v2" | "petplay-origin" | "custom-object-sync";

export interface VrcOriginWorldPose {
  source: VrcOriginSource;
  /** Avatar anchor position in VRChat (Unity left-handed) world space, in metres. */
  position: Vec3;
  /** Avatar anchor yaw in VRChat (Unity left-handed, radians, +Y clockwise from above). */
  yawRad: number;
}

export const PETPLAY_ORIGIN_V2_PREFIX = "/avatar/parameters/PetPlay/OriginV2/";
export const PETPLAY_ORIGIN_PREFIX = "/avatar/parameters/PetPlay/Origin/";
export const CUSTOM_OBJECT_SYNC_PREFIX = "/avatar/parameters/CustomObjectSync/";

export const PETPLAY_ORIGIN_PARAMS = {
  posXPos: `${PETPLAY_ORIGIN_PREFIX}PosXPos`,
  posXNeg: `${PETPLAY_ORIGIN_PREFIX}PosXNeg`,
  posYPos: `${PETPLAY_ORIGIN_PREFIX}PosYPos`,
  posYNeg: `${PETPLAY_ORIGIN_PREFIX}PosYNeg`,
  posZPos: `${PETPLAY_ORIGIN_PREFIX}PosZPos`,
  posZNeg: `${PETPLAY_ORIGIN_PREFIX}PosZNeg`,
  yawMag: `${PETPLAY_ORIGIN_PREFIX}YawMag_Angle`,
  yawSign: `${PETPLAY_ORIGIN_PREFIX}YawSign_Angle`,
} as const;

/** The v2 outputs; `_SenderLocalPosition*` suffixes are VRChat's contact advanced parameters. */
export const PETPLAY_ORIGIN_V2_PARAMS = {
  pos: `${PETPLAY_ORIGIN_V2_PREFIX}Pos`,
  posX: `${PETPLAY_ORIGIN_V2_PREFIX}Pos_SenderLocalPositionX`,
  posY: `${PETPLAY_ORIGIN_V2_PREFIX}Pos_SenderLocalPositionY`,
  posZ: `${PETPLAY_ORIGIN_V2_PREFIX}Pos_SenderLocalPositionZ`,
  fwd: `${PETPLAY_ORIGIN_V2_PREFIX}Fwd`,
  fwdX: `${PETPLAY_ORIGIN_V2_PREFIX}Fwd_SenderLocalPositionX`,
  fwdY: `${PETPLAY_ORIGIN_V2_PREFIX}Fwd_SenderLocalPositionY`,
  fwdZ: `${PETPLAY_ORIGIN_V2_PREFIX}Fwd_SenderLocalPositionZ`,
} as const;

/** N the v2 prefab is built with (`PetPlayOriginV2PrefabBuilder.ScaleExponent`). The decoder
 * measures N from the forward offset, so this is only the expected value. */
export const PETPLAY_ORIGIN_V2_SCALE_EXPONENT = 13;
/** F: the forward sender sits `2^(F-N)` ahead, `2^F` m in world terms
 * (`PetPlayOriginV2PrefabBuilder.FwdOffsetExponent`). */
export const PETPLAY_ORIGIN_V2_FWD_OFFSET_EXPONENT = 3;
/** Accepted distance of `-log2 |Fwd - Pos|` from an integer N. OSC delivers each parameter on its
 * own, so a decode can pair a new `Pos` with a frame-old `Fwd`; that skews the 8 m offset by the
 * metres moved in that frame, and 0.25 (about ±19 %, 1.5 m) keeps any locomotion decodable. */
const V2_EXPONENT_TOLERANCE = 0.25;
/** Validity threshold on the Constant receivers' `Pos` / `Fwd` outputs. */
const V2_PRESENT_MIN = 0.5;

export const CUSTOM_OBJECT_SYNC_PARAMS = {
  posX: `${CUSTOM_OBJECT_SYNC_PREFIX}PositionX`,
  posY: `${CUSTOM_OBJECT_SYNC_PREFIX}PositionY`,
  posZ: `${CUSTOM_OBJECT_SYNC_PREFIX}PositionZ`,
  rotY: `${CUSTOM_OBJECT_SYNC_PREFIX}RotationY`,
  angleMagY: `${CUSTOM_OBJECT_SYNC_PREFIX}AngleMagY_Angle`,
  angleSignY: `${CUSTOM_OBJECT_SYNC_PREFIX}AngleSignY_Angle`,
} as const;

/** Half-span of the PetPlay Origin contact rig in metres (`[-512, +512]` m per axis). */
export const PETPLAY_ORIGIN_RANGE_METERS = 512;
/** Distance of each +/- proximity receiver from the Measure origin, in metres. */
export const PETPLAY_ORIGIN_RECEIVER_OFFSET = 2.5;
/** Radius of each proximity receiver sphere, in metres (VRChat max is 3.0 m). */
export const PETPLAY_ORIGIN_RECEIVER_RADIUS = 3.0;
/** Overlap half-width in scaled sender units (`radius - offset = 0.5`). */
const PETPLAY_ORIGIN_OVERLAP = PETPLAY_ORIGIN_RECEIVER_RADIUS - PETPLAY_ORIGIN_RECEIVER_OFFSET;
/** Threshold below which a proximity contact is treated as inactive / zero. */
const CONTACT_ACTIVE_EPS = 1e-6;

/**
 * Decodes one axis from overlapping proximity contact values `[pos, neg]`.
 * Returns `null` when both contacts are 0 (rig inactive or out of range).
 */
export function decodeOverlappingProximityAxis(
  pos: number,
  neg: number,
  rangeMeters = PETPLAY_ORIGIN_RANGE_METERS,
  receiverOffset = PETPLAY_ORIGIN_RECEIVER_OFFSET,
  receiverRadius = PETPLAY_ORIGIN_RECEIVER_RADIUS,
): number | null {
  if (!Number.isFinite(pos) || !Number.isFinite(neg)) return null;
  const posActive = pos > CONTACT_ACTIVE_EPS;
  const negActive = neg > CONTACT_ACTIVE_EPS;
  if (!posActive && !negActive) return null;

  const overlap = receiverRadius - receiverOffset;
  let scaled: number;
  if (posActive && negActive) {
    // Both receivers active: average the two independent estimates:
    // s_pos = R * pos - overlap, s_neg = overlap - R * neg -> mean = 0.5 * R * (pos - neg)
    scaled = 0.5 * receiverRadius * (pos - neg);
  } else if (posActive) {
    scaled = receiverRadius * pos - overlap;
  } else {
    scaled = overlap - receiverRadius * neg;
  }

  return scaled * (rangeMeters / receiverOffset);
}

/**
 * Encodes a world coordinate into synthetic `[pos, neg]` proximity values for testing.
 */
export function encodeOverlappingProximityAxis(
  worldMeters: number,
  rangeMeters = PETPLAY_ORIGIN_RANGE_METERS,
  receiverOffset = PETPLAY_ORIGIN_RECEIVER_OFFSET,
  receiverRadius = PETPLAY_ORIGIN_RECEIVER_RADIUS,
): [number, number] {
  const scaled = worldMeters * (receiverOffset / rangeMeters);
  const distPos = Math.abs(scaled - receiverOffset);
  const distNeg = Math.abs(scaled + receiverOffset);
  const pos = distPos < receiverRadius ? 1 - distPos / receiverRadius : 0;
  const neg = distNeg < receiverRadius ? 1 - distNeg / receiverRadius : 0;
  return [pos, neg];
}

/**
 * Decodes yaw in radians from PhysBone `YawMag_Angle` and `YawSign_Angle` (`[0, 1]`).
 * Returns a value in `(-pi, pi]` matching Unity's left-handed Y rotation.
 */
export function decodePhysBoneYawRad(yawMagAngle: number, yawSignAngle: number): number {
  const cosYaw = Math.cos(Math.PI * clamp01(yawMagAngle));
  const sinYaw = Math.cos(Math.PI * clamp01(yawSignAngle));
  return Math.atan2(sinYaw, cosYaw);
}

/**
 * Encodes a Unity yaw angle in radians into synthetic `[yawMagAngle, yawSignAngle]` for testing.
 */
export function encodePhysBoneYawRad(yawRad: number): [number, number] {
  const cosYaw = Math.cos(yawRad);
  const sinYaw = Math.sin(yawRad);
  return [
    Math.acos(Math.max(-1, Math.min(1, cosYaw))) / Math.PI,
    Math.acos(Math.max(-1, Math.min(1, sinYaw))) / Math.PI,
  ];
}

export interface DecodeVrcOriginOptions {
  /** Legacy VRLabs CustomObjectSync `maxRadius` exponent (default 8 -> ±256 m). */
  legacyMaxRadius?: number;
}

/**
 * Decodes VRChat world-space avatar pose from a map of OSC `/avatar/parameters/...` values.
 * Prefers `PetPlay/OriginV2/*`, then `PetPlay/Origin/*`, then legacy `CustomObjectSync/*`.
 */
export function decodeVrcOriginPose(
  coords: Readonly<Record<string, number>>,
  options: DecodeVrcOriginOptions = {},
): VrcOriginWorldPose | null {
  const v2Pose = decodePetPlayOriginV2Pose(coords);
  if (v2Pose) return v2Pose;
  const petplayPose = decodePetPlayOriginPose(coords);
  if (petplayPose) return petplayPose;
  return decodeLegacyCustomObjectSyncPose(coords, options.legacyMaxRadius ?? 8);
}

/**
 * Decodes the v2 rig. Null until both receivers report their sender inside, or when the forward
 * offset is not a power of two (a torn or foreign reading).
 */
export function decodePetPlayOriginV2Pose(
  coords: Readonly<Record<string, number>>,
): VrcOriginWorldPose | null {
  const P = PETPLAY_ORIGIN_V2_PARAMS;
  if (!((coords[P.pos] ?? 0) > V2_PRESENT_MIN) || !((coords[P.fwd] ?? 0) > V2_PRESENT_MIN)) {
    return null;
  }
  // VRChat only sends a parameter when it changes, so an unseen component is still its default 0.
  const px = coords[P.posX] ?? 0, py = coords[P.posY] ?? 0, pz = coords[P.posZ] ?? 0;
  const dx = (coords[P.fwdX] ?? 0) - px;
  const dy = (coords[P.fwdY] ?? 0) - py;
  const dz = (coords[P.fwdZ] ?? 0) - pz;
  if (![px, py, pz, dx, dy, dz].every(Number.isFinite)) return null;
  const length = Math.hypot(dx, dy, dz);
  if (!(length > 0)) return null;
  const exponent = -Math.log2(length);
  const n = Math.round(exponent);
  if (Math.abs(exponent - n) > V2_EXPONENT_TOLERANCE) return null;
  const scale = 2 ** (n + PETPLAY_ORIGIN_V2_FWD_OFFSET_EXPONENT);
  return {
    source: "petplay-origin-v2",
    position: [px * scale, py * scale, pz * scale],
    yawRad: Math.atan2(dx, dz),
  };
}

/**
 * Encodes a world pose as the v2 rig's OSC values for testing, rounding through float32 the way
 * the constraint and contact solve would.
 */
export function encodePetPlayOriginV2Pose(
  position: Vec3,
  yawRad: number,
  scaleExponent = PETPLAY_ORIGIN_V2_SCALE_EXPONENT,
): Record<string, number> {
  const f = Math.fround;
  const s = f(2 ** -scaleExponent);
  const offset = f(2 ** (PETPLAY_ORIGIN_V2_FWD_OFFSET_EXPONENT - scaleExponent));
  const p = position.map((v) => f(f(v) * s));
  const fwd = [
    f(p[0] + f(offset * f(Math.sin(yawRad)))),
    p[1],
    f(p[2] + f(offset * f(Math.cos(yawRad)))),
  ];
  const P = PETPLAY_ORIGIN_V2_PARAMS;
  return {
    [P.pos]: 1,
    [P.posX]: p[0],
    [P.posY]: p[1],
    [P.posZ]: p[2],
    [P.fwd]: 1,
    [P.fwdX]: fwd[0],
    [P.fwdY]: fwd[1],
    [P.fwdZ]: fwd[2],
  };
}

export function decodePetPlayOriginPose(
  coords: Readonly<Record<string, number>>,
): VrcOriginWorldPose | null {
  const xPos = coords[PETPLAY_ORIGIN_PARAMS.posXPos];
  const xNeg = coords[PETPLAY_ORIGIN_PARAMS.posXNeg];
  const yPos = coords[PETPLAY_ORIGIN_PARAMS.posYPos];
  const yNeg = coords[PETPLAY_ORIGIN_PARAMS.posYNeg];
  const zPos = coords[PETPLAY_ORIGIN_PARAMS.posZPos];
  const zNeg = coords[PETPLAY_ORIGIN_PARAMS.posZNeg];

  // Missing parameters default to 0 if at least one PetPlay/Origin parameter has been received
  // (VRChat only emits OSC messages when a parameter changes from its default 0).
  const hasAnyPetPlayParam = xPos !== undefined || xNeg !== undefined ||
    yPos !== undefined || yNeg !== undefined ||
    zPos !== undefined || zNeg !== undefined ||
    coords[PETPLAY_ORIGIN_PARAMS.yawMag] !== undefined ||
    coords[PETPLAY_ORIGIN_PARAMS.yawSign] !== undefined;
  if (!hasAnyPetPlayParam) return null;

  const x = decodeOverlappingProximityAxis(xPos ?? 0, xNeg ?? 0);
  const y = decodeOverlappingProximityAxis(yPos ?? 0, yNeg ?? 0);
  const z = decodeOverlappingProximityAxis(zPos ?? 0, zNeg ?? 0);
  if (x === null || y === null || z === null) return null;

  const yawMag = coords[PETPLAY_ORIGIN_PARAMS.yawMag];
  const yawSign = coords[PETPLAY_ORIGIN_PARAMS.yawSign];
  const yawRad = yawMag !== undefined && yawSign !== undefined
    ? decodePhysBoneYawRad(yawMag, yawSign)
    : 0;

  return {
    source: "petplay-origin",
    position: [x, y, z],
    yawRad,
  };
}

export function decodeLegacyCustomObjectSyncPose(
  coords: Readonly<Record<string, number>>,
  maxRadius = 8,
): VrcOriginWorldPose | null {
  const rawX = coords[CUSTOM_OBJECT_SYNC_PARAMS.posX];
  const rawY = coords[CUSTOM_OBJECT_SYNC_PARAMS.posY];
  const rawZ = coords[CUSTOM_OBJECT_SYNC_PARAMS.posZ];
  if (rawX === undefined || rawY === undefined || rawZ === undefined) return null;

  const span = Math.pow(2, maxRadius + 1);
  const x = (rawX - 0.5) * span;
  const y = (rawY - 0.5) * span;
  const z = (rawZ - 0.5) * span;

  let yawRad = 0;
  const mag = coords[CUSTOM_OBJECT_SYNC_PARAMS.angleMagY];
  const sign = coords[CUSTOM_OBJECT_SYNC_PARAMS.angleSignY];
  if (mag !== undefined && sign !== undefined) {
    yawRad = decodePhysBoneYawRad(mag, sign);
  } else if (coords[CUSTOM_OBJECT_SYNC_PARAMS.rotY] !== undefined) {
    yawRad = coords[CUSTOM_OBJECT_SYNC_PARAMS.rotY] * 2 * Math.PI;
  }

  return {
    source: "custom-object-sync",
    position: [x, y, z],
    yawRad,
  };
}

export function isVrcOriginOscAddress(address: string): boolean {
  return address.startsWith(PETPLAY_ORIGIN_V2_PREFIX) ||
    address.startsWith(PETPLAY_ORIGIN_PREFIX) ||
    address.startsWith(CUSTOM_OBJECT_SYNC_PREFIX);
}

/**
 * Checks whether the two overlapping proximity values on one axis agree within tolerance
 * (in the overlap band `pos + neg` is identically `(radius - offset) * 2 / radius = 1/3`).
 */
export function isOverlappingProximityConsistent(
  pos: number,
  neg: number,
  tolerance = 0.02,
): boolean {
  if (pos <= CONTACT_ACTIVE_EPS || neg <= CONTACT_ACTIVE_EPS) return true;
  const expectedSum = (2 * PETPLAY_ORIGIN_OVERLAP) / PETPLAY_ORIGIN_RECEIVER_RADIUS;
  return Math.abs((pos + neg) - expectedSum) <= tolerance;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
