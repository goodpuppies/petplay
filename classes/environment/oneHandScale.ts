/**
 * One-hand resize: while one hand grabs a window, holding that hand's trigger resizes it. Pulling
 * the hand away from the window shrinks it; bringing it closer grows it. Only the distance from
 * the hand to the window's centre counts, so it does not matter how the hand is turned or which
 * way it moves. The window holds still while the trigger is down.
 *
 * The size follows that distance exponentially ({@link oneHandScaledWidth}), so the same pull
 * feels the same on a small wrist menu and on a large display, and never inverts the window.
 * (This replaced XSOverlay's gesture, hand travel along its tilted backward axis, which depended
 * on the wrist's angle and felt random.)
 *
 * Handle callbacks only know their `HandleState`, so the grab pointers register which hand and
 * input source they belong to ({@link registerGrabPointerHand}), and the wrapped `apply` finds its
 * store, and from it the grabbing pointer, among the scene's handle stores.
 */
import * as THREE from "three/webgpu";
import type { HandleState, HandleStore } from "@pmndrs/handle";
import type { Pointer } from "@pmndrs/pointer-events";
import { getHandOriginWorldMatrix } from "./trackedOrigins.ts";
import { pulseHand } from "./haptics.ts";
import {
  followFrame,
  type FollowPair,
  type RenderTrackingFollow,
} from "../overlayRenderTracking.ts";
import { requestFollowRelease, syncDisplaysNow } from "./controllerDeviceFrames.ts";
import { laserOffsetMatrix } from "./laserOffset.ts";

export type GrabHand = "left" | "right";

/** Natural-log size change per metre of distance: about 23 cm halves or doubles the window. */
export const ONE_HAND_SCALE_RATE = 3;
export const ONE_HAND_SCALE_MIN_WIDTH = 0.05;
export const ONE_HAND_SCALE_MAX_WIDTH = 8;
const TRIGGER_DOWN = 0.2;

type GrabPointer = {
  hand: GrabHand;
  inputSource: XRInputSource;
  pointer: Pointer;
  /** The pointer's pose space: grip for the sphere, target ray for the ray. */
  space?: "hand" | "ray";
};

const grabPointers = new Map<number, GrabPointer>();

/** Returns the unregister function; a stale unregister leaves a newer registration alone. */
export function registerGrabPointerHand(
  pointer: Pointer,
  hand: GrabHand,
  inputSource: XRInputSource,
  space?: GrabPointer["space"],
): () => void {
  const entry = { hand, inputSource, pointer, space };
  grabPointers.set(pointer.id, entry);
  return () => {
    if (grabPointers.get(pointer.id) === entry) grabPointers.delete(pointer.id);
  };
}

/**
 * Whether one of `hand`'s grab pointers is holding something. Its select ray goes quiet meanwhile,
 * or the trigger that resizes would also click whatever the ray points at.
 */
export function isHandGrabbing(hand: GrabHand): boolean {
  for (const entry of grabPointers.values()) {
    if (entry.hand === hand && entry.pointer.getPointerCapture() != null) return true;
  }
  return false;
}

/**
 * The window width once the hand is `distance` from the window's centre, having been
 * `startDistance` away when the trigger went down: further away is smaller, closer is larger.
 */
export function oneHandScaledWidth(
  startWidth: number,
  startDistance: number,
  distance: number,
): number {
  const width = startWidth * Math.exp((startDistance - distance) * ONE_HAND_SCALE_RATE);
  return Math.min(ONE_HAND_SCALE_MAX_WIDTH, Math.max(ONE_HAND_SCALE_MIN_WIDTH, width));
}

/** How {@link withOneHandScale} measures the grabbed box, in world space. */
export type OneHandScaleMeasure = {
  width: () => number;
  center: (out: THREE.Vector3) => THREE.Vector3;
};

type Session = {
  pointerId: number;
  /** Set once the trigger has been up during this grab, so a trigger held into a grab is ignored. */
  armed: boolean;
  active?: {
    /** Hand-to-centre distance when the trigger went down. */
    distance: number;
    /** The centre then; the window holds still while resizing. */
    center: THREE.Vector3;
    scale: THREE.Vector3;
    width: number;
  };
};

const sessions = new WeakMap<object, Session>();
const handMatrix = new THREE.Matrix4();
const handPosition = new THREE.Vector3();
const handQuaternion = new THREE.Quaternion();
const handScale = new THREE.Vector3();
const boxCenter = new THREE.Vector3();

function readHand(hand: GrabHand): boolean {
  if (!getHandOriginWorldMatrix(`${hand}-hand`, handMatrix)) return false;
  handMatrix.decompose(handPosition, handQuaternion, handScale);
  return true;
}

function triggerValue(inputSource: XRInputSource): number {
  return inputSource.gamepad?.buttons[0]?.value ?? 0;
}

function storeFor(
  stores: Iterable<HandleStore<unknown>>,
  state: HandleState<unknown>,
): HandleStore<unknown> | undefined {
  for (const store of stores) {
    if (store.getState() === state) return store;
  }
  return undefined;
}

