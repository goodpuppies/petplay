import type { OverlayUploadFormat } from "./webgpu.ts";

export type CaptureLayer = {
  colorTexture?: GPUTexture;
  textureWidth?: number;
  textureHeight?: number;
  source: string;
};

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

export function getProjectionLayer(session: XRSessionLike | null): CaptureLayer | null {
  const sessionAny = session;
  if (!sessionAny) {
    return null;
  }

  const renderStateLayer = (sessionAny.renderState?.layers?.[0] ?? null) as {
    colorTexture?: GPUTexture;
    textureWidth?: number;
    textureHeight?: number;
  } | null;
  if (renderStateLayer?.colorTexture) {
    return {
      colorTexture: renderStateLayer.colorTexture,
      textureWidth: renderStateLayer.textureWidth,
      textureHeight: renderStateLayer.textureHeight,
      source: "renderState.layers[0]",
    };
  }

  const internalState = findInternalSessionState(sessionAny);
  const internalLayer = (internalState?.renderState?.layers?.[0] ?? null) as {
    colorTexture?: GPUTexture;
    textureWidth?: number;
    textureHeight?: number;
  } | null;
  if (internalLayer?.colorTexture) {
    return {
      colorTexture: internalLayer.colorTexture,
      textureWidth: internalLayer.textureWidth,
      textureHeight: internalLayer.textureHeight,
      source: "session[symbol].renderState.layers[0]",
    };
  }

  const baseLayerCandidate = (typeof sessionAny.getBaseLayer === "function"
    ? sessionAny.getBaseLayer()
    : sessionAny.renderState?.baseLayer ?? internalState?.renderState?.baseLayer ?? null) as {
      colorTexture?: GPUTexture;
      colorTextures?: GPUTexture[];
      textureWidth?: number;
      textureHeight?: number;
      framebufferWidth?: number;
      framebufferHeight?: number;
    } | null;

  if (baseLayerCandidate?.colorTexture) {
    return {
      colorTexture: baseLayerCandidate.colorTexture,
      textureWidth: baseLayerCandidate.textureWidth ?? baseLayerCandidate.framebufferWidth,
      textureHeight: baseLayerCandidate.textureHeight ?? baseLayerCandidate.framebufferHeight,
      source: "baseLayer.colorTexture",
    };
  }

  if (baseLayerCandidate?.colorTextures?.[0]) {
    return {
      colorTexture: baseLayerCandidate.colorTextures[0],
      textureWidth: baseLayerCandidate.textureWidth ?? baseLayerCandidate.framebufferWidth,
      textureHeight: baseLayerCandidate.textureHeight ?? baseLayerCandidate.framebufferHeight,
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
      `format=${overlayUploadFormat}`,
    ].join(" ");
  }

  const renderStateLayersLength = sessionAny?.renderState?.layers?.length ?? 0;
  const internalRenderStateLayersLength = internalState?.renderState?.layers?.length ?? 0;
  const baseLayerCandidate = (typeof sessionAny?.getBaseLayer === "function"
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
