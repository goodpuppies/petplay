import { useSyncExternalStore } from "react";

/**
 * How far the pointer may sit from the point it grabbed and still resize a hinged element with one
 * hand (the hinge standing in for the second hand: the grab point's radius to the pivot drives the
 * scale).
 *
 * A **direct grab** has the hand at the element, so the offset is a few centimetres and pulling away
 * from the joint is deliberate. A **laser** grabs at the far end of its beam — half a metre or more
 * away — so the same pull reacts to pointing wobble and the panel slides in size. A two-handed pinch
 * resizes regardless.
 *
 * Measured from geometry, not the pointer or intersection type: a controller can expose its ray as a
 * `grab` pointer, and a near-hand sphere pointer can still fire at arm's length.
 */
let hingedOneHandScaleMaxGrabOffset = 0.2;
const listeners = new Set<() => void>();

export function setHingedOneHandScaleMaxGrabOffset(next: number): void {
  hingedOneHandScaleMaxGrabOffset = next;
  for (const listener of listeners) listener();
}

export function getHingedOneHandScaleMaxGrabOffset(): number {
  return hingedOneHandScaleMaxGrabOffset;
}

export function useHingedOneHandScaleMaxGrabOffset(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getHingedOneHandScaleMaxGrabOffset,
    getHingedOneHandScaleMaxGrabOffset,
  );
}