const resizedTargets = new WeakSet<object>();

/**
 * Whether a resize of `target` has ended since the last call. The hand has moved during the
 * resize, so anything measured against where the grab started (a hinge's pull-to-detach distance)
 * has to start over.
 */
export function consumeOneHandScaleEnd(target: object): boolean {
  return resizedTargets.delete(target);
}

/**
 * Adds the one-hand resize to a grab's `apply`. `measure` reads the grabbed box's width and centre
 * in world space. {@link GrabBox} applies this when its options carry `triggerResize`.
 *
 * While resizing, the store is rebased (`save`) every frame, so the hand's travel moves nothing,
 * and when the trigger comes up the grab carries on from where the window is.
 */
export function withOneHandScale<T>(
  apply: (state: HandleState<unknown>, target: THREE.Object3D) => T,
  stores: Map<string, HandleStore<unknown>>,
  measure: OneHandScaleMeasure,
  /** Let the renderer carry the window with the grabbing controller ({@link setRenderFollow}). */
  renderFollow = false,
): (state: HandleState<unknown>, target: THREE.Object3D) => T | undefined {
  return (state, target) => {
    if (state.first) sessions.delete(target);
    const pointers = state.current.pointerAmount;
    const store = state.last || (pointers !== 1 && pointers !== 2)
      ? undefined
      : storeFor(stores.values(), state);
    if (store != null && pointers === 2) {
      // Two hands: no trigger resize, but the renderer still carries the window, in the frame
      // spanning both grab points, so a second hand joining or leaving does not jump it.
      sessions.delete(target);
      const [first, second] = store.inputState.keys();
      setRenderFollow(
        target,
        renderFollow ? grabPointers.get(first) : undefined,
        store.inputState.get(first),
        { grabber: grabPointers.get(second), input: store.inputState.get(second) },
      );
      return apply(state, target);
    }
    const pointerId = store?.inputState.keys().next().value;
    const grabber = pointerId == null ? undefined : grabPointers.get(pointerId);
    if (store == null || pointerId == null || grabber == null) {
      sessions.delete(target);
      const follow = target.userData.renderTrackingFollow as CarryFollow | undefined;
      if (state.last && follow != null) {
        releaseCarried(state, target, follow, apply);
        return undefined;
      }
      setRenderFollow(target, undefined);
      return apply(state, target);
    }
    let session = sessions.get(target);
    if (session?.pointerId !== pointerId) {
      session = { pointerId, armed: false };
      sessions.set(target, session);
    }
    const down = triggerValue(grabber.inputSource) >= TRIGGER_DOWN;
    if (session.active == null) {
      if (!down) session.armed = true;
      else if (session.armed && readHand(grabber.hand)) {
        target.updateWorldMatrix(true, true);
        const center = measure.center(boxCenter).clone();
        session.active = {
          distance: handPosition.distanceTo(center),
          center,
          scale: target.scale.clone(),
          width: measure.width(),
        };
        pulseHand(grabber.hand, "click");
      }
    }
    const active = session.active;
    // While resizing the window holds still as the hand moves, so it must not follow the hand.
    setRenderFollow(
      target,
      renderFollow && active == null ? grabber : undefined,
      store.inputState.get(pointerId),
    );
    if (active == null) return apply(state, target);
    if (!down) {
      session.active = undefined;
      resizedTargets.add(target);
    } else if (readHand(grabber.hand)) {
      const distance = handPosition.distanceTo(active.center);
      const width = oneHandScaledWidth(active.width, active.distance, distance);
      target.scale.copy(active.scale).multiplyScalar(width / active.width);
    }
    store.save();
    return undefined;
  };
}

/**
 * A single-handed grab moves the window rigidly with the controller (damped, so it trails at the
 * hand's speed). Tagging it lets the decoupled renderer re-pose it from its own fresh controller
 * pose like the wrist menu, instead of at the worker's frame rate and older pose. Hinged and
 * resizing windows do not move with the hand and are left untagged.
 */
type GrabInput = {
  pointerWorldOrigin: THREE.Vector3;
  pointerWorldQuaternion: THREE.Quaternion;
  pointerWorldPoint: THREE.Vector3;
};

