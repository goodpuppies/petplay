/**
 * Each hand's laser pose relative to its controller's tip (the render model's `/pose/tip`, which
 * is the emulated target-ray space). Edited in edit layout mode by grabbing the laser's handle
 * with the other hand (`LaserOffsetHandle` in `petplayXrController.tsx`).
 *
 * Only the lasers (the select ray and the grab ray) take the offset. The grip, and with it the
 * wrist menu, the grab sphere and the controller model, stays on the tip.
 *
 * Saved per controller model and hand ("<render model>/<hand>"), since tips differ between
 * controllers and each hand may want its own. {@link mirrorLaserOffset} copies one laser onto the
 * other hand once, as its mirror image. A laser stays within {@link LASER_OFFSET_MAX_DISTANCE} of
 * its tip. Module state lives in the scene's worker.
 */
import * as THREE from "three/webgpu";
import { getSetting, setSetting, subscribeSettings } from "../settings.ts";
import type { PoseOffset } from "./wristMenu/offset.ts";

export type LaserHand = "left" | "right";

const models: Record<LaserHand, string | null> = { left: null, right: null };
/** While a handle is being dragged: shown live, saved when it is let go. */
const live: Record<LaserHand, PoseOffset | null> = { left: null, right: null };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeLaserOffsets(listener: () => void): () => void {
  listeners.add(listener);
  const unsubscribeSettings = subscribeSettings(listener);
  return () => {
    listeners.delete(listener);
    unsubscribeSettings();
  };
}

/** The connected controller's render model for a hand (from the OpenVR controller resolver). */
export function setLaserControllerModel(hand: LaserHand, model: string | null): void {
  if (models[hand] === model) return;
  models[hand] = model;
  emit();
}

export function laserOffsetKey(hand: LaserHand, model = models[hand]): string {
  return `${model ?? "unknown"}/${hand}`;
}

/** How far a laser's origin may sit from its controller's tip, in metres. */
export const LASER_OFFSET_MAX_DISTANCE = 0.15;

/** The offset with its origin pulled back within {@link LASER_OFFSET_MAX_DISTANCE} of the tip. */
export function clampLaserOffset(offset: PoseOffset): PoseOffset {
  const [x, y, z] = offset.position;
  const distance = Math.hypot(x, y, z);
  if (distance <= LASER_OFFSET_MAX_DISTANCE) return offset;
  const k = LASER_OFFSET_MAX_DISTANCE / distance;
  return { position: [x * k, y * k, z * k], rotation: offset.rotation };
}

/** The offset in effect: a drag in progress, else the saved one, else none (`null`). */
export function getLaserOffset(hand: LaserHand): PoseOffset | null {
  const offset = live[hand] ?? getSetting("laserOffsets")[laserOffsetKey(hand)];
  return offset == null ? null : clampLaserOffset(offset);
}

export function otherLaserHand(hand: LaserHand): LaserHand {
  return hand === "left" ? "right" : "left";
}

/**
 * The same pose on the other hand: reflected across the tip frame's YZ plane (negate x, and the
 * quaternion's y and z), as the left and right controllers are reflections of each other.
 */
export function mirrorPoseOffset(offset: PoseOffset): PoseOffset {
  const [x, y, z] = offset.position;
  const [qx, qy, qz, qw] = offset.rotation;
  return { position: [-x, y, z], rotation: [qx, -qy, -qz, qw] };
}

export function setLiveLaserOffset(hand: LaserHand, offset: PoseOffset | null): void {
  live[hand] = offset == null ? null : clampLaserOffset(offset);
}

export function saveLaserOffset(hand: LaserHand, offset: PoseOffset): void {
  live[hand] = null;
  setSetting("laserOffsets", {
    ...getSetting("laserOffsets"),
    [laserOffsetKey(hand)]: clampLaserOffset(offset),
  });
}

/** Back to the controller's own tip. */
export function resetLaserOffset(hand: LaserHand): void {
  live[hand] = null;
  const next = { ...getSetting("laserOffsets") };
  delete next[laserOffsetKey(hand)];
  setSetting("laserOffsets", next);
}

/** Once: makes the other hand's laser the mirror image of `source`'s (the tip, if it has none). */
export function mirrorLaserOffset(source: LaserHand): void {
  const offset = getLaserOffset(source);
  const other = otherLaserHand(source);
  if (offset == null) resetLaserOffset(other);
  else saveLaserOffset(other, mirrorPoseOffset(offset));
}

/** Poses `object` (a child of target-ray space) at the hand's laser offset. */
export function applyLaserOffset(object: THREE.Object3D, hand: LaserHand): void {
  const offset = getLaserOffset(hand);
  if (offset == null) {
    object.position.set(0, 0, 0);
    object.quaternion.identity();
  } else {
    object.position.fromArray(offset.position);
    object.quaternion.fromArray(offset.rotation);
  }
}

/** The offset as a matrix (target ray → laser); identity when there is none. */
export function laserOffsetMatrix(hand: LaserHand, out: THREE.Matrix4): THREE.Matrix4 {
  const offset = getLaserOffset(hand);
  if (offset == null) return out.identity();
  return out.compose(
    position.fromArray(offset.position),
    quaternion.fromArray(offset.rotation),
    UNIT,
  );
}

/** A pose offset from an object's local transform (rigid; scale is ignored). */
export function poseOffsetOf(object: THREE.Object3D): PoseOffset {
  return {
    position: object.position.toArray() as [number, number, number],
    rotation: object.quaternion.toArray() as [number, number, number, number],
  };
}

const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const UNIT = new THREE.Vector3(1, 1, 1);
