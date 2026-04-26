/**
 * SharedArrayBuffer wire format for OpenVR controller samples between the
 * `controllers` actor (writer) and the `webxr` worker (reader).
 *
 * v2: **double buffer** + Atomics — writer always fills the non-front slot, then
 * `Atomics.store(front, …)` so readers see only complete frames (no torn reads / judder
 * from seqlock retries returning null or mixed halves).
 *
 * v3: **+4 byte** `writeSeq` (monotonic per published sample) after the version field.
 * v4: **+16 byte** OpenVR **motion** header (|v|, |ω| per hand) + `hashPoseMatrices` in
 * `webxr` so `controller-stale` can detect **same pose on two 75Hz rAF ticks** while motion
 * says the controller is not static. (The SAB writer runs ~1kHz so `writeSeq` *always* jumps
 * between rAFs; seq-only stale was effectively dead.)
 */
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";

export const CONTROLLER_SAB_LAYOUT_VERSION = 4;

/** I32 front + U32 ver + U32 writeSeq + 4×F32 motion + 2×124 slots = 28 + 248 = 276. */
export const CONTROLLER_SAB_BYTE_LENGTH = 276;

const I32_FRONTSLOT = 0;
const U32_WIRE_VERSION = 4;
const U32_WRITE_SEQ = 8;
const F32_MOTION = 12;
const SLOT_SIZE = 124;
const DATA_OFFSET = 28;

/** Per-slot layout (offset from slot base). */
const S_LEFT_U8 = 0;
const S_LEFT_M = 8;
const S_RIGHT_U8 = 56;
const S_RIGHT_M = 64;
const S_DIGITAL = 120;

export type OpenVrPoseActionData = ReturnType<typeof OpenVR.InputPoseActionDataStruct.read>;
export type OpenVrDigitalActionData = ReturnType<typeof OpenVR.InputDigitalActionDataStruct.read>;

/** Same 6-tuple the WebXR path passes to `WebXRHost.setControllerData`. */
export type ControllerExternalDataTuple = [
  OpenVrPoseActionData,
  OpenVrPoseActionData,
  OpenVrDigitalActionData,
  OpenVrDigitalActionData,
  OpenVrDigitalActionData,
  OpenVrDigitalActionData,
];

export type ControllerSabRead = {
  data: ControllerExternalDataTuple;
  /** Increments on each `writeControllerStateSab` (after slot publish). */
  writeSeq: number;
  /** OpenVR |v| and |ω| for each hand, from the sample written with the visible slot. */
  motion: {
    leftLin: number;
    leftAng: number;
    rightLin: number;
    rightAng: number;
  };
};

function linAngMag(p: OpenVrPoseActionData): { lin: number; ang: number } {
  const v = p.pose.vVelocity.v;
  const w = p.pose.vAngularVelocity.v;
  return {
    lin: Math.hypot(v[0]!, v[1]!, v[2]!),
    ang: Math.hypot(w[0]!, w[1]!, w[2]!),
  };
}

function writeMotionHeader(
  view: DataView,
  data: ControllerExternalDataTuple,
) {
  const l = linAngMag(data[0]!);
  const r = linAngMag(data[1]!);
  view.setFloat32(F32_MOTION, l.lin, true);
  view.setFloat32(F32_MOTION + 4, l.ang, true);
  view.setFloat32(F32_MOTION + 8, r.lin, true);
  view.setFloat32(F32_MOTION + 12, r.ang, true);
}

/**
 * FNV-1a of quantized 3×4 matrices (both hands) for “same pose as last XR frame” tests.
 * Ignores velocity; use `read.motion` to gate on “not standing still” noise.
 */
export function hashControllerPoseMatrices(
  t: ControllerExternalDataTuple,
): number {
  let h = 2166136261 >>> 0;
  for (const idx of [0, 1] as const) {
    const m = t[idx]!.pose.mDeviceToAbsoluteTracking.m;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        const q = Math.round(m[r]![c]! * 1e4) | 0;
        h = Math.imul(h ^ q, 16777619) >>> 0;
      }
    }
  }
  return h >>> 0;
}

function m33FromFlat12(f: Float32Array): [
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
] {
  return [
    [f[0]!, f[1]!, f[2]!, f[3]!],
    [f[4]!, f[5]!, f[6]!, f[7]!],
    [f[8]!, f[9]!, f[10]!, f[11]!],
  ];
}

function makeDigital(bState: boolean): OpenVrDigitalActionData {
  return {
    bActive: 1,
    activeOrigin: 0n,
    bState: bState ? 1 : 0,
    bChanged: 0,
    fUpdateTime: 0,
  };
}

function makePose(
  bActive: boolean,
  bPoseIsValid: boolean,
  m: [
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
  ],
): OpenVrPoseActionData {
  return {
    bActive: bActive ? 1 : 0,
    activeOrigin: 0n,
    pose: {
      mDeviceToAbsoluteTracking: { m },
      vVelocity: { v: [0, 0, 0] },
      vAngularVelocity: { v: [0, 0, 0] },
      eTrackingResult: 0,
      bPoseIsValid: bPoseIsValid ? 1 : 0,
      bDeviceIsConnected: bPoseIsValid ? 1 : 0,
    },
  };
}

function writeHand(
  view: DataView,
  slotBase: number,
  pose: OpenVrPoseActionData,
) {
  const bActive = Boolean(pose.bActive) ? 1 : 0;
  const bValid = Boolean(pose.pose.bPoseIsValid) ? 1 : 0;
  view.setUint8(slotBase + S_LEFT_U8, bActive);
  view.setUint8(slotBase + S_LEFT_U8 + 1, bValid);
  const m = pose.pose.mDeviceToAbsoluteTracking.m;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      view.setFloat32(
        slotBase + S_LEFT_M + (r * 4 + c) * 4,
        m[r]![c]!,
        true,
      );
    }
  }
}

