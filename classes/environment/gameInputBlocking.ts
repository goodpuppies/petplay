/** SteamVR's documented overlay-global action-set priority range starts here. */
export const OVERLAY_INPUT_PRIORITY = 0x01000000;
type Hand = "left" | "right";
type Vec3 = { x: number; y: number; z: number };
type InputObject = {
  parent: InputObject | null;
  userData: Record<string, unknown>;
  visible?: boolean;
};
type InputIntersection = {
  object: InputObject;
  /** World hit point; pmndrs pointer-events intersections carry both. */
  point?: Vec3;
  pointerPosition?: Vec3;
};
type InputPointer = {
  getEnabled(): boolean;
  getIntersection(): InputIntersection | undefined;
  getPointerCapture(): InputIntersection | undefined;
};

/**
 * Where a hand's laser meets PetPlay UI, for the invisible SteamVR focus overlay
 * (`classes/inputFocusOverlays.ts`), in PetPlay's world frame.
 */
export type FocusTarget = {
  point: [number, number, number];
  origin: [number, number, number];
};

type Blocking = "pass" | "block" | "block-own-overlay";

/**
 * The nearest `userData.blockGameInput` decides. `steamVrInputOverlay` marks UI that already
 * has its own mouse-input SteamVR overlay (displays), which needs no focus overlay.
 */
function blockingOf(object: InputObject | undefined): Blocking {
  let decided: boolean | null = null;
  let ownOverlay = false;
  for (let node = object; node != null; node = node.parent ?? undefined) {
    if (node.visible === false) return "pass";
    if (node.userData.steamVrInputOverlay === true) ownOverlay = true;
    const flag = node.userData.blockGameInput;
    if (decided == null && typeof flag === "boolean") decided = flag;
  }
  if (!decided) return "pass";
  return ownOverlay ? "block-own-overlay" : "block";
}

function setTarget(out: FocusTarget, hit: InputIntersection): boolean {
  const { point, pointerPosition } = hit;
  if (!point || !pointerPosition) return false;
  out.point[0] = point.x, out.point[1] = point.y, out.point[2] = point.z;
  out.origin[0] = pointerPosition.x;
  out.origin[1] = pointerPosition.y;
  out.origin[2] = pointerPosition.z;
  return true;
}

/** Pointer registrations live only as long as their XR controller components. */
export class GameInputBlocking {
  private readonly pointers = new Map<InputPointer, Hand>();
  private readonly blocked = { left: false, right: false };
  private readonly targets: Record<Hand, FocusTarget> = {
    left: { point: [0, 0, 0], origin: [0, 0, 0] },
    right: { point: [0, 0, 0], origin: [0, 0, 0] },
  };
  private readonly hasTarget = { left: false, right: false };

  register(pointer: InputPointer, hand: Hand): () => void {
    this.pointers.set(pointer, hand);
    return () => {
      this.pointers.delete(pointer);
    };
  }

  priority(hand: Hand, controlsHeld: boolean): number {
    let hovered = false;
    let registered = false;
    let targeted = false;
    let ownOverlay = false;
    for (const [pointer, pointerHand] of this.pointers) {
      if (pointerHand !== hand) continue;
      registered = true;
      if (!pointer.getEnabled()) continue;
      for (const hit of [pointer.getPointerCapture(), pointer.getIntersection()]) {
        if (!hit) continue;
        const blocking = blockingOf(hit.object);
        if (blocking === "pass") continue;
        hovered = true;
        if (blocking === "block-own-overlay") ownOverlay = true;
        else if (!targeted) targeted = setTarget(this.targets[hand], hit);
        break;
      }
    }
    // Do not hand a held click/grip/stick back to the game mid-gesture. A controller
    // unmount/disconnect releases the override even if its last sample was held.
    this.blocked[hand] = registered && (hovered || (this.blocked[hand] && controlsHeld));
    // Mid-gesture off the UI the focus overlay stays at its last place.
    if (!this.blocked[hand] || ownOverlay) this.hasTarget[hand] = false;
    else if (targeted) this.hasTarget[hand] = true;
    return this.blocked[hand] ? OVERLAY_INPUT_PRIORITY : 0;
  }

  /** Whether PetPlay UI holds this hand's controls (the game does not see them). */
  isBlocked(hand: Hand): boolean {
    return this.blocked[hand];
  }

  /** The hand's laser hit on PetPlay UI that has no SteamVR overlay of its own, or `null`. */
  focusTarget(hand: Hand): FocusTarget | null {
    return this.hasTarget[hand] ? this.targets[hand] : null;
  }

  reset(): void {
    this.blocked.left = this.blocked.right = false;
    this.hasTarget.left = this.hasTarget.right = false;
  }
}

export const gameInputBlocking = new GameInputBlocking();
