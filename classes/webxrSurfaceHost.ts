function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export type WebXRSurfaceCanvas = {
  width: number;
  height: number;
  style: { width: string; height: string };
  ownerDocument: unknown;
  addEventListener: () => void;
  removeEventListener: () => void;
  getBoundingClientRect: () => {
    x: number;
    y: number;
    top: number;
    left: number;
    width: number;
    height: number;
    right: number;
    bottom: number;
  };
  getContext: (type: string) => GPUCanvasContext | null;
};

type GPUCanvasConfigurationLike = {
  device: GPUDevice;
  format: GPUTextureFormat;
  usage?: GPUTextureUsageFlags;
  viewFormats?: GPUTextureFormat[];
  colorSpace?: PredefinedColorSpace;
  alphaMode?: GPUCanvasAlphaMode;
};

class OffscreenCanvasContext {
  readonly canvas: WebXRSurfaceCanvas;
  private configuration: GPUCanvasConfigurationLike | null = null;
  private texture: GPUTexture | null = null;
  private textureWidth = 0;
  private textureHeight = 0;

  constructor(canvas: WebXRSurfaceCanvas) {
    this.canvas = canvas;
  }

  configure(configuration: GPUCanvasConfigurationLike) {
    this.configuration = configuration;
    this.releaseTexture();
  }

  unconfigure() {
    this.configuration = null;
    this.releaseTexture();
  }

  getCurrentTexture(): GPUTexture {
    const configuration = this.configuration;
    assert(configuration, "Offscreen GPU canvas context was not configured");

    const width = Math.max(1, Math.floor(this.canvas.width));
    const height = Math.max(1, Math.floor(this.canvas.height));
    if (!this.texture || this.textureWidth !== width || this.textureHeight !== height) {
      this.releaseTexture();
      this.texture = configuration.device.createTexture({
        size: { width, height, depthOrArrayLayers: 1 },
        format: configuration.format,
        usage: configuration.usage ?? GPUTextureUsage.RENDER_ATTACHMENT,
        viewFormats: configuration.viewFormats,
      });
      this.textureWidth = width;
      this.textureHeight = height;
    }

    return this.texture;
  }

  private releaseTexture() {
    try {
      this.texture?.destroy();
    } catch {
    }
    this.texture = null;
    this.textureWidth = 0;
    this.textureHeight = 0;
  }
}

export class WebXRSurfaceHost {
  private context: GPUCanvasContext | null = null;
  private canvas: WebXRSurfaceCanvas | null = null;

  initialize(_title: string, width: number, height: number, _visible = false) {
    if (this.canvas) {
      return;
    }

    const ownerDocument = (globalThis as unknown as { document: unknown }).document;
    let context: GPUCanvasContext | null = null;
    const canvas: WebXRSurfaceCanvas = {
      width,
      height,
      style: { width: `${width}px`, height: `${height}px` },
      ownerDocument,
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect() {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          width,
          height,
          right: width,
          bottom: height,
        };
      },
      getContext(type: string) {
        return type === "webgpu" ? context : null;
      },
    };

    context = new OffscreenCanvasContext(canvas) as unknown as GPUCanvasContext;

    this.context = context;
    this.canvas = canvas;
  }

  getContext(): GPUCanvasContext {
    assert(this.context, "WebXR surface host not initialized");
    return this.context;
  }

  getCanvas(): WebXRSurfaceCanvas {
    assert(this.canvas, "WebXR surface host not initialized");
    return this.canvas;
  }

  present() {}

  cleanup() {
    const context = this.context as unknown as { unconfigure?: () => void } | null;
    context?.unconfigure?.();
    this.context = null;
    this.canvas = null;
  }
}
