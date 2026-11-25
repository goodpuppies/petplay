/**
 * Double-buffered `/dev/shm` transport for desktop BGRA frames + workspace cursor position
 * between `displayOverlayHost` (producer) and `overlay_renderer` (consumer).
 *
 * Uses `mmap` over `libc.so.6` with an atomic slot/sequence header so the renderer can check for
 * a new frame in O(1) without actor IPC serialization or copying 16+ MB over pipes.
 */

const MAGIC = 0x50504454; // 'PPDT'
const VERSION = 1;
const HEADER_BYTES = 64;
/** 40 MiB per slot: fits dual-4K or ultrawide BGRA frames; tmpfs only faults written pages. */
const SLOT_STRIDE_BYTES = 40 * 1024 * 1024;
const TOTAL_BYTES = HEADER_BYTES + SLOT_STRIDE_BYTES * 2;

const HDR_MAGIC = 0;
const HDR_VERSION = 1;
const HDR_ACTIVE_SLOT = 2;
const HDR_FRAME_SEQ = 3;
const HDR_WIDTH = 4;
const HDR_HEIGHT = 5;
const HDR_CURSOR_SEQ = 6;
const HDR_CURSOR_VISIBLE = 7;
const HDR_CURSOR_X = 8; // float32
const HDR_CURSOR_Y = 9; // float32
const HDR_SLOT_STRIDE = 10;

const O_RDWR = 2;
const O_CREAT = 0o100;
const PROT_READ = 1;
const PROT_WRITE = 2;
const MAP_SHARED = 1;
const MAP_FAILED = 0xffffffffffffffffn;

type Libc = Deno.DynamicLibrary<{
  open: { parameters: ["buffer", "i32", "u32"]; result: "i32" };
  ftruncate: { parameters: ["i32", "i64"]; result: "i32" };
  mmap: {
    parameters: ["pointer", "usize", "i32", "i32", "i32", "i64"];
    result: "pointer";
  };
  munmap: { parameters: ["pointer", "usize"]; result: "i32" };
  close: { parameters: ["i32"]; result: "i32" };
}>;

let libcCache: Libc | null = null;
function libc(): Libc {
  return libcCache ??= Deno.dlopen("libc.so.6", {
    open: { parameters: ["buffer", "i32", "u32"], result: "i32" },
    ftruncate: { parameters: ["i32", "i64"], result: "i32" },
    mmap: {
      parameters: ["pointer", "usize", "i32", "i32", "i32", "i64"],
      result: "pointer",
    },
    munmap: { parameters: ["pointer", "usize"], result: "i32" },
    close: { parameters: ["i32"], result: "i32" },
  });
}

export function defaultDesktopShmPath(): string {
  const uid = typeof Deno.uid === "function" ? Deno.uid() : 0;
  return `/dev/shm/petplay-desktop-${uid}.bin`;
}

export type DesktopCursorState = {
  visible: boolean;
  x: number;
  y: number;
};

type MappedRegion = {
  fd: number;
  ptr: Deno.PointerObject;
  size: number;
  i32: Int32Array;
  f32: Float32Array;
  slots: [Uint8Array, Uint8Array];
};

function mapRegion(path: string, create: boolean): MappedRegion | null {
  if (Deno.build.os !== "linux") return null;
  const lib = libc();
  const pathBytes = new TextEncoder().encode(`${path}\0`);
  const flags = create ? (O_RDWR | O_CREAT) : O_RDWR;
  const fd = lib.symbols.open(pathBytes, flags, 0o600);
  if (fd < 0) return null;
  if (create) {
    if (lib.symbols.ftruncate(fd, BigInt(TOTAL_BYTES)) !== 0) {
      lib.symbols.close(fd);
      return null;
    }
  }
  const prot = create ? (PROT_READ | PROT_WRITE) : PROT_READ;
  const ptr = lib.symbols.mmap(null, BigInt(TOTAL_BYTES), prot, MAP_SHARED, fd, 0n);
  if (!ptr || Deno.UnsafePointer.value(ptr) === MAP_FAILED) {
    lib.symbols.close(fd);
    return null;
  }
  const view = new Deno.UnsafePointerView(ptr);
  const ab = view.getArrayBuffer(TOTAL_BYTES);
  const i32 = new Int32Array(ab, 0, HEADER_BYTES / 4);
  const f32 = new Float32Array(ab, 0, HEADER_BYTES / 4);
  const slot0 = new Uint8Array(ab, HEADER_BYTES, SLOT_STRIDE_BYTES);
  const slot1 = new Uint8Array(ab, HEADER_BYTES + SLOT_STRIDE_BYTES, SLOT_STRIDE_BYTES);
  return { fd, ptr, size: TOTAL_BYTES, i32, f32, slots: [slot0, slot1] };
}

