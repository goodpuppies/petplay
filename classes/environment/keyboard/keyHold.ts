export type KeyPhase = "down" | "repeat" | "up";

/** One OS key hold, even when two pointers press the same cap. */
export class KeyHold {
  private readonly pointers = new Set<number>();
  constructor(private readonly emit: (phase: KeyPhase) => void) {}

  down(pointerId: number): boolean {
    if (this.pointers.has(pointerId)) return false;
    const first = this.pointers.size === 0;
    this.pointers.add(pointerId);
    if (first) this.emit("down");
    return first;
  }

  repeat(): void {
    if (this.pointers.size > 0) this.emit("repeat");
  }

  up(pointerId: number): boolean {
    if (!this.pointers.delete(pointerId) || this.pointers.size > 0) return false;
    this.emit("up");
    return true;
  }

  releaseAll(): void {
    if (this.pointers.size === 0) return;
    this.pointers.clear();
    this.emit("up");
  }
}
