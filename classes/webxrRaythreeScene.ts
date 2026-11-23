/**
 * Bridge from the live R3F / WebGPU `THREE.Scene` to the data consumed by
 * `WebXROverlayRaylib` in the webxr hot loop.
 *
 * - **Raythree** (`RaythreeExtractor` here): CPU walk of the scene graph in
 *   this process. It must run wherever the Three.js `Object3D` tree lives
 *   (the webxr worker); it cannot be moved by sending “the scene” because
 *   `Object3D` is not `structuredClone`able.
 * - **Raylib** consumes the payload either in the legacy webxr pump or in the
 *   independent render/present child, which supplies its own current eye cameras.
 */
import * as THREE from "three";
import { anchoredLowerers } from "./overlayRenderTracking.ts";
import type { SceneDelivery } from "./overlaySceneDelivery.ts";
import { type ExtractionResult, RaythreeExtractor } from "../submodules/raythree/src/lib.ts";
import type { WebXRShadowFrame } from "./webxrhost.ts";
import type { IntervalMetric } from "./intervalMetric.ts";
import type { VrcCameraViewPose } from "./vrcCameraCalibration.ts";
import type { VrcDepthDebugFrame } from "./vrchatDepth/debugView.ts";
import {
  createWebXRRaythreeUiCollector,
  extractWebXRRaythreeUiFromCollected,
  type WebXRRaythreeUiSnapshot,
} from "./webxrRaythreeUi.ts";

/** Optional per-section timings for `buildPayload` (Raylib overlay profiling). */
export type WebXRRaythreeBuildProbes = {
  sceneMatrix: IntervalMetric;
  leftEye: IntervalMetric;
  rightEye: IntervalMetric;
  ui: IntervalMetric;
};

export type WebXRRaythreeRenderPayload = {
  /** Small world-to-tracking fit for desktop depth foreground; no mesh payload. */
  vrcDepthAlignment?: import("./vrchatDepth/sync.ts").WorldToTracking | null;
  delivery?: SceneDelivery;
  /** Only for `camera: "vrc"` views: the calibrated VRChat camera, or null when uncalibrated. */
  vrcCamera?: VrcCameraViewPose | null;
  /** Status text the VRC camera layer prints over VRChat's image (VRChat depth sync). */
  vrcDebugLines?: string[];
  /** Only sent to the interactive depth debug window. */
  vrcDepthDebug?: VrcDepthDebugFrame | null;
  renderGripOffsets?: Partial<Record<"left" | "right", Float32Array>>;
  frame: WebXRShadowFrame;
  background: [number, number, number, number];
  leftEye: ExtractionResult;
  rightEye: ExtractionResult;
  ui: WebXRRaythreeUiSnapshot;
};

export type WebXRRaythreeSceneContext = {
  renderGripOffsets?: Partial<Record<"left" | "right", Float32Array>>;
  scene: object;
  leftCamera: object;
  rightCamera: object;
};

export class WebXRRaythreeSceneBridge {
  private readonly extractor = new RaythreeExtractor({ lowerers: anchoredLowerers() });

  buildPayload(
    context: WebXRRaythreeSceneContext,
    frame: WebXRShadowFrame,
    options?: {
      includeBackground?: boolean;
    },
    probes?: WebXRRaythreeBuildProbes | null,
  ): WebXRRaythreeRenderPayload {
    const scene = context.scene as THREE.Scene;
    // One dirty-propagated world update for this frame (avoid force=true recomputing every
    // static node's matrix every frame).
    const t0 = performance.now();
    scene.updateMatrixWorld(false);
    probes?.sceneMatrix.record(performance.now() - t0);
    const uiCollector = createWebXRRaythreeUiCollector();
    const eyeOpts = {
      skipSceneMatrixWorldUpdate: true,
      onVisitObject: uiCollector.visit,
    } as const;

    const t1 = performance.now();
    const leftEye = this.extractor.extract(
      scene,
      context.leftCamera as THREE.Camera,
      eyeOpts,
    );
    probes?.leftEye.record(performance.now() - t1);

    const t2 = performance.now();
    // Raythree's scene payload is eye-invariant: extraction does no frustum or
    // layer filtering, and the renderer receives the real per-eye projection
    // and view matrices separately. Reuse the same instances/lights/assets for
    // the right eye instead of walking and lowering the whole scene twice.
    const rightEye = leftEye;
    probes?.rightEye.record(performance.now() - t2);

    const t3 = performance.now();
    const ui = extractWebXRRaythreeUiFromCollected(uiCollector.collected);
    probes?.ui.record(performance.now() - t3);

    return {
      renderGripOffsets: context.renderGripOffsets,
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

/** Calibration helpers belong in the headset view, never on the recording camera's lens. */
export function withoutVrcCameraHelpers(extraction: ExtractionResult): ExtractionResult {
  return {
    ...extraction,
    frame: {
      ...extraction.frame,
      instances: extraction.frame.instances.filter((instance) =>
        !(instance as { vrcCameraHidden?: boolean }).vrcCameraHidden
      ),
    },
  };
}

export function getSceneBackgroundColor(
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
