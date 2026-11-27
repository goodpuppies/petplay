/**
 * PetPlay's grab behaviour on top of pmndrs `HandleStore`: what the library does not decide for
 * an application.
 *
 * - One physical hand is one grab: a runtime that exposes a hand as several `grab` pointers (e.g.
 *   a controller and its hand-tracking twin) cannot fake a two-hand pinch.
 * - A second hand can pinch-scale a constrained-rotation element (`translate: "as-…"`), whose
 *   rotation stays the first hand's. pmndrs treats a string `translate` as single-pointer.
 * - `oneHandScaleMaxGrabOffset`: a one-hand radial pull (`"as-rotate-and-scale"`) resizes only
 *   for a grab at the hand, not for a laser whose grab point is an arm's length away.
 * - `setTargetAxisAngle`: a joystick sets a hinge's angle while the hand holds it.
 *
 * `GrabBox` builds its stores with {@link PetPlayHandle}.
 */
import React from "react";
import { Matrix4, type Object3D, Quaternion, Vector3 } from "three";
import {
  type Axis,
  computeOnePointerHandleTransformState,
  computeTranslateAsHandleTransformState,
  computeTwoPointerHandleTransformState,
  type HandleOptions,
  HandleStore,
  type HandleTransformState,
} from "@pmndrs/handle";
import { Handle } from "@react-three/handle";
import type { PointerEvent } from "@pmndrs/pointer-events";

export type PetPlayHandleOptions<T> = HandleOptions<T> & {
  /**
   * Largest grab offset (metres between the pointer and the point it grabbed) that may drive a
   * one-hand scale under `translate: "as-rotate-and-scale"`.
   *
   * A direct grab has the hand at the element, so the offset is a few centimetres and a radial
   * pull is deliberate. A laser's grab point sits a whole grab-distance away, so the same pull
   * reacts to pointing wobble and the panel slides in size. `undefined` allows any offset. Never
   * applies while two pointers are down: a pinch always resizes.
   *
   * Measured from geometry rather than the pointer or intersection type: a controller may expose
   * its ray as a `grab` pointer, and a near-hand sphere can still fire at arm's length.
   */
  oneHandScaleMaxGrabOffset?: number;
};

const axisHelper = new Vector3();
const turnHelper = new Quaternion();

export class PetPlayHandleStore<T> extends HandleStore<T> {
  /** The physical hand each captured `grab` pointer belongs to. */
  readonly capturedPointerGroups = new Map<number, string>();
  declare readonly getOptions: () => PetPlayHandleOptions<T>;
  /** The target parent's world matrix at the last {@link update}, to notice it moving. */
  private readonly heldParentWorld = new Matrix4();

  constructor(
    target: Object3D | { current?: Object3D | null },
    getOptions: () => PetPlayHandleOptions<T> = () => ({}),
  ) {
    super(target, getOptions);
  }

  protected override onPointerDown(event: PointerEvent): void {
    const group = exclusivePointerGroup(event);
    if (group != null && [...this.capturedPointerGroups.values()].includes(group)) return;
    const wasCaptured = this.capturedObjects.has(event.pointerId);
    super.onPointerDown(event);
    if (group != null && !wasCaptured && this.capturedObjects.has(event.pointerId)) {
      this.capturedPointerGroups.set(event.pointerId, group);
    }
  }

  protected override releasePointer(
    pointerId: number,
    object: Object3D,
    event: PointerEvent | undefined,
  ): void {
    this.capturedPointerGroups.delete(pointerId);
    super.releasePointer(pointerId, object, event);
  }

  override cancel(): void {
    this.capturedPointerGroups.clear();
    super.cancel();
  }

  /** A string `translate` is single-pointer for the transform, but a second pointer may join to
   * pinch-scale when scaling is on. */
  protected override capturePointer(pointerId: number, object: Object3D): boolean {
    if (this.capturedObjects.has(pointerId)) return false;
    const { multitouch, translate, scale } = this.getOptions();
    const singlePointer = (multitouch ?? true) === false ||
      (typeof translate === "string" && scale === false);
    if (singlePointer && this.capturedObjects.size === 1) return false;
    this.capturedObjects.set(pointerId, object);
    object.setPointerCapture(pointerId);
    return true;
  }

