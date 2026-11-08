/** Repeat only after pointer processing on a fresh scene frame. Never catch up
 * missed repeats or trust a held pointer immediately after a long frame stall.
 */
export class KeyRepeat {
  private readonly keys = new Map<object, { next: number; emit: () => void }>();
  private lastFrame: number | undefined;
  constructor(private readonly now = () => performance.now()) {}

  start(key: object, emit: () => void): void {
    this.keys.set(key, { next: this.now() + 420, emit });
  }
  stop(key: object): void {
    this.keys.delete(key);
  }
  tick(): void {
    const now = this.now();
    const stalled = this.lastFrame == null || now - this.lastFrame > 100;
    this.lastFrame = now;
    for (const key of this.keys.values()) {
      if (stalled) key.next = Math.max(key.next, now + 45);
      else if (now >= key.next) {
        key.next = now + 45;
        key.emit();
      }
    }
  }
}
export const keyboardRepeat = new KeyRepeat();