function unmapRegion(region: MappedRegion): void {
  const lib = libc();
  try {
    lib.symbols.munmap(region.ptr, BigInt(region.size));
  } catch {
    // Ignore teardown errors.
  }
  try {
    lib.symbols.close(region.fd);
  } catch {
    // Ignore teardown errors.
  }
}

export class DesktopFrameShmWriter {
  private region: MappedRegion | null = null;
  private activeSlot = 0;

  constructor(readonly path = defaultDesktopShmPath()) {}

  private ensureMapped(): MappedRegion | null {
    if (this.region) return this.region;
    const region = mapRegion(this.path, true);
    if (!region) return null;
    region.i32[HDR_MAGIC] = MAGIC;
    region.i32[HDR_VERSION] = VERSION;
    region.i32[HDR_SLOT_STRIDE] = SLOT_STRIDE_BYTES;
    Atomics.store(region.i32, HDR_ACTIVE_SLOT, 0);
    Atomics.store(region.i32, HDR_FRAME_SEQ, 0);
    Atomics.store(region.i32, HDR_CURSOR_SEQ, 0);
    Atomics.store(region.i32, HDR_CURSOR_VISIBLE, 0);
    this.region = region;
    return region;
  }

  writeFrame(pixels: Uint8Array, width: number, height: number): boolean {
    const byteLength = width * height * 4;
    if (byteLength <= 0 || byteLength > SLOT_STRIDE_BYTES || pixels.byteLength < byteLength) {
      return false;
    }
    const region = this.ensureMapped();
    if (!region) return false;
    const nextSlot = this.activeSlot ^ 1;
    region.slots[nextSlot]!.set(
      pixels.byteLength === byteLength ? pixels : pixels.subarray(0, byteLength),
      0,
    );
    Atomics.store(region.i32, HDR_WIDTH, width);
    Atomics.store(region.i32, HDR_HEIGHT, height);
    Atomics.store(region.i32, HDR_ACTIVE_SLOT, nextSlot);
    Atomics.add(region.i32, HDR_FRAME_SEQ, 1);
    this.activeSlot = nextSlot;
    return true;
  }

  writeCursor(visible: boolean, x: number, y: number): void {
    const region = this.ensureMapped();
    if (!region) return;
    region.f32[HDR_CURSOR_X] = x;
    region.f32[HDR_CURSOR_Y] = y;
    Atomics.store(region.i32, HDR_CURSOR_VISIBLE, visible ? 1 : 0);
    Atomics.add(region.i32, HDR_CURSOR_SEQ, 1);
  }

  close(): void {
    if (this.region) {
      unmapRegion(this.region);
      this.region = null;
    }
  }
}

export class DesktopFrameShmReader {
  private region: MappedRegion | null = null;
  private lastFrameSeq = 0;
  private lastAttemptAt = 0;

  constructor(readonly path = defaultDesktopShmPath()) {}

  private ensureMapped(): MappedRegion | null {
    if (this.region) return this.region;
    const now = performance.now();
    if (now - this.lastAttemptAt < 500) return null;
    this.lastAttemptAt = now;
    const region = mapRegion(this.path, false);
    if (!region) return null;
    if (region.i32[HDR_MAGIC] !== MAGIC || region.i32[HDR_VERSION] !== VERSION) {
      unmapRegion(region);
      return null;
    }
    this.region = region;
    return region;
  }

  /**
   * Returns a zero-copy view of the newest BGRA frame if `frameSeq` advanced since the last call,
   * or `null` if unchanged / unavailable.
   */
  pollFrame(): { seq: number; width: number; height: number; pixels: Uint8Array } | null {
    const region = this.ensureMapped();
    if (!region) return null;
    const seq = Atomics.load(region.i32, HDR_FRAME_SEQ);
    if (seq === 0 || seq === this.lastFrameSeq) return null;
    const slot = Atomics.load(region.i32, HDR_ACTIVE_SLOT) & 1;
    const width = Atomics.load(region.i32, HDR_WIDTH);
    const height = Atomics.load(region.i32, HDR_HEIGHT);
    const byteLength = width * height * 4;
    if (width <= 0 || height <= 0 || byteLength > SLOT_STRIDE_BYTES) return null;
    this.lastFrameSeq = seq;
    return {
      seq,
      width,
      height,
      pixels: region.slots[slot]!.subarray(0, byteLength),
    };
  }

  readCursor(): DesktopCursorState {
    const region = this.ensureMapped();
    if (!region) return { visible: false, x: 0, y: 0 };
    const visible = Atomics.load(region.i32, HDR_CURSOR_VISIBLE) !== 0;
    return {
      visible,
      x: region.f32[HDR_CURSOR_X]!,
      y: region.f32[HDR_CURSOR_Y]!,
    };
  }

  close(): void {
    if (this.region) {
      unmapRegion(this.region);
      this.region = null;
    }
    this.lastFrameSeq = 0;
  }
}
