/**
 * What picture does SteamVR actually hold for an overlay that is fed OpenGL textures? Asked of
 * SteamVR itself (`IVROverlay::GetOverlayImageData`), with every quad 40 m below the floor, so
 * nothing shows in the headset.
 *
 *   deno run -A --no-check tests/native_overlays/steamvr_texture_probe.ts
 *
 * It answers the questions native overlays depend on:
 *
 * 1. Does each `SetOverlayTexture` take the texture's content of that moment, and which way up?
 * 2. Two textures alternate on one overlay (the one on show is never the one being drawn): does
 *    the overlay follow?
 * 3. An overlay is destroyed and its texture freed; a new overlay gets a new texture of another
 *    size, which has the freed one's OpenGL number: does it show the new picture, or the old?
 * 4. The same, when the new texture has the freed one's size.
 *
 * In 3 and 4 the new overlay also gets the destroyed one's slot, and that, not the texture's
 * number, is what decides (3 shows the old picture, 4 the new one):
 * `steamvr_handle_probe.ts` takes the two apart.
 */
import * as OpenVR from "../../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { createStruct } from "../../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import raylib from "../../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import { OpenVrRuntime } from "../../classes/openVrRuntime.ts";
import { getRaylibLibraryPath } from "../../classes/nativeLibraryPaths.ts";
import { releaseAndDestroyOpenVrOverlay } from "../../classes/openVrOverlayTexture.ts";

const runtime = new OpenVrRuntime("PetPlay overlay texture probe");
let pointers;
try {
  pointers = runtime.initialize({ system: "required", overlay: "required" });
} catch (error) {
  console.log(`SKIP: SteamVR is not running (${(error as Error).message})`);
  Deno.exit(0);
}
const overlay = new OpenVR.IVROverlay(pointers.overlay!);
raylib.loadRaylib(getRaylibLibraryPath());
raylib.SetConfigFlags(raylib.ConfigFlags.FLAG_WINDOW_HIDDEN);
raylib.H.InitWindow(64, 64, "PetPlay overlay texture probe");

type Rgb = [number, number, number];
const RED: Rgb = [255, 0, 0], GREEN: Rgb = [0, 255, 0], BLUE: Rgb = [0, 0, 255];
const YELLOW: Rgb = [255, 255, 0], WHITE: Rgb = [255, 255, 255];
const names = new Map<string, string>([
  [String(RED), "red"],
  [String(GREEN), "green"],
  [String(BLUE), "blue"],
  [String(YELLOW), "yellow"],
  [String(WHITE), "white"],
]);
const rl = ([r, g, b]: Rgb) => ({ r, g, b, a: 255 }) as raylib.Color;

/** Left half `left`, right half `right`, and a white band along the top of the picture. */
function paint(target: raylib.RenderTexture2D, left: Rgb, right: Rgb) {
  const { width, height } = target.texture;
  raylib.BeginDrawing();
  raylib.H.BeginTextureMode(target);
  raylib.H.ClearBackground(rl([0, 0, 0]));
  raylib.H.DrawRectangle(0, 0, width / 2, height, rl(left));
  raylib.H.DrawRectangle(width / 2, 0, width / 2, height, rl(right));
  // In a render texture, y = 0 is the top of the picture (the last row in GL storage).
  raylib.H.DrawRectangle(0, 0, width, height / 4, rl(WHITE));
  raylib.EndTextureMode();
  raylib.EndDrawing();
}

const kept: unknown[] = [];
let serial = 0;
function createOverlay(): OpenVR.OverlayHandle {
  const handlePointer = P.BigUint64P<OpenVR.OverlayHandle>();
  const key = `petplay.textureprobe.${Deno.pid}.${serial++}`;
  const error = overlay.CreateOverlay(key, key, handlePointer);
  if (error !== OpenVR.OverlayError.VROverlayError_None) {
    throw new Error(`CreateOverlay: ${OpenVR.OverlayError[error]}`);
  }
  const handle = new Deno.UnsafePointerView(handlePointer).getBigUint64();
  overlay.SetOverlayWidthInMeters(handle, 0.3);
  const transform = createStruct<OpenVR.HmdMatrix34>(
    { m: [[1, 0, 0, serial], [0, 1, 0, -40], [0, 0, 1, 0]] },
    OpenVR.HmdMatrix34Struct,
  );
  kept.push(transform);
  overlay.SetOverlayTransformAbsolute(
    handle,
    OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding,
    transform[0],
  );
  return handle;
}
function setTexture(handle: OpenVR.OverlayHandle, target: raylib.RenderTexture2D) {
  const struct = createStruct<OpenVR.Texture>({
    handle: BigInt(target.texture.id),
    eType: OpenVR.TextureType.TextureType_OpenGL,
    eColorSpace: OpenVR.ColorSpace.ColorSpace_Auto,
  }, OpenVR.TextureStruct);
  kept.push(struct);
  const error = overlay.SetOverlayTexture(handle, struct[0]);
  if (error !== OpenVR.OverlayError.VROverlayError_None) {
    throw new Error(`SetOverlayTexture: ${OpenVR.OverlayError[error]}`);
  }
  overlay.ShowOverlay(handle);
}
const frames = (count: number) => {
  for (let i = 0; i < count; i++) overlay.WaitFrameSync(50);
};

