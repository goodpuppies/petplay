import type { RawDepthFrame } from "./windowDecoder.ts";

const SLOTS = 3;
const WORDS_PER_SLOT = 2;
const FREE = 0, WRITING = 1, READY = 2, READING = 3;
export type SharedFrameNotice = Omit<RawDepthFrame, "depth" | "colors" | "foreground"> & {
  foreground?: { width: number; height: number };
  slot: number;
  sequence: number;
  hasColors: boolean;
};

/** Three bounded slots. The producer may replace unread frames, never a reader's frame. */
export class SharedDepthFrames {
  readonly control: Int32Array;
  readonly buffer: SharedArrayBuffer;
  readonly capacity: number;
  readonly foregroundCapacity: number;
  private readonly slotBytes: number;
  constructor(capacity: number, buffer?: SharedArrayBuffer, foregroundCapacity = 0) {
    this.capacity = capacity;
    this.foregroundCapacity = foregroundCapacity;
    this.slotBytes = capacity * 8 + foregroundCapacity * 4;
    this.buffer = buffer ??
      new SharedArrayBuffer(SLOTS * WORDS_PER_SLOT * 4 + SLOTS * this.slotBytes);
    this.control = new Int32Array(this.buffer, 0, SLOTS * WORDS_PER_SLOT);
  }
  private depth(slot: number) {
    return new Float32Array(
      this.buffer,
      SLOTS * WORDS_PER_SLOT * 4 + slot * this.slotBytes,
      this.capacity,
    );
  }
  private colors(slot: number) {
    return new Uint8Array(
      this.buffer,
      SLOTS * WORDS_PER_SLOT * 4 + slot * this.slotBytes + this.capacity * 4,
      this.capacity * 4,
    );
  }
  private foreground(slot: number) {
    return new Float32Array(
      this.buffer,
      SLOTS * WORDS_PER_SLOT * 4 + slot * this.slotBytes + this.capacity * 8,
      this.foregroundCapacity,
    );
  }
  write(frame: RawDepthFrame, sequence: number): SharedFrameNotice | null {
    if (frame.depth.length > this.capacity) throw new Error("shared depth capacity exceeded");
    if (frame.foreground && frame.foreground.depth.length > this.foregroundCapacity) {
      throw new Error("shared foreground capacity exceeded");
    }
    for (let attempt = 0; attempt < SLOTS; attempt++) {
      const slot = (sequence + attempt) % SLOTS;
      const state = slot * WORDS_PER_SLOT;
      const previous = Atomics.load(this.control, state);
      if (previous !== FREE && previous !== READY) continue;
      if (Atomics.compareExchange(this.control, state, previous, WRITING) !== previous) continue;
      this.depth(slot).set(frame.depth);
      if (frame.colors) this.colors(slot).set(frame.colors);
      if (frame.foreground) this.foreground(slot).set(frame.foreground.depth);
      Atomics.store(this.control, state + 1, sequence);
      Atomics.store(this.control, state, READY);
      const { depth: _depth, colors: _colors, foreground, ...metadata } = frame;
      return {
        ...metadata,
        foreground: foreground ? { width: foreground.width, height: foreground.height } : undefined,
        slot,
        sequence,
        hasColors: frame.colors != null,
      };
    }
    return null;
  }
  read(notice: SharedFrameNotice): RawDepthFrame | null {
    const state = notice.slot * WORDS_PER_SLOT;
    if (
      notice.slot < 0 || notice.slot >= SLOTS ||
      Atomics.compareExchange(this.control, state, READY, READING) !== READY
    ) return null;
    let consumed = false;
    try {
      if (Atomics.load(this.control, state + 1) !== notice.sequence) return null;
      consumed = true;
      const count = notice.width * notice.height;
      // One bounded snapshot; no serialization. The GPU needs owned staging data anyway.
      return {
        receivedAt: notice.receivedAt,
        sourceCapturedAt: notice.sourceCapturedAt,
        decodeMs: notice.decodeMs,
        decodedAt: notice.decodedAt,
        header: notice.header,
        width: notice.width,
        height: notice.height,
        depth: this.depth(notice.slot).slice(0, count),
        colors: notice.hasColors ? this.colors(notice.slot).slice(0, count * 4) : null,
        foreground: notice.foreground
          ? {
            ...notice.foreground,
            depth: this.foreground(notice.slot).slice(
              0,
              notice.foreground.width * notice.foreground.height,
            ),
          }
          : undefined,
      };
    } finally {
      Atomics.store(this.control, state, consumed ? FREE : READY);
    }
  }
}
