/**
 * The depth block's runtime layout on the debug avatar (`PetPlayDepthAvatarBuilder` tunables),
 * set over OSC as avatar parameters, and a watcher for VRChat world changes. The intake asserts the
 * layout itself, so an avatar reload (which resets the parameters) or a calibration switch
 * (`blockCalibration.ts`) needs no manual `vrchatDepthProbe.ts set`.
 */
import { vrchatDataDir } from "./vrchatScale.ts";

/** Avatar parameter and real-unit range of each tunable; values are sent normalized to 0..1. */
export const TUNABLES: Record<string, { parameter: string; min: number; max: number }> = {
  originX: { parameter: "PetPlayDepth/OriginX", min: 0, max: 4096 },
  originY: { parameter: "PetPlayDepth/OriginY", min: 0, max: 4096 },
  cellPx: { parameter: "PetPlayDepth/CellPx", min: 1, max: 9 },
  bits: { parameter: "PetPlayDepth/Bits", min: 1, max: 8 },
  depthSize: { parameter: "PetPlayDepth/DepthSize", min: 16, max: 512 },
  gridWidth: { parameter: "PetPlayDepth/GridWidth", min: 64, max: 1024 },
  eye: { parameter: "PetPlayDepth/Eye", min: 0, max: 1 },
  target: { parameter: "PetPlayDepth/Target", min: 0, max: 1 }, // 0 the eye, 1 VRChat's camera
  flipImageY: { parameter: "PetPlayDepth/FlipImageY", min: 0, max: 1 },
  calibration3D: { parameter: "PetPlayDepth/Calibration3D", min: 0, max: 1 },
  levelInset: { parameter: "PetPlayDepth/LevelInset", min: 0, max: 64 },
  // 0 the drawing pass's own depth texture, 1 the avatar's head depth camera
  source: { parameter: "PetPlayDepth/Source", min: 0, max: 1 },
};

/** The Stream-camera layout used live (`markdown/vrchat-depth/README.md`). */
export const DEFAULT_LAYOUT: Record<string, number> = {
  target: 1,
  originX: 8,
  originY: 8,
  cellPx: 1,
  gridWidth: 1024,
  depthSize: 512,
  bits: 6,
  calibration3D: 0,
  levelInset: 0,
  source: 1,
};

function oscString(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  const out = new Uint8Array((bytes.length + 4) & ~3);
  out.set(bytes);
  return out;
}

/** One OSC message with a float or bool argument. */
export function oscMessage(address: string, value: number | boolean): Uint8Array {
  const a = oscString(address);
  if (typeof value === "boolean") {
    const t = oscString(value ? ",T" : ",F");
    const out = new Uint8Array(a.length + t.length);
    out.set(a);
    out.set(t, a.length);
    return out;
  }
  const t = oscString(",f");
  const out = new Uint8Array(a.length + t.length + 4);
  out.set(a);
  out.set(t, a.length);
  new DataView(out.buffer).setFloat32(a.length + t.length, value, false);
  return out;
}

export function normalizeTunable(name: string, value: number): number {
  const t = TUNABLES[name];
  if (!t) throw new Error(`unknown block tunable ${name}`);
  return Math.min(1, Math.max(0, (value - t.min) / (t.max - t.min)));
}

/** Sends block tunables (real units) and the exporter's on switch to VRChat's OSC input. */
export class AvatarBlockLink {
  private socket: Deno.DatagramConn | null = null;
  constructor(private port = 9000) {}

  async send(values: Record<string, number>, enabled = true): Promise<void> {
    this.socket ??= Deno.listenDatagram({ hostname: "127.0.0.1", port: 0, transport: "udp" });
    const to = { hostname: "127.0.0.1", port: this.port, transport: "udp" as const };
    await this.socket.send(oscMessage("/avatar/parameters/PetPlayDepth/Enabled", enabled), to);
    for (const [name, value] of Object.entries(values)) {
      const address = `/avatar/parameters/${TUNABLES[name].parameter}`;
      await this.socket.send(oscMessage(address, normalizeTunable(name, value)), to);
    }
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}

/** Follows VRChat's newest log for "Entering Room:" lines, reading only what was appended. */
export class WorldWatcher {
  private file: string | null = null;
  private offset = 0;
  world: string | null = null;
  /** Counts room entries seen since start (not those before it). */
  entries = 0;

  /** Reads new log lines; true when a world was entered since the last call. */
  poll(): boolean {
    const dir = vrchatDataDir();
    if (!dir) return false;
    let newest: string | undefined;
    try {
      newest = [...Deno.readDirSync(dir)]
        .filter((entry) => entry.name.startsWith("output_log_"))
        .map((entry) => entry.name)
        .sort()
        .at(-1);
    } catch {
      return false;
    }
    if (!newest) return false;
    const path = `${dir}/${newest}`;
    let changed = false;
    if (path !== this.file) {
      // A new log is a VRChat restart: whatever it enters next is a new world. Skip the old
      // contents of a log that was already there when we started.
      const fresh = this.file !== null;
      this.file = path;
      this.offset = fresh ? 0 : (Deno.statSync(path).size);
    }
    const size = Deno.statSync(path).size;
    if (size > this.offset) {
      const file = Deno.openSync(path, { read: true });
      try {
        file.seekSync(this.offset, Deno.SeekMode.Start);
        const buffer = new Uint8Array(Math.min(size - this.offset, 4 << 20));
        const read = file.readSync(buffer) ?? 0;
        this.offset += read;
        const text = new TextDecoder().decode(buffer.subarray(0, read));
        for (const match of text.matchAll(/Entering Room: (.*)/g)) {
          this.world = match[1].trim();
          this.entries++;
          changed = true;
        }
      } finally {
        file.close();
      }
    }
    return changed;
  }
}
