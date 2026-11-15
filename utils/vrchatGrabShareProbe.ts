/**
 * Reads the GrabPass experiment (`unity/PetPlayDepth/PetPlayGrabShareTest.shader`) from VRChat's
 * desktop window in Stream mode: does a named GrabPass from the eye pass reach the camera pass?
 *
 * deno run -A utils/vrchatGrabShareProbe.ts [on|off|read] [dir]
 *   on   sets PetPlayDepth/GrabTest, waits, then reads (default)
 *   off  clears it
 *   read only reads
 *
 * Prints, per patch, the share of magenta/green (the eye's marker), yellow (the reference) and
 * dark pixels, and a verdict. Only those numbers leave the capture: the image stays in `dir`.
 */
import { join } from "@std/path";
import { Buffer } from "node:buffer";
import { PNG } from "pngjs";
import { sendOsc } from "./vrlab/vrchat.ts";
import { findX11Window } from "./vrlab/x11.ts";
import { desktopEnv } from "./vrlab/util.ts";

const PARAMETER = "/avatar/parameters/PetPlayDepth/GrabTest";
const PATCH = 256, GAP = 272, MARGIN = 16;

type Stats = { marker: number; magenta: number; green: number; yellow: number; dark: number };

function patchStats(png: PNG, x0: number, y0: number): Stats {
  let magenta = 0, green = 0, yellow = 0, dark = 0;
  // The inner 240 px: the patch edges can blend with the scene.
  for (let y = y0 + 8; y < y0 + PATCH - 8; y++) {
    for (let x = x0 + 8; x < x0 + PATCH - 8; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      if (r > 180 && g < 80 && b > 180) magenta++;
      else if (r < 80 && g > 180 && b < 80) green++;
      else if (r > 180 && g > 180 && b < 80) yellow++;
      if (r < 16 && g < 16 && b < 16) dark++;
    }
  }
  const n = (PATCH - 16) ** 2;
  return {
    marker: (magenta + green) / n,
    magenta: magenta / n,
    green: green / n,
    yellow: yellow / n,
    dark: dark / n,
  };
}

async function capture(dir: string): Promise<PNG> {
  for (const [key, value] of Object.entries(desktopEnv())) {
    if (!Deno.env.get(key)) Deno.env.set(key, value);
  }
  const window = findX11Window("VRChat");
  if (!window) throw new Error("no VRChat window");
  Deno.mkdirSync(dir, { recursive: true });
  const path = join(dir, "grab-share-window.png");
  const out = await new Deno.Command("import", { args: ["-window", String(window.id), path] })
    .output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return PNG.sync.read(Buffer.from(Deno.readFileSync(path)));
}

async function read(dir: string): Promise<void> {
  const png = await capture(dir);
  // Patches 0 (reference), 1 (array read), 2 (2D read) from the shader's PatchVert.
  const y0 = png.height - MARGIN - PATCH;
  const patches = [0, 1, 2].map((p) =>
    patchStats(png, png.width - MARGIN - PATCH - (2 - p) * GAP, y0)
  );
  const [reference, array, flat] = patches;
  const verdict = reference.yellow < 0.9
    ? "no reference patch: the test isn't drawing in the camera pass (toggle off, avatar not reloaded, or not in Stream mode)"
    : array.marker > 0.0005 || flat.marker > 0.0005
    ? `the eye's grab reached the camera pass (${
      array.marker > flat.marker ? "as a texture array" : "as a 2D texture"
    })`
    : "no marker in either grab patch: the camera pass sees its own grab (or none)";
  console.log(JSON.stringify(
    { window: { width: png.width, height: png.height }, reference, array, flat, verdict },
    (_k, v) => typeof v === "number" ? Math.round(v * 10000) / 10000 : v,
    2,
  ));
}

if (import.meta.main) {
  const [command = "on", dir = "_scratch/vrchat-depth/grab-share"] = Deno.args;
  if (command === "off") {
    await sendOsc(PARAMETER, false);
  } else {
    if (command === "on") {
      await sendOsc(PARAMETER, true);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    await read(dir);
  }
  Deno.exit(0);
}
