import { useSyncExternalStore } from "react";

export type ControllerHand = "left" | "right";

type MainControllerListener = () => void;

/**
 * Which controller currently drives desktop pointer input.
 *
 * Both controllers emit ray pointer events at the same display, so letting each
 * one move the system cursor makes it thrash between the two aim points. Only
 * the main hand is allowed through; the other hand claims the role by pressing
 * its trigger, and that press is swallowed instead of becoming a click.
 */
let mainControllerHand: ControllerHand | null = null;
const listeners = new Set<MainControllerListener>();

function emitMainControllerChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function setMainControllerHand(hand: ControllerHand | null): void {
  if (mainControllerHand === hand) {
    return;
  }
  mainControllerHand = hand;
  emitMainControllerChange();
}

export function getMainControllerHand(): ControllerHand | null {
  return mainControllerHand;
}

export function subscribeMainControllerHand(listener: MainControllerListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useMainControllerHand(): ControllerHand | null {
  return useSyncExternalStore(
    subscribeMainControllerHand,
    getMainControllerHand,
    getMainControllerHand,
  );
}

/** Hand behind a pmndrs pointer event / pointer state, when it comes from an XR input source. */
export function controllerHandOfPointerState(pointerState: unknown): ControllerHand | null {
  if (
    pointerState == null || typeof pointerState !== "object" || !("inputSource" in pointerState)
  ) {
    return null;
  }
  const handedness =
    (pointerState as { inputSource?: { handedness?: string } }).inputSource?.handedness;
  return handedness === "left" || handedness === "right" ? handedness : null;
}

export type MainControllerGateDecision =
  /** Deliver the event to the desktop mouse sink. */
  | "emit"
  /** Drop the event: it belongs to a controller that is not driving the cursor. */
  | "ignore"
  /** Drop the event: it switched the main hand rather than clicking. */
  | "switch";

export type MainControllerGateOptions = {
  getHand?: () => ControllerHand | null;
  setHand?: (hand: ControllerHand | null) => void;
};

/**
 * Per-surface arbitration over the shared main-hand state.
 *
 * Tracks which pointer ids were consumed by a hand switch so the matching
 * release is swallowed too and never lands as a stray button-up.
 */
export function createMainControllerGate(options: MainControllerGateOptions = {}) {
  const getHand = options.getHand ?? getMainControllerHand;
  const setHand = options.setHand ?? setMainControllerHand;
  const swallowedPointerIds = new Set<number>();

  return {
    /** Moves only pass through for the main hand; non-XR pointers are untouched. */
    move(pointerState: unknown): MainControllerGateDecision {
      const hand = controllerHandOfPointerState(pointerState);
      if (hand == null) return "emit";
      const main = getHand();
      if (main == null) {
        // Nothing has claimed the cursor yet, so the first controller to aim gets it.
        setHand(hand);
        return "emit";
      }
      return hand === main ? "emit" : "ignore";
    },

    down(pointerState: unknown, pointerId: number): MainControllerGateDecision {
      const hand = controllerHandOfPointerState(pointerState);
      if (hand == null) return "emit";
      const main = getHand();
      if (main == null) {
        setHand(hand);
        return "emit";
      }
      if (hand === main) return "emit";
      setHand(hand);
      swallowedPointerIds.add(pointerId);
      return "switch";
    },

    up(pointerState: unknown, pointerId: number): MainControllerGateDecision {
      if (swallowedPointerIds.delete(pointerId)) {
        return "switch";
      }
      const hand = controllerHandOfPointerState(pointerState);
      if (hand == null) return "emit";
      // The press that opened this interaction already made this hand main, so a
      // release from any other hand is stale and must not close someone's drag.
      return hand === getHand() ? "emit" : "ignore";
    },

    /** Forget in-flight switches, e.g. when the surface unmounts. */
    reset(): void {
      swallowedPointerIds.clear();
    },
  };
}
