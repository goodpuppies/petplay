/**
 * What SteamVR holds for the native quads of a **running PetPlay**: lists them and saves each one's
 * picture as SteamVR has it (`IVROverlay::GetOverlayImageData`), so a wrong picture on a quad can
 * be looked at without a headset. Shows nothing in the headset and changes nothing.
 *
 *   deno run -A --no-check tests/native_overlays/steamvr_dump.ts [pid ...]
 *
 * Without pids it tries every running `petplay` process: the quads belong to the one that hosts
 * the scene. Pictures go to `_scratch/native-overlays/live/`.
 */
import { PNG } from "pngjs";
import * as OpenVR from "../../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { OpenVrRuntime } from "../../classes/openVrRuntime.ts";

const KEY_BASE = "petplay.webxr.overlay.independent";
const MAX_QUADS = 96;

async function petplayPids(): Promise<number[]> {
  if (Deno.build.os === "windows") {
    const out = await new Deno.Command("tasklist", { args: ["/FO", "CSV", "/NH"] }).output();
    return new TextDecoder().decode(out.stdout).split("\n")
      .map((line) => line.split(",").map((cell) => cell.replaceAll('"', "")))
      .filter(([name]) => name?.toLowerCase().startsWith("petplay"))
      .map(([, pid]) => Number(pid)).filter(Number.isFinite);
  }
  const out = await new Deno.Command("pgrep", { args: ["-i", "petplay"] }).output();
  return new TextDecoder().decode(out.stdout).split("\n").map(Number).filter((pid) => pid > 0);
}

const pids = Deno.args.length > 0 ? Deno.args.map(Number) : await petplayPids();
const runtime = new OpenVrRuntime("PetPlay native overlay dump");
let pointers;
try {
  pointers = runtime.initialize({ system: "required", overlay: "required" });
} catch (error) {
  console.log(`SKIP: SteamVR is not running (${(error as Error).message})`);
  Deno.exit(0);
}
const overlay = new OpenVR.IVROverlay(pointers.overlay!);
const folder = `${Deno.cwd()}/_scratch/native-overlays/live`;
Deno.mkdirSync(folder, { recursive: true });

const pair = new Uint32Array(2);
const at = (i: number) => Deno.UnsafePointer.of(pair.subarray(i, i + 1)) as never;
const float = new Float32Array(1);
const byte = new Uint8Array(1);
let found = 0;
try {
  for (const pid of pids) {
    for (let index = 0; index < MAX_QUADS; index++) {
      const key = `${KEY_BASE}.${pid}.native.quad${index}`;
      const pointer = P.BigUint64P<OpenVR.OverlayHandle>();
      if (overlay.FindOverlay(key, pointer) !== OpenVR.OverlayError.VROverlayError_None) continue;
      const handle = new Deno.UnsafePointerView(pointer).getBigUint64();
      found++;
      overlay.GetOverlayWidthInMeters(handle, Deno.UnsafePointer.of(float) as never);
      const width = float[0]!;
      overlay.GetOverlayTexelAspect(handle, Deno.UnsafePointer.of(float) as never);
      const texelAspect = float[0]!;
      overlay.GetOverlayFlag(
        handle,
        OpenVR.OverlayFlags.VROverlayFlags_SideBySide_Parallel,
        Deno.UnsafePointer.of(byte) as never,
      );
      const stereo = byte[0] !== 0;
      pair[0] = pair[1] = 0;
      overlay.GetOverlayImageData(handle, null as never, 0, at(0), at(1));
      const [w, h] = [pair[0]!, pair[1]!];
      let saved = "no picture";
      if (w > 0 && h > 0) {
        const data = new Uint8Array(w * h * 4);
        const result = overlay.GetOverlayImageData(
          handle,
          Deno.UnsafePointer.of(data) as never,
          data.length,
          at(0),
          at(1),
        );
        if (result === OpenVR.OverlayError.VROverlayError_None) {
          const png = new PNG({ width: w, height: h });
          // SteamVR hands the rows over as OpenGL stores them, bottom first; PNG rows run down.
          for (let y = 0; y < h; y++) {
            png.data.set(data.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
          }
          const path = `${folder}/quad${index}.png`;
          Deno.writeFileSync(path, PNG.sync.write(png));
          saved = path;
        } else saved = OpenVR.OverlayError[result]!;
      }
      console.log(
        `quad${index} 0x${handle.toString(16)}: ${
          overlay.IsOverlayVisible(handle) ? "shown" : "hidden"
        }, ${width.toFixed(3)} m wide, ${stereo ? "side by side, " : ""}texel aspect ` +
          `${texelAspect.toFixed(3)}, picture ${w}x${h} -> ${saved}`,
      );
    }
  }
  if (found === 0) {
    console.log(
      `No native quads found for pids ${pids.join(", ") || "(none)"} under ${KEY_BASE}.<pid>`,
    );
  }
} finally {
  runtime.shutdown();
}
