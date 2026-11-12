/** Regression: antialiased UI edges must not punch holes in an opaque backdrop.
 * Renders production panels and stereo panorama offscreen, without SteamVR.
 */
import * as THREE from "three";
import { WebXROverlayRaylib } from "../../classes/webxrOverlayRaylib.ts";
import { RaythreeExtractor } from "../../submodules/raythree/src/lib.ts";
import type { WebXRRaythreeUiPanelSnapshot } from "../../classes/webxrRaythreeUi.ts";
import type { WebXRShadowFrame } from "../../classes/webxrhost.ts";

const size = 256;
const halfFov = 0.95;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(halfFov * 360 / Math.PI, 1, 0.1, 100);
camera.updateMatrixWorld(true);
const eye = new RaythreeExtractor().extract(scene, camera);
const identity = new Float32Array(new THREE.Matrix4().elements);
const projection = new Float32Array(camera.projectionMatrix.elements);
const frame: WebXRShadowFrame = {
  frameCount: 1,
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
function panel(
  index: number,
  width: number,
  height: number,
  radius: number,
): WebXRRaythreeUiPanelSnapshot {
  const data = new Float32Array(16);
  data.set(index === 0 ? [0.1, 0.15, 0.2, 1] : [0.8, 0.7, 0.6, 1], 4);
  const r = Math.round(radius * 100);
  data[8] = r * (125000 + 2500 + 50 + 1);
  data[14] = width;
  data[15] = height;
  return {
    worldMatrix: new Float32Array(
      new THREE.Matrix4().makeScale(width, height, 1).setPosition(0.013, 0.017, -1).elements,
    ),
    data,
    clipping: new Float32Array([1, 0, 0, 100, -1, 0, 0, 100, 0, 1, 0, 100, 0, -1, 0, 100]),
    instanceIndex: index,
    renderOrder: index,
    depthTest: false,
    depthWrite: false,
    rootIndex: 0,
  };
}
const compositor = new WebXROverlayRaylib(size);
compositor.initialize("PetPlay UI alpha regression (offscreen)");
let completed = false;
try {
  for (const filter of ["linear", "catmull-rom"] as const) {
    for (const opaqueBackground of [true, false]) {
      frame.frameCount++;
      compositor.renderRaythreeFrame({
        frame,
        background: [10, 20, 30, opaqueBackground ? 255 : 0],
        leftEye: eye,
        rightEye: eye,
        ui: {
          panels: [panel(0, 1.8, 1.8, 0), panel(1, 0.8, 0.6, 0.12)],
          texts: [],
          images: [],
          textRendering: { renderer: "msdf", panoramaFilter: filter },
        },
      });
      for (const target of ["left", "right", "output"] as const) {
        const image = compositor.readRenderTargetRgba(target);
        if (opaqueBackground) {
          let holes = 0;
          for (let i = 3; i < image.data.length; i += 4) if (image.data[i] !== 255) holes++;
          if (holes) {
            throw new Error(
              `${filter}/${target}: ${holes} transparent pixels over opaque background`,
            );
          }
        } else if (target !== "output") {
          // Interior of the opaque backplate, including the smaller panel's edges.
          for (let y = 85; y < 171; y++) {
            for (let x = 85; x < 171; x++) {
              if (image.data[(y * size + x) * 4 + 3] !== 255) {
                throw new Error(
                  `${filter}/${target}: UI edge punched through opaque backplate at ${x},${y}`,
                );
              }
            }
          }
          if (image.data[3] !== 0) throw new Error("Transparent exterior became opaque");
        }
      }
      console.log(
        `PASS: ${filter}, ${
          opaqueBackground ? "opaque background" : "opaque backplate on transparency"
        }`,
      );
    }
  }
  completed = true;
} finally {
  try {
    compositor.cleanup();
  } catch (error) {
    if (completed) throw error;
    // The existing renderer cleanup can encounter sparse batch slots. Keep that
    // independent cleanup error from hiding a framebuffer assertion above.
    console.error("Renderer cleanup:", error);
  }
}
