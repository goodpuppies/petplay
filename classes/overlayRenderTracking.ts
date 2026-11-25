import * as THREE from "three";
import { createDefaultLowerers, type RenderLowerer } from "../submodules/raythree/src/lib.ts";
import type { WebXRRaythreeRenderPayload } from "./webxrRaythreeScene.ts";

export type RenderAnchorSpace = "head" | "left-hand" | "right-hand" | "left-ray" | "right-ray";
export type RenderAnchor = {
  space: RenderAnchorSpace;
  localMatrix: Float64Array;
  /** Carried by a grab ({@link RenderTrackingFollow}) rather than parented to the space. */
  follow?: true;
  /** Carried by two hands: held in the {@link followFrame} spanning both grab points. */
  pair?: FollowPair;
};

/** The second hand of a two-hand grab, and each pointer's grab point in its own space. */
export type FollowPair = {
  space: RenderAnchorSpace;
  points: [ArrayLike<number>, ArrayLike<number>];
};
export type Anchored = { renderAnchor?: RenderAnchor };
export type RenderAnchors = Partial<Record<RenderAnchorSpace, ArrayLike<number>>>;
const spaces: readonly string[] = ["head", "left-hand", "right-hand", "left-ray", "right-ray"];

/**
 * Set on a subtree root (`userData.renderTrackingFollow`) while something tracked carries it but
 * it is not parented there: a window held by a controller. Its items are sent relative to `pose`,
 * the world pose of `space` that the worker placed the subtree from, so the renderer re-poses them
 * with its own fresh tracking like children of that space. `pose` must be the exact sample used
 * (a grab's pointer pose at apply time): any other sample of the same space differs by up to a
 * frame of hand motion, which shows as jitter. `active` lets a grab that ended without notice
 * lapse.
 */
export type RenderTrackingFollow = {
  space: RenderAnchorSpace;
  /** The {@link followFrame} the worker placed the subtree from. */
  pose: THREE.Matrix4;
  active: () => boolean;
  pair?: FollowPair;
};

/** Key of a carry's frame: one pointer space, or both for two hands. */
export function followKey(space: RenderAnchorSpace, pair?: FollowPair): string {
  return pair == null ? space : `${space}+${pair.space}`;
}

const frameA = new THREE.Matrix4();
const frameB = new THREE.Matrix4();
const pointA = new THREE.Vector3();
const pointB = new THREE.Vector3();
const frameX = new THREE.Vector3();
const frameY = new THREE.Vector3();
const frameZ = new THREE.Vector3();
const upB = new THREE.Vector3();

/**
 * The frame a carried subtree is held in. One hand: the pointer pose. Two hands: origin at the
 * midpoint of the grab points, x from the first to the second, up from both hands' up directions,
 * uniformly scaled by their distance. A two-pointer grab moves, turns, twists and scales the
 * window with exactly these quantities, so between worker frames the window stays put in this
 * frame and the renderer can carry it with fresh poses of both controllers.
 */
export function followFrame(
  anchors: Partial<Record<string, ArrayLike<number>>>,
  space: RenderAnchorSpace,
  pair: FollowPair | undefined,
  target = new THREE.Matrix4(),
): THREE.Matrix4 | null {
  const a = anchors[space];
  if (!a) return null;
  if (pair == null) return target.fromArray(a as number[]);
  const b = anchors[pair.space];
  if (!b) return null;
  frameA.fromArray(a as number[]);
  frameB.fromArray(b as number[]);
  pointA.fromArray(pair.points[0] as number[]).applyMatrix4(frameA);
  pointB.fromArray(pair.points[1] as number[]).applyMatrix4(frameB);
  frameX.subVectors(pointB, pointA);
  const distance = frameX.length();
  if (distance < 1e-6) return null;
  frameX.divideScalar(distance);
  frameY.set(0, 1, 0).transformDirection(frameA).add(upB.set(0, 1, 0).transformDirection(frameB));
  frameY.addScaledVector(frameX, -frameY.dot(frameX));
  if (frameY.lengthSq() < 1e-8) {
    // Both hands' up directions lie along the axis: any perpendicular is as good.
    frameY.set(0, 0, 1).addScaledVector(frameX, -frameX.z);
    if (frameY.lengthSq() < 1e-8) frameY.set(0, 1, 0).addScaledVector(frameX, -frameX.y);
  }
  frameY.normalize();
  frameZ.crossVectors(frameX, frameY);
  target.makeBasis(frameX, frameY, frameZ);
  target.scale(upB.setScalar(distance));
  return target.setPosition(pointA.add(pointB).multiplyScalar(0.5));
}

/** IWER defines grip space relative to its target-ray space, rather than the tracked device. */
export function setRenderHandAnchors(
  anchors: RenderAnchors,
  hand: "left" | "right",
  targetRay: ArrayLike<number>,
  gripOffset?: ArrayLike<number>,
): void {
  anchors[`${hand}-ray`] = targetRay;
  anchors[`${hand}-hand`] = gripOffset
    ? new THREE.Matrix4().fromArray(targetRay).multiply(new THREE.Matrix4().fromArray(gripOffset))
      .elements
    : targetRay;
}

