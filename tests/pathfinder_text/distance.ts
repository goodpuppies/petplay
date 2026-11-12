/** Investigate depth invariance at fixed projected glyph size, pose and pixel position. */
import * as THREE from "three";
import { Buffer } from "node:buffer";
import { PNG } from "pngjs";
import { WebXROverlayRaylib } from "../../classes/webxrOverlayRaylib.ts";
import { RaythreeExtractor } from "../../submodules/raythree/src/lib.ts";
import { extractWebXRRaythreeUi } from "../../classes/webxrRaythreeUi.ts";
import { MSDFTextGeometry } from "../../submodules/threewebxrwebgpudeno/vendor/three-msdf-text-utils/index.ts";
import type { WebXRShadowFrame } from "../../classes/webxrhost.ts";

const output = new URL("../../_scratch/text-distance/", import.meta.url);
await Deno.mkdir(output, { recursive: true });
const size = 512;
const halfFov = 0.95;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(halfFov * 360 / Math.PI, 1, 0.1, 100);
camera.updateMatrixWorld(true);
const font = JSON.parse(Deno.readTextFileSync(
  new URL(
    "../../submodules/threewebxrwebgpudeno/vendor/three-msdf-text-utils/demo/fonts/roboto/roboto-regular.fnt",
    import.meta.url,
  ),
));
const geometry = new MSDFTextGeometry({ text: "@", font });
geometry.computeBoundingBox();
if (!geometry.boundingBox) throw new Error("Missing @ bounds");
const box = geometry.boundingBox;
const center = box.getCenter(new THREE.Vector3());
const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
mesh.userData = {
  bridge: { kind: "skip" },
  raythreeUiText: {
    text: "@",
    font: "roboto",
    color: [1, 1, 1, 1],
    fontSize: 1,
    align: "left",
    anchorX: "left",
    bounds: { minX: box.min.x, maxX: box.max.x, minY: box.min.y, maxY: box.max.y },
  },
};
scene.add(mesh);
const extractor = new RaythreeExtractor();
const compositor = new WebXROverlayRaylib(size);
compositor.initialize("PetPlay depth invariance probe");
const identity = new Float32Array(new THREE.Matrix4().elements);
const projection = new Float32Array(camera.projectionMatrix.elements);
const frame: WebXRShadowFrame = {
  frameCount: 0,
  eyeWidth: size,
  eyeHeight: size,
  outputWidth: size * 2,
  outputHeight: size * 2,
  lookRotation: identity,
  viewerPosition: new Float32Array(3),
  viewerQuaternion: new Float32Array([0, 0, 0, 1]),
  leftEyePosition: new Float32Array(3),
  rightEyePosition: new Float32Array(3),
  leftEyeQuaternion: new Float32Array([0, 0, 0, 1]),
  rightEyeQuaternion: new Float32Array([0, 0, 0, 1]),
  leftEyeViewMatrix: identity,
  rightEyeViewMatrix: identity,
  leftEyeProjectionMatrix: projection,
  rightEyeProjectionMatrix: projection,
  halfFovInRadians: halfFov,
  ipdMeters: 0,
};
type Readback = ReturnType<WebXROverlayRaylib["readRenderTargetRgba"]>;
function compare(a: Readback, b: Readback) {
  let changed = 0, max = 0, total = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let pixelChanged = false;
    for (let c = 0; c < 4; c++) {
      const delta = Math.abs(a.data[i + c] - b.data[i + c]);
      max = Math.max(max, delta);
      total += delta;
      if (delta) pixelChanged = true;
    }
    if (pixelChanged) changed++;
  }
  return {
    changedPixels: changed,
    maxChannelDifference: max,
    meanChannelDifference: total / a.data.length,
  };
}
async function save(name: string, image: Readback) {
  const png = new PNG({ width: image.width, height: image.height });
  for (let y = 0; y < image.height; y++) {
    png.data.set(
      image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4),
      (image.height - 1 - y) * image.width * 4,
    );
  }
  await Deno.writeFile(new URL(name, output), PNG.sync.write(png));
}
const results: unknown[] = [];
let worst = 0;
try {
  for (const pixels of [12, 28]) {
    for (const angle of [0, 0.6]) {
      for (const ndcX of [0.03125, 0.5]) {
        let reference: { eye: Readback; pano: Readback } | null = null;
        for (const distance of [0.25, 0.5, 1, 2, 4]) {
          const scale = pixels * 2 * distance / (size * projection[5] * (box.max.y - box.min.y));
          mesh.rotation.set(Math.PI, angle, 0);
          mesh.scale.setScalar(scale);
          const offset = center.clone().multiplyScalar(scale).applyEuler(mesh.rotation);
          mesh.position.set(
            ndcX * distance / projection[0],
            0.03125 * distance / projection[5],
            -distance,
          ).sub(offset);
          scene.updateMatrixWorld(true);
          const eye = extractor.extract(scene, camera);
          const ui = extractWebXRRaythreeUi(scene);
          ui.textRendering = {
            renderer: Deno.args.includes("--glyph") ? "glyph" : "pathfinder",
            panoramaFilter: "catmull-rom",
          };
          frame.frameCount++;
          compositor.renderRaythreeFrame({
            frame,
            background: [24, 24, 28, 255],
            leftEye: eye,
            rightEye: eye,
            ui,
          });
          const sample = {
            eye: compositor.readRenderTargetRgba("left"),
            pano: compositor.readRenderTargetRgba("output"),
          };
          if (!reference) reference = sample;
          const eyeDifference = compare(reference.eye, sample.eye),
            panoramaDifference = compare(reference.pano, sample.pano);
          results.push({
            pixels,
            angle,
            ndcX,
            distance,
            eye: eyeDifference,
            panorama: panoramaDifference,
          });
          const score = Math.max(
            eyeDifference.maxChannelDifference,
            panoramaDifference.maxChannelDifference,
          );
          if (score > worst || results.length === 1) {
            worst = score;
            await save("reference-eye.png", reference.eye);
            await save("candidate-eye.png", sample.eye);
            await save("reference-panorama.png", reference.pano);
            await save("candidate-panorama.png", sample.pano);
          }
        }
      }
    }
  }
  await Deno.writeTextFile(
    new URL("distance-results.json", output),
    JSON.stringify({ size, halfFov, results }, null, 2),
  );
  console.log(
    JSON.stringify({
      cases: results.length,
      worstChannelDifference: worst,
      output: output.pathname,
    }),
  );
} finally {
  compositor.cleanup();
}