/** The picture SteamVR holds for `handle`, described by the colours at five places. */
function held(handle: OpenVR.OverlayHandle): string {
  const size = new Uint32Array(2);
  const sizeAt = (i: number) => Deno.UnsafePointer.of(size.subarray(i, i + 1)) as never;
  // First call with no room tells the size.
  let error = overlay.GetOverlayImageData(handle, null as never, 0, sizeAt(0), sizeAt(1));
  const [width, height] = [size[0]!, size[1]!];
  if (!(width > 0 && height > 0)) return `no image (${OpenVR.OverlayError[error]})`;
  const data = new Uint8Array(width * height * 4);
  error = overlay.GetOverlayImageData(
    handle,
    Deno.UnsafePointer.of(data) as never,
    data.length,
    sizeAt(0),
    sizeAt(1),
  );
  if (error !== OpenVR.OverlayError.VROverlayError_None) {
    return `${width}x${height}, unreadable (${OpenVR.OverlayError[error]})`;
  }
  const at = (u: number, v: number) => {
    const x = Math.min(width - 1, Math.floor(u * width));
    const y = Math.min(height - 1, Math.floor(v * height));
    const rgb = Array.from(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 3))
      .map((c) => c > 200 ? 255 : c < 60 ? 0 : c) as Rgb;
    return names.get(String(rgb)) ?? `(${rgb})`;
  };
  // Rows as delivered: the first row is `v = 0`.
  return `${width}x${height}: first rows ${at(0.25, 0.1)}|${at(0.75, 0.1)}, ` +
    `middle ${at(0.25, 0.6)}|${at(0.75, 0.6)}, last rows ${at(0.25, 0.9)}|${at(0.75, 0.9)}`;
}

const handles: OpenVR.OverlayHandle[] = [];
const targets: raylib.RenderTexture2D[] = [];
const load = (width: number, height: number) => {
  const target = raylib.H.LoadRenderTexture(width, height);
  targets.push(target);
  return target;
};
try {
  // 1. Content and orientation.
  const first = createOverlay();
  handles.push(first);
  const a = load(400, 200);
  paint(a, RED, GREEN);
  setTexture(first, a);
  frames(12);
  console.log(
    `1. texture ${a.texture.id} (400x200, red|green, white band on top): SteamVR holds ${
      held(first)
    }`,
  );
  // Drawing into the texture again, without telling SteamVR: does its picture change?
  paint(a, BLUE, YELLOW);
  frames(12);
  console.log(`1. repainted blue|yellow, not presented: SteamVR holds ${held(first)}`);
  setTexture(first, a);
  frames(12);
  console.log(`1. presented again: SteamVR holds ${held(first)}`);

  // 2. Two textures alternating on one overlay.
  const b = load(400, 200);
  paint(b, GREEN, RED);
  setTexture(first, b);
  frames(12);
  console.log(
    `2. second texture ${b.texture.id} (green|red) presented: SteamVR holds ${held(first)}`,
  );
  paint(a, YELLOW, BLUE);
  setTexture(first, a);
  frames(12);
  console.log(
    `2. back to texture ${a.texture.id}, repainted yellow|blue: SteamVR holds ${held(first)}`,
  );

  // 3. A freed texture's number, reused at another size on another overlay.
  const victim = load(400, 200);
  paint(victim, RED, RED);
  const old = createOverlay();
  setTexture(old, victim);
  frames(12);
  console.log(
    `3. overlay with texture ${victim.texture.id} (400x200, all red): SteamVR holds ${held(old)}`,
  );
  releaseAndDestroyOpenVrOverlay(overlay, old);
  const freed = victim.texture.id;
  raylib.H.UnloadRenderTexture(victim);
  targets.splice(targets.indexOf(victim), 1);
  frames(12);
  let reused: raylib.RenderTexture2D | null = null;
  const spare: raylib.RenderTexture2D[] = [];
  for (let i = 0; i < 8 && !reused; i++) {
    const candidate = load(300, 300);
    if (candidate.texture.id === freed) reused = candidate;
    else spare.push(candidate);
  }
  if (!reused) {
    console.log(
      `3. OpenGL did not hand out ${freed} again (got ${
        spare.map((t) => t.texture.id)
      }); not tested`,
    );
  } else {
    paint(reused, BLUE, BLUE);
    const next = createOverlay();
    handles.push(next);
    setTexture(next, reused);
    frames(12);
    console.log(
      `3. NEW overlay, NEW texture with the freed number ${freed} (300x300, all blue): SteamVR holds ${
        held(next)
      }`,
    );
    setTexture(next, reused);
    frames(12);
    console.log(`3. presented a second time: SteamVR holds ${held(next)}`);
  }

  // 4. The same with the freed texture's own size.
  const victim2 = load(256, 128);
  paint(victim2, RED, RED);
  const old2 = createOverlay();
  setTexture(old2, victim2);
  frames(12);
  releaseAndDestroyOpenVrOverlay(overlay, old2);
  const freed2 = victim2.texture.id;
  raylib.H.UnloadRenderTexture(victim2);
  targets.splice(targets.indexOf(victim2), 1);
  frames(12);
  let reused2: raylib.RenderTexture2D | null = null;
  for (let i = 0; i < 8 && !reused2; i++) {
    const candidate = load(256, 128);
    if (candidate.texture.id === freed2) reused2 = candidate;
  }
  if (!reused2) console.log(`4. OpenGL did not hand out ${freed2} again; not tested`);
  else {
    paint(reused2, BLUE, BLUE);
    const next = createOverlay();
    handles.push(next);
    setTexture(next, reused2);
    frames(12);
    console.log(
      `4. NEW overlay, NEW texture with the freed number ${freed2}, same size (all blue): SteamVR holds ${
        held(next)
      }`,
    );
  }
} finally {
  for (const handle of handles) releaseAndDestroyOpenVrOverlay(overlay, handle);
  for (const target of targets) raylib.H.UnloadRenderTexture(target);
  raylib.CloseWindow();
  runtime.shutdown();
}