/**
 * The nearest tracked root defines a local transform, without baking its old tracking pose.
 *
 * Returns `previous` itself when the anchor is unchanged: UI snapshots are rebuilt every frame,
 * and a fresh anchor per item per frame was a large share of the scene worker's promoted garbage.
 */
export function captureRenderAnchor(
  object: THREE.Object3D,
  worldMatrix: ArrayLike<number>,
  /** Transform of `worldMatrix` relative to `object` (an instance matrix), if any. */
  objectLocal?: ArrayLike<number>,
  previous?: RenderAnchor,
  /** Where `objectLocal`'s 16 elements start. */
  objectLocalOffset = 0,
): RenderAnchor | undefined {
  for (let root: THREE.Object3D | null = object; root; root = root.parent) {
    const follow = root.userData?.renderTrackingFollow as RenderTrackingFollow | undefined;
    if (follow?.active() && spaces.includes(follow.space)) {
      const inv = getFollowPoseInverse(follow.pose);
      if (inv === null) return undefined;
      localMatrixUnder(root, object, worldMatrix, objectLocal, objectLocalOffset);
      followHelper.copy(inv).multiply(root.matrixWorld).multiply(
        chainHelper.fromArray(localScratch as unknown as number[]),
      );
      localScratch.set(followHelper.elements);
      if (
        previous?.follow && previous.space === follow.space && previous.pair === follow.pair &&
        sameElementsApprox(previous.localMatrix, localScratch, 1e-5)
      ) {
        return previous;
      }
      return {
        space: follow.space,
        follow: true,
        ...(follow.pair ? { pair: follow.pair } : {}),
        localMatrix: localScratch.slice(),
      };
    }
    const space = root.userData?.renderTrackingAnchor;
    if (space === "world") return undefined;
    if (!spaces.includes(space)) continue;
    if (Math.abs(root.matrixWorld.determinant()) < 1e-12) return undefined;
    localMatrixUnder(root, object, worldMatrix, objectLocal, objectLocalOffset);
    if (
      previous != null && !previous.follow && previous.space === space &&
      sameElements(previous.localMatrix, localScratch)
    ) {
      return previous;
    }
    return { space, localMatrix: localScratch.slice() };
  }
}

const followHelper = new THREE.Matrix4();
const followPoseCacheSrc = new Float64Array(16);
const followPoseCacheInv = new THREE.Matrix4();
let followPoseCacheValid = false;
let followPoseCacheDetOk = false;

function getFollowPoseInverse(pose: THREE.Matrix4): THREE.Matrix4 | null {
  const el = pose.elements;
  if (followPoseCacheValid && sameElements(followPoseCacheSrc, el)) {
    return followPoseCacheDetOk ? followPoseCacheInv : null;
  }
  followPoseCacheSrc.set(el);
  followPoseCacheValid = true;
  if (Math.abs(pose.determinant()) < 1e-12) {
    followPoseCacheDetOk = false;
    return null;
  }
  followPoseCacheInv.copy(pose).invert();
  followPoseCacheDetOk = true;
  return followPoseCacheInv;
}

const localHelper = new THREE.Matrix4();
/** {@link localMatrixUnder}'s result; copied out only when an anchor changes. */
const localScratch = new Float64Array(16);

function sameElements(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  for (let i = 0; i < 16; i++) if (left[i] !== right[i]) return false;
  return true;
}

function sameElementsApprox(left: ArrayLike<number>, right: ArrayLike<number>, eps: number): boolean {
  for (let i = 0; i < 16; i++) {
    if (Math.abs(left[i]! - right[i]!) > eps) return false;
  }
  return true;
}

const chainHelper = new THREE.Matrix4();
const checkHelper = new THREE.Matrix4();

/**
 * Prefer the product of local matrices below the anchor: it does not change while the anchor
 * moves, so an unchanged scene keeps bit-identical anchor matrices (see fingerprintScene).
 * Inverting the moving world matrix instead adds float noise every frame. Fall back to that
 * when the chain does not reproduce `worldMatrix` (stale or externally set matrices).
 */
function localMatrixUnder(
  root: THREE.Object3D,
  object: THREE.Object3D,
  worldMatrix: ArrayLike<number>,
  objectLocal: ArrayLike<number> | undefined,
  objectLocalOffset: number,
): void {
  const local = localHelper.identity();
  if (objectLocal) local.fromArray(objectLocal as number[], objectLocalOffset);
  for (let node: THREE.Object3D | null = object; node && node !== root; node = node.parent) {
    local.premultiply(node.matrix);
  }
  checkHelper.multiplyMatrices(root.matrixWorld, local);
  let error = 0, scale = 0;
  for (let i = 0; i < 16; i++) {
    error = Math.max(error, Math.abs(checkHelper.elements[i]! - Number(worldMatrix[i])));
    scale = Math.max(scale, Math.abs(Number(worldMatrix[i])));
  }
  if (error <= 1e-4 * Math.max(1, scale)) {
    localScratch.set(local.elements);
    return;
  }
  const inverted = chainHelper.copy(root.matrixWorld).invert()
    .multiply(local.fromArray(worldMatrix as number[])).elements;
  // uikit derives matrixWorld from layout, so its nodes take this path. Holding the previous
  // result through rounding noise keeps them bit-identical while nothing moves.
  const previous = objectLocal ? undefined : invertedLocals.get(object);
  if (previous) {
    let drift = 0, size = 1;
    for (let i = 0; i < 16; i++) {
      drift = Math.max(drift, Math.abs(previous[i]! - inverted[i]!));
      size = Math.max(size, Math.abs(inverted[i]!));
    }
    if (drift <= 1e-9 * size) {
      localScratch.set(previous);
      return;
    }
  }
  localScratch.set(inverted);
  if (!objectLocal) invertedLocals.set(object, localScratch.slice());
}

