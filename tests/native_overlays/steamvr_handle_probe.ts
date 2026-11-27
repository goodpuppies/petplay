/**
 * Which of the things that get reused makes SteamVR show an old picture on a new overlay? Asked of
 * SteamVR itself (`IVROverlay::GetOverlayImageData`), every quad 40 m below the floor.
 *
 *   deno run -A --no-check tests/native_overlays/steamvr_handle_probe.ts
 *
 * What it shows (SteamVR 2.18.4): an overlay's picture keeps the size of the first OpenGL texture
 * the overlay was given (B, I). A later texture at least as large both ways is cut down to its
 * lower-left corner (J), one smaller either way is not taken at all (B, I). Nothing resets that
 * (F), and it outlives the overlay: the next overlay created gets the destroyed one's slot, the
 * low half of its handle, and the size with it (C, D). `GetOverlayTextureSize` shows the size
 * SteamVR holds right after `SetOverlayTexture` (G). The OpenGL texture's number plays no part
 * (H), and overlays that each keep to one size are fine (A, E).
 */
import * as OpenVR from "../../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { createStruct } from "../../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import raylib from "../../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import { OpenVrRuntime } from "../../classes/openVrRuntime.ts";
import { getRaylibLibraryPath } from "../../classes/nativeLibraryPaths.ts";

const runtime = new OpenVrRuntime("PetPlay overlay handle probe");
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
raylib.H.InitWindow(64, 64, "PetPlay overlay handle probe");

type Rgb = [number, number, number];
const RED: Rgb = [255, 0, 0], GREEN: Rgb = [0, 255, 0], BLUE: Rgb = [0, 0, 255];
const YELLOW: Rgb = [255, 255, 0], WHITE: Rgb = [255, 255, 255], PINK: Rgb = [255, 0, 255];
const names = new Map<string, string>([
  [String(RED), "red"],
  [String(GREEN), "green"],
  [String(BLUE), "blue"],
  [String(YELLOW), "yellow"],
  [String(WHITE), "white"],
  [String(PINK), "pink"],
]);
const rl = ([r, g, b]: Rgb) => ({ r, g, b, a: 255 }) as raylib.Color;
const colours5 = [RED, GREEN, BLUE, YELLOW, PINK];

function paint(target: raylib.RenderTexture2D, colour: Rgb) {
  raylib.BeginDrawing();
  raylib.H.BeginTextureMode(target);
  raylib.H.ClearBackground(rl(colour));
  raylib.EndTextureMode();
  raylib.EndDrawing();
}

const kept: unknown[] = [];
let serial = 0;
const live = new Set<OpenVR.OverlayHandle>();
function createOverlay(key = `petplay.handleprobe.${Deno.pid}.${serial}`): OpenVR.OverlayHandle {
  serial++;
  const handlePointer = P.BigUint64P<OpenVR.OverlayHandle>();
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
  live.add(handle);
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
const hex = (handle: OpenVR.OverlayHandle) => `0x${handle.toString(16)}`;

/** The picture SteamVR holds for `handle`: its size and the colour in its middle. */
function held(handle: OpenVR.OverlayHandle): string {
  const size = new Uint32Array(2);
  const sizeAt = (i: number) => Deno.UnsafePointer.of(size.subarray(i, i + 1)) as never;
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
  const x = width >> 1, y = height >> 1;
  const rgb = Array.from(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 3))
    .map((c) => c > 200 ? 255 : c < 60 ? 0 : c) as Rgb;
  return `${width}x${height} ${names.get(String(rgb)) ?? `(${rgb})`}`;
}

