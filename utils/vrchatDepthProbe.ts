/**
 * Phase 2 probe for VRChat depth (markdown/vrchat-depth/README.md): drives the debug avatar's
 * block over OSC and decodes it from the headset image and from VRChat's desktop window.
 *
 * ```sh
 * deno run -A utils/vrchatDepthProbe.ts avatar <avtr_…>          # switch to the debug avatar
 * deno run -A utils/vrchatDepthProbe.ts set originX=960 cellPx=2   # block layout (real units)
 * deno run -A utils/vrchatDepthProbe.ts eye [dir]                  # decode the headset's layers
 * deno run -A utils/vrchatDepthProbe.ts window [dir]               # decode the VRChat window
 * ```
 *
 * `set` names: enabled (0/1), originX, originY (eye px), cellPx, bits, depthSize, gridWidth, eye (0/1), target (0 eye, 1 camera),
 * flipImageY (0/1), calibration3D (0/1), levelInset (0..64). The ranges match PetPlayDepthAvatarBuilder's tunables.
 */
import { join } from "@std/path";
import { Buffer } from "node:buffer";
import { PNG } from "pngjs";
import { decodeImage, type DecodeResult, type ImageView } from "../classes/vrchatDepth/format.ts";
import { TUNABLES } from "../classes/vrchatDepth/blockLayout.ts";
import { captureEyes } from "./vrlab/eye.ts";
import { sendOsc } from "./vrlab/vrchat.ts";
import { findX11Window } from "./vrlab/x11.ts";
import { desktopEnv } from "./vrlab/util.ts";

function readPng(path: string): ImageView {
  const png = PNG.sync.read(Buffer.from(Deno.readFileSync(path)));
  return { width: png.width, height: png.height, data: png.data, channels: 4 };
}

export function summarize(label: string, result: DecodeResult): Record<string, unknown> {
  if (!result.ok) {
    return {
      label,
      ok: false,
      reason: result.reason,
      detail: result.detail,
      location: result.location,
    };
  }
  const { header, depth, layout } = result.frame;
  const valid = Array.from(depth).filter((d) => d > 0);
  valid.sort((a, b) => a - b);
  return {
    label,
    ok: true,
    location: result.location,
    calibrationMargin: result.calibrationMargin,
    grid: `${layout.gridWidth}x${layout.gridHeight}, ${
      layout.bits.join("/")
    } bits, depth ${layout.depthWidth}x${layout.depthHeight}`,
    eye: header.eye,
    flags: header.flags,
    screen: [header.screenWidth, header.screenHeight],
    nearFar: [header.near, header.far],
    projection: header.projection,
    cameraPosition: [header.viewToWorld[3], header.viewToWorld[7], header.viewToWorld[11]],
    // Heading of the view direction (−z column), degrees clockwise from +z like Unity's yaw.
    yaw: Math.atan2(-header.viewToWorld[2], -header.viewToWorld[10]) * 180 / Math.PI,
    // The head anchor (format v2): where the wearer's head is in VRChat's world, in any pass.
    anchorPosition: [header.anchorToWorld[3], header.anchorToWorld[7], header.anchorToWorld[11]],
    // Heading of the anchor's +z (the avatar's forward at build time), same convention as yaw.
    anchorYaw: Math.atan2(header.anchorToWorld[2], header.anchorToWorld[10]) * 180 / Math.PI,
    anchorToWorld: header.anchorToWorld,
    viewToWorld: header.viewToWorld,
    time: new Float32Array(new Uint32Array([header.timeTag]).buffer)[0],
    depth: {
      validFraction: valid.length / depth.length,
      min: valid[0],
      median: valid[Math.floor(valid.length / 2)],
      max: valid.at(-1),
    },
  };
}

async function main() {
  const [command, ...rest] = Deno.args;
  switch (command) {
    case "avatar": {
      if (!rest[0]?.startsWith("avtr_")) throw new Error("usage: avatar <avtr_…>");
      await sendOsc("/avatar/change", rest[0]);
      console.log(`requested ${rest[0]}`);
      break;
    }
    case "set": {
      for (const pair of rest) {
        const [name, raw] = pair.split("=");
        const value = Number(raw);
        if (name === "enabled") {
          await sendOsc("/avatar/parameters/PetPlayDepth/Enabled", value !== 0);
          continue;
        }
        const t = TUNABLES[name];
        if (!t || !Number.isFinite(value)) throw new Error(`unknown setting ${pair}`);
        const normalized = Math.min(1, Math.max(0, (value - t.min) / (t.max - t.min)));
        await sendOsc(`/avatar/parameters/${t.parameter}`, { f: normalized });
        console.log(`${t.parameter} = ${normalized} (${value})`);
      }
      break;
    }
    case "eye": {
      const dir = rest[0] ?? "_scratch/vrchat-depth";
      Deno.mkdirSync(dir, { recursive: true });
      const capture = await captureEyes(join(dir, "eye.png"), { layers: true });
      console.log(JSON.stringify(capture.layers));
      for (const file of capture.files) {
        console.log(JSON.stringify(summarize(file, decodeImage(readPng(file)))));
      }
      break;
    }
    case "window": {
      const dir = rest[0] ?? "_scratch/vrchat-depth";
      Deno.mkdirSync(dir, { recursive: true });
      for (const [key, value] of Object.entries(desktopEnv())) {
        if (!Deno.env.get(key)) Deno.env.set(key, value);
      }
      const window = findX11Window("VRChat");
      if (!window) throw new Error("no VRChat window");
      const path = join(dir, "window.png");
      const out = await new Deno.Command("import", {
        args: ["-window", String(window.id), path],
      }).output();
      if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
      console.log(JSON.stringify({ window: { width: window.width, height: window.height }, path }));
      console.log(JSON.stringify(summarize(path, decodeImage(readPng(path)))));
      break;
    }
    default:
      throw new Error("commands: avatar, set, eye, window");
  }
}

if (import.meta.main) {
  await main();
  Deno.exit(0);
}
