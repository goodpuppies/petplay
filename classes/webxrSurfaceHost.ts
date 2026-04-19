import { createWindow, DwmWindow } from "@gfx/dwm";
import { WebXRSdlDebugWindow } from "./webxrSdlDebugWindow.ts";

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

export class WebXRSurfaceHost {
  private window: DwmWindow | null = null;
  private debugWindow: WebXRSdlDebugWindow | null = null;
  private surface: Deno.UnsafeWindowSurface | null = null;
  private context: GPUCanvasContext | null = null;
  private canvas: WebXRSurfaceCanvas | null = null;

  initialize(title: string, width: number, height: number, visible = false) {
    if (this.window) {
      return;
    }

    let surface: Deno.UnsafeWindowSurface;

    if (visible) {
      this.debugWindow = new WebXRSdlDebugWindow();
      this.debugWindow.initialize(title, width, height);
      surface = this.debugWindow.getSurface();
    } else {
      this.window = createWindow({
        title,
        width,
        height,
        visible: false,
        resizable: false,
      });
      surface = this.window.windowSurface();
      surface.resize(width, height);
    }

    const context = surface.getContext("webgpu");
    assert(context, "Failed to obtain GPUCanvasContext from UnsafeWindowSurface");

    const ownerDocument = (globalThis as unknown as { document: unknown }).document;
    this.surface = surface;
    this.context = context;
    this.canvas = {
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
  }

  getContext(): GPUCanvasContext {
    assert(this.context, "WebXR surface host not initialized");
    return this.context;
  }

  getCanvas(): WebXRSurfaceCanvas {
    assert(this.canvas, "WebXR surface host not initialized");
    return this.canvas;
  }

  present() {
    this.surface?.present();
  }

  cleanup() {
    this.context = null;
    this.canvas = null;
    this.surface = null;
    this.debugWindow?.cleanup();
    this.debugWindow = null;
    this.window?.close();
    this.window = null;
  }
}
