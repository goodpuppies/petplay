import type { OverlayUploadFormat } from "./webgpu.ts";

export type CaptureLayer = {
  colorTexture?: GPUTexture;
  textureWidth?: number;
  textureHeight?: number;
  colorFormat?: string;
  format?: OverlayUploadFormat;
  source: string;
};

export type ProjectionLayerCapturePreference =
  | "processed"
  | "color"
  | "auto";

type XRSessionLike = {
  renderState?: { layers?: unknown[]; baseLayer?: unknown };
  getBaseLayer?: () => unknown;
};

type SessionStateLike = {
  renderState?: {
    layers?: unknown[];
    baseLayer?: unknown;
  };
};

function findInternalSessionState(session: XRSessionLike): SessionStateLike | null {
  for (const symbol of Object.getOwnPropertySymbols(session)) {
    const value = (session as Record<symbol, unknown>)[symbol];
    if (value && typeof value === "object" && "renderState" in (value as object)) {
      return value as SessionStateLike;
    }
  }

  return null;
}

function makeCaptureLayer(
  layer:
    | {
        colorTexture?: GPUTexture;
        processedColorTexture?: GPUTexture;
        textureWidth?: number;
        textureHeight?: number;
        processedTextureWidth?: number;
        processedTextureHeight?: number;
        colorFormat?: string;
      }
    | null,
  sourcePrefix: string,
  preference: ProjectionLayerCapturePreference,
): CaptureLayer | null {
  if (!layer) {
    return null;
  }

  if ((preference === "processed" || preference === "auto") && layer.processedColorTexture) {
    return {
      colorTexture: layer.processedColorTexture,
      textureWidth: layer.processedTextureWidth ?? layer.textureWidth,
      textureHeight: layer.processedTextureHeight ?? layer.textureHeight,
      colorFormat: "rgba8unorm",
      format: "rgba",
      source: `${sourcePrefix}.processedColorTexture`,
    };
  }

  if (layer.colorTexture) {
    const colorFormat = layer.colorFormat;
    return {
      colorTexture: layer.colorTexture,
      textureWidth: layer.textureWidth,
      textureHeight: layer.textureHeight,
      colorFormat,
      format: colorFormat
        ? (colorFormat.toLowerCase().startsWith("bgra") ? "bgra" : "rgba")
        : undefined,
      source: sourcePrefix,
    };
  }

  return null;
}

export function getProjectionLayer(
  session: XRSessionLike | null,
  preference: ProjectionLayerCapturePreference = "auto",
): CaptureLayer | null {
  const sessionAny = session;
  if (!sessionAny) {
    return null;
  }

  const renderStateLayer = (sessionAny.renderState?.layers?.[0] ?? null) as {
    colorTexture?: GPUTexture;
    processedColorTexture?: GPUTexture;
    textureWidth?: number;
    textureHeight?: number;
    processedTextureWidth?: number;
    processedTextureHeight?: number;
    colorFormat?: string;
  } | null;
  const renderStateCapture = makeCaptureLayer(
    renderStateLayer,
    "renderState.layers[0]",
    preference,
  );
  if (renderStateCapture) {
    return renderStateCapture;
  }

  const internalState = findInternalSessionState(sessionAny);
  const internalLayer = (internalState?.renderState?.layers?.[0] ?? null) as {
    colorTexture?: GPUTexture;
    processedColorTexture?: GPUTexture;
    textureWidth?: number;
    textureHeight?: number;
    processedTextureWidth?: number;
    processedTextureHeight?: number;
    colorFormat?: string;
  } | null;
  const internalCapture = makeCaptureLayer(
    internalLayer,
    "session[symbol].renderState.layers[0]",
    preference,
  );
  if (internalCapture) {
    return internalCapture;
  }

  const baseLayerCandidate =
    (typeof sessionAny.getBaseLayer === "function"
      ? sessionAny.getBaseLayer()
      : sessionAny.renderState?.baseLayer ?? internalState?.renderState?.baseLayer ?? null) as {
        colorTexture?: GPUTexture;
        colorTextures?: GPUTexture[];
        textureWidth?: number;
        textureHeight?: number;
        framebufferWidth?: number;
        framebufferHeight?: number;
        colorFormat?: string;
      } | null;

  if (baseLayerCandidate?.colorTexture) {
    return {
      colorTexture: baseLayerCandidate.colorTexture,
      textureWidth: baseLayerCandidate.textureWidth ?? baseLayerCandidate.framebufferWidth,
      textureHeight: baseLayerCandidate.textureHeight ?? baseLayerCandidate.framebufferHeight,
      colorFormat: baseLayerCandidate.colorFormat,
      format: baseLayerCandidate.colorFormat
        ? (baseLayerCandidate.colorFormat.toLowerCase().startsWith("bgra") ? "bgra" : "rgba")
        : undefined,
      source: "baseLayer.colorTexture",
    };
  }

  if (baseLayerCandidate?.colorTextures?.[0]) {
    return {
      colorTexture: baseLayerCandidate.colorTextures[0],
      textureWidth: baseLayerCandidate.textureWidth ?? baseLayerCandidate.framebufferWidth,
      textureHeight: baseLayerCandidate.textureHeight ?? baseLayerCandidate.framebufferHeight,
      colorFormat: baseLayerCandidate.colorFormat,
      format: baseLayerCandidate.colorFormat
        ? (baseLayerCandidate.colorFormat.toLowerCase().startsWith("bgra") ? "bgra" : "rgba")
        : undefined,
      source: "baseLayer.colorTextures[0]",
    };
  }

  return null;
}

export function describeProjectionLayer(
  session: XRSessionLike | null,
  overlayUploadFormat: OverlayUploadFormat,
): string {
  const sessionAny = session;
  const layer = getProjectionLayer(session);
  const internalState = session ? findInternalSessionState(session) : null;
  if (!session) {
    return "session=missing";
  }
  if (layer) {
    return [
      "session=present",
      `source=${layer.source}`,
      `layerTexture=${layer.colorTexture ? "yes" : "no"}`,
      `width=${layer.textureWidth ?? 0}`,
      `height=${layer.textureHeight ?? 0}`,
      `format=${layer.format ?? overlayUploadFormat}`,
    ].join(" ");
  }

  const renderStateLayersLength = sessionAny?.renderState?.layers?.length ?? 0;
  const internalRenderStateLayersLength = internalState?.renderState?.layers?.length ?? 0;
  const baseLayerCandidate =
    (typeof sessionAny?.getBaseLayer === "function"
      ? sessionAny.getBaseLayer()
      : sessionAny?.renderState?.baseLayer ?? internalState?.renderState?.baseLayer ?? null) as {
        colorTexture?: GPUTexture;
        colorTextures?: GPUTexture[];
        framebufferWidth?: number;
        framebufferHeight?: number;
      } | null;

  return [
    "session=present",
    `renderStateLayers=${renderStateLayersLength}`,
    `internalLayers=${internalRenderStateLayersLength}`,
    `baseLayer=${baseLayerCandidate ? "yes" : "no"}`,
    `baseColorTexture=${baseLayerCandidate?.colorTexture ? "yes" : "no"}`,
    `baseColorTextures=${baseLayerCandidate?.colorTextures?.length ?? 0}`,
    `baseWidth=${baseLayerCandidate?.framebufferWidth ?? 0}`,
    `baseHeight=${baseLayerCandidate?.framebufferHeight ?? 0}`,
    `format=${overlayUploadFormat}`,
  ].join(" ");
}
