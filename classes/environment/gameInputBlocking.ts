/** SteamVR's documented overlay-global action-set priority range starts here. */
export const OVERLAY_INPUT_PRIORITY = 0x01000000;
type Hand = "left" | "right";
type InputObject = {
  parent: InputObject | null;
  userData: Record<string, unknown>;
  visible?: boolean;
};
type InputPointer = {
  getEnabled(): boolean;
  getIntersection(): { object: InputObject } | undefined;
  getPointerCapture(): { object: InputObject } | undefined;
};

function blocksGameInput(object: InputObject | undefined): boolean {
  let blocks = false;
  for (let node = object; node != null; node = node.parent ?? undefined) {
    if (node.visible === false) return false;
    if (node.userData.blockGameInput === true) blocks = true;
  }
  return blocks;
}

/** Pointer registrations live only as long as their XR controller components. */
export class GameInputBlocking {
  private readonly pointers = new Map<InputPointer, Hand>();
  private readonly blocked = { left: false, right: false };

  register(pointer: InputPointer, hand: Hand): () => void {
    this.pointers.set(pointer, hand);
    return () => {
      this.pointers.delete(pointer);
    };
  }

  priority(hand: Hand, controlsHeld: boolean): number {
    let hovered = false;
    let registered = false;
    for (const [pointer, pointerHand] of this.pointers) {
      if (pointerHand !== hand) continue;
      registered = true;
      if (
        pointer.getEnabled() && (
          blocksGameInput(pointer.getPointerCapture()?.object) ||
          blocksGameInput(pointer.getIntersection()?.object)
        )
      ) hovered = true;
    }
    // Do not hand a held click/grip/stick back to the game mid-gesture. A controller
    // unmount/disconnect releases the override even if its last sample was held.
    this.blocked[hand] = registered && (hovered || (this.blocked[hand] && controlsHeld));
    return this.blocked[hand] ? OVERLAY_INPUT_PRIORITY : 0;
  }

  reset(): void {
    this.blocked.left = this.blocked.right = false;
  }
}

export const gameInputBlocking = new GameInputBlocking();