const invertedLocals = new WeakMap<THREE.Object3D, Float64Array>();

export function anchoredLowerers(): RenderLowerer[] {
  return createDefaultLowerers().map((lowerer) => ({
    canLower: (object) => lowerer.canLower(object),
    lower: (object, context) =>
      lowerer.lower(object, context).map((instance) => {
        (instance as typeof instance & Anchored).renderAnchor = captureRenderAnchor(
          object,
          instance.worldMatrix,
        );
        (instance as typeof instance & { vrcCameraHidden?: boolean }).vrcCameraHidden =
          object.userData.vrcCameraHidden === true;
        Object.assign(instance, {
          passthroughKey: object.userData.passthroughKey === true,
          passthroughCutout: object.userData.passthroughCutout === true,
        });
        return instance;
      }),
  }));
}

const resolveOldMatrix = new THREE.Matrix4();
const resolveNextMatrix = new THREE.Matrix4();
const resolveLocalMatrix = new THREE.Matrix4();
const resolveDeltaMatrix = new THREE.Matrix4();
const resolvePlaneVector = new THREE.Vector4();
const resolveNormalMatrix = new THREE.Matrix3();

/** Mutates only the child-owned working copy. The saved local matrices never change. */
export function resolveRenderAnchors(
  payload: WebXRRaythreeRenderPayload,
  anchors: RenderAnchors,
  /** Optional per-space tally of anchored items, resolved or not (tracking lost). */
  spaceCounts?: Partial<Record<RenderAnchorSpace, number>>,
  /**
   * Poses for grab-carried items only (`follow`), overriding `anchors`: a released grab holds
   * its window at the last shown pose until the worker's landed scene arrives.
   */
  followAnchors?: Partial<Record<string, ArrayLike<number>>>,
  /** Optional tally of grab-carried items per {@link followKey}. */
  followCounts?: Partial<Record<string, number>>,
): number {
  let count = 0;
  const resolve = (
    item: Anchored & {
      worldMatrix: Float32Array | Float64Array;
      normalMatrix?: Float64Array;
      clipping?: Float32Array;
    },
  ) => {
    const anchor = item.renderAnchor;
    if (!anchor) return;
    if (spaceCounts) spaceCounts[anchor.space] = (spaceCounts[anchor.space] ?? 0) + 1;
    let tracked: ArrayLike<number> | undefined | null = anchors[anchor.space];
    if (anchor.follow) {
      const key = followKey(anchor.space, anchor.pair);
      if (followCounts) followCounts[key] = (followCounts[key] ?? 0) + 1;
      tracked = followAnchors?.[key] ??
        (anchor.pair ? followFrame(anchors, anchor.space, anchor.pair)?.elements : tracked);
    }
    // Hold last visual placement on tracking loss, matching the existing scene policy.
    if (!tracked) return;
    const old = resolveOldMatrix.fromArray(item.worldMatrix);
    const next = resolveNextMatrix.fromArray(tracked).multiply(
      resolveLocalMatrix.fromArray(anchor.localMatrix),
    );
    if (item.clipping && Math.abs(old.determinant()) > 1e-12) {
      const delta = resolveDeltaMatrix.copy(next).multiply(old.invert());
      const planeTransform = delta.invert().transpose();
      for (let i = 0; i < 16; i += 4) {
        resolvePlaneVector.fromArray(item.clipping, i).applyMatrix4(planeTransform);
        resolvePlaneVector.toArray(item.clipping, i);
      }
    }
    // The process transport JSON-encodes typed arrays as numeric-keyed objects.
    // Indexed writes work for that wire representation as well as typed arrays.
    for (let i = 0; i < 16; i++) item.worldMatrix[i] = next.elements[i];
    if (item.normalMatrix) resolveNormalMatrix.getNormalMatrix(next).toArray(item.normalMatrix);
    count++;
  };
  // Extracted scene data is eye invariant; do not resolve an aliased eye twice.
  for (const item of payload.leftEye.frame.instances) resolve(item);
  if (payload.rightEye !== payload.leftEye) {
    for (const item of payload.rightEye.frame.instances) resolve(item);
  }
  for (const item of payload.ui.panels) resolve(item);
  for (const item of payload.ui.texts) resolve(item);
  for (const item of payload.ui.images) resolve(item);
  return count;
}