  /**
   * `force` applies even without a new pointer move (after {@link setTargetAxisAngle}).
   *
   * A held target stays with the hand even while its parent moves without the hand moving (a
   * window anchored to the VRChat world while the room lock adjusts): the parent's world matrix
   * is refreshed here (three only does that at render, a frame late for this) and a change
   * recomputes the target, so it is shown at the hand in tracking space while its pose relative
   * to the parent follows the parent.
   */
  override update(time: number, force = false): void {
    const target = this.getTarget();
    if (target == null || this.inputState.size === 0) return;
    const parent = target.parent;
    let parentMoved = false;
    if (parent != null) {
      parent.updateWorldMatrix(true, false);
      parentMoved = !this.heldParentWorld.equals(parent.matrixWorld);
      this.heldParentWorld.copy(parent.matrixWorld);
    }
    if (
      !force && !parentMoved && this.latestMoveEvent == null &&
      (this.getOptions().alwaysUpdate ?? false) === false
    ) {
      return;
    }
    const options = this.getOptions();
    let transformState: HandleTransformState;
    if (
      options.translate === "as-rotate" || options.translate === "as-rotate-and-scale" ||
      options.translate === "as-scale"
    ) {
      this.prevTwoPointerDeltaRotation = undefined;
      this.prevAngle = undefined;
      const [p1, p2] = this.inputState.values();
      const parentMatrixWorld = target.parent?.matrixWorld;
      transformState = {
        ...computeTranslateAsHandleTransformState(
          time,
          p1!,
          this,
          target.matrixWorld,
          parentMatrixWorld,
          options,
        ),
        pointerAmount: this.inputState.size,
      };
      if (p2 != null && options.scale !== false) {
        // The rotation stays the first pointer's; the second only contributes the pinch scale.
        const pinch = computeTwoPointerHandleTransformState(
          time,
          p1!,
          p2,
          this,
          parentMatrixWorld,
          {
            ...options,
            translate: false,
            rotate: false,
          },
        );
        transformState = { ...transformState, scale: pinch.scale };
      } else if (
        options.oneHandScaleMaxGrabOffset != null &&
        p1!.pointerWorldPoint.distanceTo(p1!.pointerWorldOrigin) > options.oneHandScaleMaxGrabOffset
      ) {
        // A grab out at arm's length keeps the rotation only.
        transformState = { ...transformState, scale: this.initialTargetScale.clone() };
      }
    } else if (this.inputState.size === 1) {
      this.prevTwoPointerDeltaRotation = undefined;
      this.prevAngle = undefined;
      this.prevTranslateAsDeltaRotation = undefined;
      const [p1] = this.inputState.values();
      transformState = computeOnePointerHandleTransformState(
        time,
        p1!,
        this,
        target.parent?.matrixWorld,
        options,
      );
    } else {
      this.prevTranslateAsDeltaRotation = undefined;
      const [p1, p2] = this.inputState.values();
      transformState = computeTwoPointerHandleTransformState(
        time,
        p1!,
        p2!,
        this,
        target.parent?.matrixWorld,
        options,
      );
    }
    this.outputState.update(this.latestMoveEvent, transformState);
    this.outputState.memo = this.apply(target);
    this.latestMoveEvent = undefined;
  }

  /**
   * Hand an active grab's constrained rotation over to an absolute target-frame angle, e.g. a
   * joystick.
   *
   * Rebasing first (`save`) collapses the pointer's accumulated delta to identity, so while the
   * caller keeps calling this the hand no longer turns the target at all: the two inputs cannot
   * fight. When the caller stops, the next pointer move rotates on from the angle left here.
   * `angle` is absolute (not a delta), so the caller can clamp it against the rotation limits
   * without a wind-up dead zone.
   */
  setTargetAxisAngle(pointerId: number, axis: Axis, angle: number): boolean {
    if (!this.inputState.has(pointerId) || !Number.isFinite(angle)) return false;
    this.save();
    // As if the target already stood at `angle` when the grab was rebased: the pointer's delta
    // then composes on top of it.
    turnHelper.setFromAxisAngle(
      axisHelper.set(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0),
      angle - this.initialTargetRotation[axis],
    );
    this.initialTargetQuaternion.premultiply(turnHelper);
    this.initialTargetRotation.setFromQuaternion(
      this.initialTargetQuaternion,
      this.initialTargetRotation.order,
    );
    this.update(this.outputState.current.time + 1 / 60, true);
    return true;
  }
}

function exclusivePointerGroup(event: PointerEvent): string | undefined {
  if (event.pointerType !== "grab") return undefined;
  const handedness = (event.pointerState as { inputSource?: { handedness?: string } } | null)
    ?.inputSource?.handedness;
  return handedness === "left" || handedness === "right" ? `grab:${handedness}` : undefined;
}

function createPetPlayHandleStore<T>(
  target: React.RefObject<Object3D | null>,
  getOptions: () => HandleOptions<T>,
): HandleStore<T> {
  return new PetPlayHandleStore<T>(target, getOptions);
}

type HandleProps = React.ComponentPropsWithoutRef<typeof Handle>;

/** `@react-three/handle`'s `<Handle>`, with a {@link PetPlayHandleStore}. */
export const PetPlayHandle = React.forwardRef<
  HandleStore<unknown>,
  HandleProps & { oneHandScaleMaxGrabOffset?: number }
>(function PetPlayHandle(props, ref) {
  return <Handle ref={ref} createStore={createPetPlayHandleStore} {...props} />;
});