function writeHandRight(
  view: DataView,
  slotBase: number,
  pose: OpenVrPoseActionData,
) {
  const bActive = Boolean(pose.bActive) ? 1 : 0;
  const bValid = Boolean(pose.pose.bPoseIsValid) ? 1 : 0;
  view.setUint8(slotBase + S_RIGHT_U8, bActive);
  view.setUint8(slotBase + S_RIGHT_U8 + 1, bValid);
  const m = pose.pose.mDeviceToAbsoluteTracking.m;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      view.setFloat32(
        slotBase + S_RIGHT_M + (r * 4 + c) * 4,
        m[r]![c]!,
        true,
      );
    }
  }
}

/** One-time: wire version + `front=0` (webxr allocs, then `SETCONTROLLERSHAREDSTATE`). */
export function initControllerStateSab(sab: SharedArrayBuffer) {
  if (sab.byteLength !== CONTROLLER_SAB_BYTE_LENGTH) {
    return;
  }
  const view = new DataView(sab);
  view.setUint32(U32_WIRE_VERSION, CONTROLLER_SAB_LAYOUT_VERSION, true);
  Atomics.store(new Int32Array(sab, 0, 1), I32_FRONTSLOT, 0);
  Atomics.store(new Uint32Array(sab, U32_WRITE_SEQ, 1), 0, 0);
  const v = new DataView(sab);
  for (let o = 0; o < 16; o += 4) {
    v.setFloat32(F32_MOTION + o, 0, true);
  }
}

/**
 * Writer: fill the **back** slot (not `Atomics.load(front)`), then
 * `Atomics.store(front, back)` so readers only ever see a full slot.
 */
export function writeControllerStateSab(sab: SharedArrayBuffer, data: ControllerExternalDataTuple) {
  if (sab.byteLength !== CONTROLLER_SAB_BYTE_LENGTH) {
    return;
  }
  const i32 = new Int32Array(sab, 0, 1);
  const view = new DataView(sab);

  const front = Atomics.load(i32, I32_FRONTSLOT) & 1;
  const back = front ^ 1;
  const base = DATA_OFFSET + back * SLOT_SIZE;

  writeHand(view, base, data[0]!);
  writeHandRight(view, base, data[1]!);
  const lt = data[2]!.bState ? 1 : 0;
  const rt = data[3]!.bState ? 1 : 0;
  const lg = data[4]!.bState ? 1 : 0;
  const rg = data[5]!.bState ? 1 : 0;
  view.setUint8(base + S_DIGITAL, lt);
  view.setUint8(base + S_DIGITAL + 1, rt);
  view.setUint8(base + S_DIGITAL + 2, lg);
  view.setUint8(base + S_DIGITAL + 3, rg);

  writeMotionHeader(view, data);
  Atomics.store(i32, I32_FRONTSLOT, back);
  Atomics.add(new Uint32Array(sab, U32_WRITE_SEQ, 1), 0, 1);
}

const flatScratch = new Float32Array(12);

const identity3x4: [
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
] = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
];

function readHand(
  view: DataView,
  slotBase: number,
  left: boolean,
): OpenVrPoseActionData {
  const u8 = left ? S_LEFT_U8 : S_RIGHT_U8;
  const f32 = left ? S_LEFT_M : S_RIGHT_M;
  const bActive = view.getUint8(slotBase + u8) !== 0;
  const bPoseIsValid = view.getUint8(slotBase + u8 + 1) !== 0;
  for (let i = 0; i < 12; i++) {
    flatScratch[i] = view.getFloat32(slotBase + f32 + i * 4, true);
  }
  const m = bPoseIsValid ? m33FromFlat12(flatScratch) : identity3x4;
  return makePose(bActive, bPoseIsValid, m);
}

/**
 * Reconstructs the tuple used by the WebXR host. `null` if buffer size or
 * layout version in header is wrong.
 */
export function readControllerStateSab(sab: SharedArrayBuffer): ControllerSabRead | null {
  if (sab.byteLength !== CONTROLLER_SAB_BYTE_LENGTH) {
    return null;
  }
  const i32 = new Int32Array(sab, 0, 1);
  const view = new DataView(sab);

  if (view.getUint32(U32_WIRE_VERSION, true) !== CONTROLLER_SAB_LAYOUT_VERSION) {
    return null;
  }

  const slot = Atomics.load(i32, I32_FRONTSLOT) & 1;
  const base = DATA_OFFSET + slot * SLOT_SIZE;

  const left = readHand(view, base, true);
  const right = readHand(view, base, false);
  const lt = view.getUint8(base + S_DIGITAL) !== 0;
  const rt = view.getUint8(base + S_DIGITAL + 1) !== 0;
  const lg = view.getUint8(base + S_DIGITAL + 2) !== 0;
  const rg = view.getUint8(base + S_DIGITAL + 3) !== 0;
  const writeSeq = Atomics.load(new Uint32Array(sab, U32_WRITE_SEQ, 1), 0) >>> 0;
  const leftLin = view.getFloat32(F32_MOTION, true);
  const leftAng = view.getFloat32(F32_MOTION + 4, true);
  const rightLin = view.getFloat32(F32_MOTION + 8, true);
  const rightAng = view.getFloat32(F32_MOTION + 12, true);

  return {
    data: [left, right, makeDigital(lt), makeDigital(rt), makeDigital(lg), makeDigital(rg)],
    writeSeq,
    motion: { leftLin, leftAng, rightLin, rightAng },
  };
}
