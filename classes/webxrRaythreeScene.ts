import { RaythreeExtractor } from "../submodules/raythree/src/extract.ts";
import type { ExtractionResult } from "../submodules/raythree/src/ir.ts";
import type { WebXRShadowFrame } from "./webxrhost.ts";
import { extractWebXRRaythreeUi, type WebXRRaythreeUiSnapshot } from "./webxrRaythreeUi.ts";

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
  ): WebXRRaythreeRenderPayload {
    return {
      frame,
      background: options?.includeBackground === true
        ? getSceneBackgroundColor(context.scene)
        : [0, 0, 0, 0],
      leftEye: this.extractor.extract(
        context.scene as never,
        context.leftCamera as never,
      ),
      rightEye: this.extractor.extract(
        context.scene as never,
        context.rightCamera as never,
      ),
      ui: extractWebXRRaythreeUi(context.scene as never),
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