function setRenderFollow(
  target: THREE.Object3D,
  grabber: GrabPointer | undefined,
  input?: GrabInput,
  second?: { grabber: GrabPointer | undefined; input: GrabInput | undefined },
): void {
  const secondSpace = second?.grabber?.space;
  if (
    grabber?.space == null || input == null ||
    (second != null && (secondSpace == null || second.input == null))
  ) {
    delete target.userData.renderTrackingFollow;
    return;
  }
  const space = `${grabber.hand}-${grabber.space}` as const;
  const pairSpace = second?.grabber == null || secondSpace == null
    ? undefined
    : `${second.grabber.hand}-${secondSpace}` as const;
  let follow = target.userData.renderTrackingFollow as CarryFollow | undefined;
  if (follow?.space !== space || follow.pair?.space !== pairSpace) {
    const holders = [grabber.pointer, second?.grabber?.pointer];
    const created = {
      space,
      pose: new THREE.Matrix4(),
      releasing: false,
      // A grab can end without a last apply (capture dropped), so check a pointer still holds
      // it; a release in progress stays carried until it lands.
      active: () =>
        created.releasing || holders.some((pointer) => pointer?.getPointerCapture() != null),
    } as unknown as CarryFollow;
    follow = created;
    target.userData.renderTrackingFollow = follow;
  }
  follow.releasing = false;
  // The poses this apply placed the window from, not a later sample of the controllers.
  const pose = poseOf(input, firstPose, grabber);
  if (second == null || pairSpace == null) {
    follow.pair = undefined;
    (follow.pose as unknown as THREE.Matrix4).copy(pose);
    return;
  }
  const otherPose = poseOf(second.input!, secondPose, second.grabber!);
  const pair: FollowPair = {
    space: pairSpace,
    // Each grab point in its pointer's own space: fixed while the grab holds (frozen points).
    points: [
      grabPoint(input, pose),
      grabPoint(second.input!, otherPose),
    ],
  };
  follow.pair = pair;
  const frame = followFrame(
    { [space]: pose.elements, [pairSpace]: otherPose.elements },
    space,
    pair,
    follow.pose as unknown as Parameters<typeof followFrame>[3],
  );
  // Grab points on top of each other: hold the window on the first hand instead.
  if (frame == null) {
    follow.pair = undefined;
    (follow.pose as unknown as THREE.Matrix4).copy(pose);
  }
}

const firstPose = new THREE.Matrix4();
const secondPose = new THREE.Matrix4();
const grabPointHelper = new THREE.Matrix4();

/**
 * The grabbing pointer's pose in its render anchor's frame. A grab ray hangs from the laser's
 * offset ({@link laserOffsetMatrix}), but its anchor is the controller tip the renderer re-poses.
 */
function poseOf(input: GrabInput, target: THREE.Matrix4, grabber: GrabPointer): THREE.Matrix4 {
  target.compose(input.pointerWorldOrigin, input.pointerWorldQuaternion, UNIT_SCALE);
  if (grabber.space !== "ray") return target;
  return target.multiply(laserOffsetMatrix(grabber.hand, laserOffset).invert());
}

const laserOffset = new THREE.Matrix4();

function grabPoint(input: GrabInput, pose: THREE.Matrix4): number[] {
  return input.pointerWorldPoint.clone().applyMatrix4(grabPointHelper.copy(pose).invert())
    .toArray();
}

const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
const releaseShift = new THREE.Matrix4();
const releaseParent = new THREE.Matrix4();
const releaseLocal = new THREE.Matrix4();
const releaseHelper = new THREE.Matrix4();

type CarryFollow = RenderTrackingFollow & { releasing: boolean };

/**
 * Lets go of a carried window. The renderer showed it on the controller pose of its last frame;
 * applying the worker's final grab state instead would jump it, and the renderer would carry it
 * on with the hand until that scene arrived (an overshoot). So the renderer freezes it at that
 * last pose and returns it, and the final apply runs only then, shifted onto that pose. The window
 * stays tagged, and thus frozen, meanwhile.
 */
function releaseCarried<T>(
  state: HandleState<unknown>,
  target: THREE.Object3D,
  follow: CarryFollow,
  apply: (state: HandleState<unknown>, target: THREE.Object3D) => T,
): void {
  follow.releasing = true;
  requestFollowRelease({ space: follow.space, pair: follow.pair }, (shown) => {
    // Grabbed again before the answer: that grab owns the window now.
    if (target.userData.renderTrackingFollow !== follow || !follow.releasing || !state.last) return;
    if (shown != null) shiftGrabState(state, target, shown, follow.pose);
    delete target.userData.renderTrackingFollow;
    // The release apply stays rigid too, so the window lands exactly on the shifted pose.
    target.userData.renderTrackingRelease = true;
    try {
      apply(state, target);
    } finally {
      delete target.userData.renderTrackingRelease;
    }
    syncDisplaysNow();
  });
}

/** Moves the grab state by the rigid motion from the worker's controller pose to `shown`. */
function shiftGrabState(
  state: HandleState<unknown>,
  target: THREE.Object3D,
  shown: ArrayLike<number>,
  workerPose: THREE.Matrix4,
): void {
  releaseShift.fromArray(shown as number[]).multiply(releaseHelper.copy(workerPose).invert());
  const current = state.current as unknown as {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    scale: THREE.Vector3;
  };
  // The grab state is in the target's parent frame; the shift is a world-space rigid motion.
  target.parent?.updateWorldMatrix(true, false);
  releaseParent.copy(target.parent?.matrixWorld ?? releaseHelper.identity());
  releaseLocal.compose(current.position, current.quaternion, current.scale)
    .premultiply(releaseParent)
    .premultiply(releaseShift)
    .premultiply(releaseParent.invert());
  releaseLocal.decompose(current.position, current.quaternion, current.scale);
}