const targets: raylib.RenderTexture2D[] = [];
const load = (width: number, height: number, colour: Rgb) => {
  const target = raylib.H.LoadRenderTexture(width, height);
  targets.push(target);
  paint(target, colour);
  return target;
};
const destroy = (handle: OpenVR.OverlayHandle, how: "quick" | "waited" | "kept-texture") => {
  overlay.HideOverlay(handle);
  if (how !== "kept-texture") overlay.ClearOverlayTexture(handle);
  if (how === "waited") overlay.WaitFrameSync(100);
  overlay.DestroyOverlay(handle);
  live.delete(handle);
};
const report = (label: string, want: string, handle: OpenVR.OverlayHandle) => {
  const got = held(handle);
  console.log(`${got === want ? "ok  " : "BAD "} ${label}: want ${want}, SteamVR holds ${got}`);
};

try {
  // A. Control: two overlays side by side, nothing destroyed.
  const a1 = createOverlay();
  const ta1 = load(600, 400, RED);
  setTexture(a1, ta1);
  frames(10);
  const a2 = createOverlay();
  const ta2 = load(400, 600, BLUE);
  setTexture(a2, ta2);
  frames(10);
  console.log(
    `A. overlays ${hex(a1)} (texture ${ta1.texture.id}) and ${hex(a2)} (texture ${ta2.texture.id})`,
  );
  report("A. first overlay", "600x400 red", a1);
  report("A. second overlay, other size", "400x600 blue", a2);

  // B. One live overlay changes its texture's size.
  const tb = load(300, 500, GREEN);
  setTexture(a1, tb);
  frames(10);
  report(
    `B. live overlay ${hex(a1)} given texture ${tb.texture.id} of another size`,
    "300x500 green",
    a1,
  );
  setTexture(a1, tb);
  frames(10);
  report("B. presented a second time", "300x500 green", a1);
  setTexture(a1, ta1);
  frames(10);
  report("B. and back to its first texture", "600x400 red", a1);

  // C. Destroy an overlay; a new overlay gets a texture of another size that was never used.
  for (const how of ["quick", "waited", "kept-texture"] as const) {
    const old = createOverlay();
    const told = load(640, 320, RED);
    setTexture(old, told);
    frames(10);
    report(`C(${how}). overlay ${hex(old)} with texture ${told.texture.id}`, "640x320 red", old);
    destroy(old, how);
    frames(how === "waited" ? 10 : 2);
    const fresh = createOverlay();
    const tfresh = load(320, 640, YELLOW);
    setTexture(fresh, tfresh);
    frames(10);
    report(
      `C(${how}). NEW overlay ${hex(fresh)}${
        fresh === old ? " (the destroyed one's handle)" : ""
      } ` +
        `with never-used texture ${tfresh.texture.id}`,
      "320x640 yellow",
      fresh,
    );
    setTexture(fresh, tfresh);
    frames(10);
    report(`C(${how}). presented a second time`, "320x640 yellow", fresh);
    const tsame = load(640, 320, PINK);
    setTexture(fresh, tsame);
    frames(10);
    report(
      `C(${how}). then a never-used texture ${tsame.texture.id} of the destroyed one's size`,
      "640x320 pink",
      fresh,
    );
    console.log(`     meanwhile the first overlay: ${held(a1)}, the second: ${held(a2)}`);
  }

  // D. The same key again after a destroy (what a panel that comes back does).
  const key = `petplay.handleprobe.${Deno.pid}.samekey`;
  const d1 = createOverlay(key);
  const td1 = load(512, 256, RED);
  setTexture(d1, td1);
  frames(10);
  report(`D. overlay ${hex(d1)} under a key`, "512x256 red", d1);
  destroy(d1, "waited");
  frames(10);
  const d2 = createOverlay(key);
  const td2 = load(256, 512, BLUE);
  setTexture(d2, td2);
  frames(10);
  report(
    `D. NEW overlay ${hex(d2)} under the same key, never-used texture of another size`,
    "256x512 blue",
    d2,
  );

  // F. Does anything make a live overlay take another size?
  const textureSize = (handle: OpenVR.OverlayHandle) => {
    const size = new Uint32Array(2);
    const error = overlay.GetOverlayTextureSize(
      handle,
      Deno.UnsafePointer.of(size.subarray(0, 1)) as never,
      Deno.UnsafePointer.of(size.subarray(1, 2)) as never,
    );
    return error === OpenVR.OverlayError.VROverlayError_None
      ? `${size[0]}x${size[1]}`
      : OpenVR.OverlayError[error];
  };
  const resets: [string, (handle: OpenVR.OverlayHandle) => void][] = [
    ["ClearOverlayTexture", (handle) => {
      overlay.ClearOverlayTexture(handle);
    }],
    ["ClearOverlayTexture + hide and show", (handle) => {
      overlay.HideOverlay(handle);
      overlay.ClearOverlayTexture(handle);
      frames(4);
      overlay.ShowOverlay(handle);
    }],
    ["SetOverlayRaw 2x2", (handle) => {
      const pixels = new Uint8Array(16).fill(255);
      kept.push(pixels);
      const error = overlay.SetOverlayRaw(handle, Deno.UnsafePointer.of(pixels) as never, 2, 2, 4);
      console.log(`     SetOverlayRaw: ${OpenVR.OverlayError[error]}`);
    }],
  ];
  for (const [name, reset] of resets) {
    const handle = createOverlay();
    const t1 = load(480, 240, RED);
    setTexture(handle, t1);
    frames(10);
    report(`F(${name}). overlay ${hex(handle)}`, "480x240 red", handle);
    reset(handle);
    frames(10);
    console.log(
      `     after the reset SteamVR holds ${held(handle)}, texture size ${textureSize(handle)}`,
    );
    const t2 = load(240, 480, BLUE);
    setTexture(handle, t2);
    console.log(`     right after SetOverlayTexture: texture size ${textureSize(handle)}`);
    frames(1);
    console.log(`     one frame later: texture size ${textureSize(handle)}`);
    frames(10);
    report(`F(${name}). then a texture of another size`, "240x480 blue", handle);
    console.log(`     texture size ${textureSize(handle)}`);
  }

  // G. How soon can a wrong size be seen? A fresh overlay, then one in a destroyed one's slot.
  {
    const first = createOverlay();
    setTexture(first, load(352, 288, RED));
    console.log(
      `G. fresh overlay ${hex(first)}, 352x288: texture size right away ${textureSize(first)}`,
    );
    frames(1);
    console.log(`     one frame later ${textureSize(first)}`);
    frames(3);
    console.log(`     four frames later ${textureSize(first)}, holds ${held(first)}`);
    destroy(first, "quick");
    const second = createOverlay();
    setTexture(second, load(288, 352, BLUE));
    console.log(
      `G. overlay ${hex(second)} in its slot, 288x352: texture size right away ${
        textureSize(second)
      }, holds ${held(second)}`,
    );
    frames(1);
    console.log(`     one frame later ${textureSize(second)}, holds ${held(second)}`);
    frames(3);
    console.log(`     four frames later ${textureSize(second)}, holds ${held(second)}`);
  }

  // H. Does the OpenGL texture number matter by itself? A number SteamVR saw at one size comes
  // back at another, on an overlay whose slot was never used before.
  {
    const seen = createOverlay();
    const unused = createOverlay();
    const victim = raylib.H.LoadRenderTexture(416, 208);
    paint(victim, RED);
    setTexture(seen, victim);
    frames(10);
    const replacement = load(416, 208, GREEN);
    setTexture(seen, replacement);
    frames(10);
    const freed = victim.texture.id;
    raylib.H.UnloadRenderTexture(victim);
    let reused: raylib.RenderTexture2D | null = null;
    for (let i = 0; i < 8 && !reused; i++) {
      const candidate = load(208, 416, BLUE);
      if (candidate.texture.id === freed) reused = candidate;
    }
    if (!reused) console.log(`H. OpenGL did not hand out ${freed} again; not tested`);
    else {
      setTexture(unused, reused);
      frames(10);
      report(
        `H. never-used overlay ${hex(unused)} given freed texture number ${freed} at another size`,
        "208x416 blue",
        unused,
      );
      report(`H. the overlay that showed that number before`, "416x208 green", seen);
    }
  }

  // I. Is it any other size, or only another shape? One live overlay, the same shape larger and
  // smaller, then another shape.
  for (const start of [[512, 512], [400, 200]] as const) {
    const handle = createOverlay();
    const sizes = [start, [start[0] * 2, start[1] * 2], [start[0] / 2, start[1] / 2], start, [
      start[1],
      start[0] * 2,
    ]];
    for (const [index, [w, h]] of sizes.entries()) {
      const colour = colours5[index % 5]!;
      setTexture(handle, load(w!, h!, colour));
      frames(10);
      report(
        `I. overlay ${hex(handle)} given ${w}x${h}${index === 0 ? " first" : ""}`,
        `${w}x${h} ${names.get(String(colour))}`,
        handle,
      );
    }
  }

  // J. A texture larger than the overlay's first: squeezed into the old size, or cut?
  {
    const handle = createOverlay();
    setTexture(handle, load(256, 256, RED));
    frames(10);
    const big = raylib.H.LoadRenderTexture(512, 512);
    targets.push(big);
    raylib.BeginDrawing();
    raylib.H.BeginTextureMode(big);
    raylib.H.ClearBackground(rl(RED));
    raylib.H.DrawRectangle(256, 0, 256, 256, rl(GREEN));
    raylib.H.DrawRectangle(0, 256, 256, 256, rl(BLUE));
    raylib.H.DrawRectangle(256, 256, 256, 256, rl(YELLOW));
    raylib.EndTextureMode();
    raylib.EndDrawing();
    setTexture(handle, big);
    frames(10);
    const size = new Uint32Array(2);
    const sizeAt = (i: number) => Deno.UnsafePointer.of(size.subarray(i, i + 1)) as never;
    overlay.GetOverlayImageData(handle, null as never, 0, sizeAt(0), sizeAt(1));
    const [w, h] = [size[0]!, size[1]!];
    const data = new Uint8Array(w * h * 4);
    overlay.GetOverlayImageData(
      handle,
      Deno.UnsafePointer.of(data) as never,
      data.length,
      sizeAt(0),
      sizeAt(1),
    );
    const at = (u: number, v: number) => {
      const i = (Math.floor(v * h) * w + Math.floor(u * w)) * 4;
      const rgb = Array.from(data.subarray(i, i + 3)).map((c) =>
        c > 200 ? 255 : c < 60 ? 0 : c
      ) as Rgb;
      return names.get(String(rgb)) ?? `(${rgb})`;
    };
    console.log(
      `J. a 256x256 overlay given a 512x512 texture in four quarters: SteamVR holds ${w}x${h} with ` +
        `${at(0.25, 0.25)}, ${at(0.75, 0.25)}, ${at(0.25, 0.75)}, ${
          at(0.75, 0.75)
        } in its quarters ` +
        `(four colours = squeezed, one = cut)`,
    );
  }

  // E. Many overlays at once, each its own size: does every one keep its own picture?
  const many: [OpenVR.OverlayHandle, string][] = [];
  const colours = [RED, GREEN, BLUE, YELLOW, PINK];
  for (let i = 0; i < 10; i++) {
    const handle = createOverlay();
    const [w, h] = [200 + 40 * i, 440 - 24 * i];
    setTexture(handle, load(w, h, colours[i % 5]!));
    many.push([handle, `${w}x${h} ${names.get(String(colours[i % 5]))}`]);
  }
  frames(12);
  for (const [handle, want] of many) report(`E. overlay ${hex(handle)}`, want, handle);
} finally {
  for (const handle of live) {
    overlay.HideOverlay(handle);
    overlay.ClearOverlayTexture(handle);
  }
  overlay.WaitFrameSync(100);
  for (const handle of live) overlay.DestroyOverlay(handle);
  for (const target of targets) raylib.H.UnloadRenderTexture(target);
  raylib.CloseWindow();
  runtime.shutdown();
}
