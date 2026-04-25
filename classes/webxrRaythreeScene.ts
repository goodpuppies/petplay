/**
 * Bridge from the live R3F / WebGPU `THREE.Scene` to the data consumed by
 * `WebXROverlayRaylib` in the **webxrOverlay** worker.
 *
 * - **Raythree** (`RaythreeExtractor` here): CPU walk of the scene graph in
 *   this process. It must run wherever the Three.js `Object3D` tree lives
 *   (the webxr worker); it cannot be moved to another worker by sending
 *   “the scene” — `Object3D` is not `structuredClone`able.
 * - **Raylib** (`WebXROverlayRaylib.renderExtraction`): runs in `webxrOverlay`
 *   from `ExtractionResult` + pose matrices (already serialized in the
 *   `PostMessage` payload). That part is already off the webxr hot path.
 */
import * as THREE from "three";
import { RaythreeExtractor, type ExtractionResult } from "../submodules/raythree/src/lib.ts";
import type { WebXRShadowFrame } from "./webxrhost.ts";
import type { IntervalMetric } from "./intervalMetric.ts";
import { extractWebXRRaythreeUi, type WebXRRaythreeUiSnapshot } from "./webxrRaythreeUi.ts";

/** Optional per-section timings for `buildPayload` (Raylib overlay profiling). */
export type WebXRRaythreeBuildProbes = {
  sceneMatrix: IntervalMetric;
  leftEye: IntervalMetric;
  rightEye: IntervalMetric;
  ui: IntervalMetric;
};

export type WebXRRaythreeRenderPayload = {
  frame: WebXRShadowFrame;
  background: [number, number, number, number];
  leftEye: ExtractionResult;
  rightEye: ExtractionResult;
  ui: WebXRRaythreeUiSnapshot;
};

export type WebXRRaythreeSceneContext = {
  scene: object;
  leftCamera: object;
  rightCamera: object;
};

export class WebXRRaythreeSceneBridge {
  private readonly extractor = new RaythreeExtractor();

  buildPayload(
    context: WebXRRaythreeSceneContext,
    frame: WebXRShadowFrame,
    options?: {
      includeBackground?: boolean;
    },
    probes?: WebXRRaythreeBuildProbes | null,
  ): WebXRRaythreeRenderPayload {
    const scene = context.scene as THREE.Scene;
    // One world update for this frame, then two eye extracts (raythree’s extract()
    // would otherwise call scene.updateMatrixWorld(true) twice per payload).
    const t0 = performance.now();
    scene.updateMatrixWorld(true);
    probes?.sceneMatrix.record(performance.now() - t0);
    const eyeOpts = { skipSceneMatrixWorldUpdate: true } as const;

    const t1 = performance.now();
    const leftEye = this.extractor.extract(
      scene,
      context.leftCamera as THREE.Camera,
      eyeOpts,
    );
    probes?.leftEye.record(performance.now() - t1);

    const t2 = performance.now();
    const rightEye = this.extractor.extract(
      scene,
      context.rightCamera as THREE.Camera,
      eyeOpts,
    );
    probes?.rightEye.record(performance.now() - t2);

    const t3 = performance.now();
    const ui = extractWebXRRaythreeUi(scene);
    probes?.ui.record(performance.now() - t3);

    return {
      frame,
      background: options?.includeBackground === true
        ? getSceneBackgroundColor(context.scene)
        : [0, 0, 0, 0],
      leftEye,
      rightEye,
      ui,
    };
  }
}

function getSceneBackgroundColor(
  scene: object,
): [number, number, number, number] {
  const background =
    (scene as { background?: { isColor?: boolean; r?: number; g?: number; b?: number } })
      .background;
  if (background?.isColor) {
    return [
      Math.round((background.r ?? 0) * 255),
      Math.round((background.g ?? 0) * 255),
      Math.round((background.b ?? 0) * 255),
      255,
    ];
  }
  return [0, 0, 0, 0];
}
