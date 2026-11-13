/** Local Linux GPU frame handoff. Pixel storage stays behind DMA-BUF descriptors. */
export type GpuMediaFrame = {
  slot: number;
  sequence: bigint;
  timestamp: bigint;
  width: number;
  height: number;
  pitch: number;
  offset: number;
  modifier: bigint;
  fd: number;
};
const MAGIC = 0x50504d31;
export class GpuMediaSocket {
  private libc = Deno.dlopen(
    "libc.so.6",
    {
      socket: { parameters: ["i32", "i32", "i32"], result: "i32" },
      connect: { parameters: ["i32", "buffer", "u32"], result: "i32" },
      recvmsg: { parameters: ["i32", "buffer", "i32"], result: "isize" },
      send: { parameters: ["i32", "buffer", "usize", "i32"], result: "isize" },
      close: { parameters: ["i32"], result: "i32" },
      __errno_location: { parameters: [], result: "pointer" },
    } as const,
  );
  private fd = -1;
  private closed = false;
  private last = [0n, 0n, 0n];
  private openFrames = new Set<GpuMediaFrame>();
  constructor(path: string) {
    if (Deno.build.os !== "linux" || !["x86_64", "aarch64"].includes(Deno.build.arch)) {
      throw Error("GPU frame handoff needs 64-bit Linux");
    }
    try {
      const encoded = new TextEncoder().encode(path);
      if (encoded.length >= 108 || encoded.includes(0)) throw Error("Invalid media socket path");
      this.fd = this.libc.symbols.socket(1, 5 | 0x80000, 0);
      if (this.fd < 0) throw Error(`socket errno ${this.errno()}`);
      const address = new Uint8Array(110);
      new DataView(address.buffer).setUint16(0, 1, true);
      address.set(encoded, 2);
      if (this.libc.symbols.connect(this.fd, address, address.length) < 0) {
        const error = this.errno();
        this.close();
        throw Error(`connect media socket: errno ${error}`);
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }
  private errno() {
    return new Deno.UnsafePointerView(this.libc.symbols.__errno_location()!).getInt32();
  }
  poll(): GpuMediaFrame | null {
    const bytes = new Uint8Array(64), control = new Uint8Array(64);
    const iov = new BigUint64Array([Deno.UnsafePointer.value(Deno.UnsafePointer.of(bytes)), 64n]);
    const message = new Uint8Array(56), view = new DataView(message.buffer);
    view.setBigUint64(16, Deno.UnsafePointer.value(Deno.UnsafePointer.of(iov)), true);
    view.setBigUint64(24, 1n, true);
    view.setBigUint64(32, Deno.UnsafePointer.value(Deno.UnsafePointer.of(control)), true);
    view.setBigUint64(40, 64n, true);
    const n = Number(this.libc.symbols.recvmsg(this.fd, message, 0x40 | 0x40000000));
    if (n < 0) {
      const errno = this.errno();
      if (errno === 11 || errno === 4) return null;
      throw Error(`receive GPU frame: errno ${errno}`);
    }
    if (n === 0) throw Error("GPU media receiver disconnected");
    const fds: number[] = [];
    const ancillary = new DataView(control.buffer);
    const size = Number(view.getBigUint64(40, true));
    for (let at = 0; at + 16 <= size;) {
      const length = Number(ancillary.getBigUint64(at, true));
      if (length < 16 || at + length > size) break;
      if (ancillary.getInt32(at + 8, true) === 1 && ancillary.getInt32(at + 12, true) === 1) {
        for (let offset = at + 16; offset + 4 <= at + length; offset += 4) {
          fds.push(ancillary.getInt32(offset, true));
        }
      }
      at += Math.ceil(length / 8) * 8;
    }
    try {
      const h = new DataView(bytes.buffer);
      const u = (at: number) => h.getUint32(at, true);
      const frame: GpuMediaFrame = {
        slot: u(8),
        sequence: h.getBigUint64(16, true),
        timestamp: h.getBigUint64(24, true),
        width: u(32),
        height: u(36),
        pitch: u(40),
        offset: u(44),
        modifier: h.getBigUint64(48, true),
        fd: fds[0],
      };
      if (
        n !== 64 || (view.getUint32(48, true) & 0x28) !== 0 || fds.length !== 1 || u(0) !== MAGIC ||
        u(4) !== 1 || u(12) !== 1 || u(56) !== 44 || frame.slot >= 3 ||
        frame.sequence <= this.last[frame.slot] ||
        [...this.openFrames].some((held) => held.slot === frame.slot) || frame.width < 16 ||
        frame.width > 8192 ||
        frame.height < 16 || frame.height > 8192 || frame.pitch < frame.width * 4 ||
        frame.pitch > 65536 || frame.offset !== 0 || frame.modifier !== 0n
      ) throw Error("Unsupported GPU media descriptor");
      this.last[frame.slot] = frame.sequence;
      this.openFrames.add(frame);
      return frame;
    } catch (error) {
      for (const fd of fds) this.libc.symbols.close(fd);
      throw error;
    }
  }
  /** Only call after the GPU has finished reading this frame (or if it was never imported). */
  release(frame: GpuMediaFrame): void {
    if (!this.openFrames.delete(frame)) throw Error("GPU frame already released");
    this.libc.symbols.close(frame.fd);
    const ack = new Uint8Array(16), view = new DataView(ack.buffer);
    view.setUint32(0, MAGIC, true);
    view.setUint32(4, frame.slot, true);
    view.setBigUint64(8, frame.sequence, true);
    if (Number(this.libc.symbols.send(this.fd, ack, 16n, 0x40 | 0x4000)) !== 16) {
      throw Error("GPU frame ACK failed");
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.fd >= 0) {
      for (const frame of this.openFrames) this.libc.symbols.close(frame.fd);
      this.openFrames.clear();
      this.libc.symbols.close(this.fd);
      this.fd = -1;
    }
    this.libc.close();
  }
}
