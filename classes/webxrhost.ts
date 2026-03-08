import React from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { advance, createRoot } from "@react-three/fiber";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import {
  assert,
  inspectTextureForNonBlackPixels,
  type MappedTextureReadback,
  type NonBlackPixelReport,
  type OverlayUploadFormat,
  TextureReadbackRing,
} from "./webgpu.ts";
import { WebXRScene } from "./scene.tsx";
import { FpsCounter } from "./fpsCounter.ts";
import { IntervalMetric } from "./intervalMetric.ts";
import { installWebXRHostPolyfills } from "./webxrPolyfills.ts";
import { describeProjectionLayer, getProjectionLayer } from "./webxrProjectionLayer.ts";
import { WebXRSurfaceHost } from "./webxrSurfaceHost.ts";

type StartOptions = {
  width?: number;
  height?: number;
  title?: string;
  debugWindow?: boolean;
};

type WebXRStatus = {
  running: boolean;
  frameCount: number;
  xrFps: number;
  inspected: boolean;
  lastInspection: NonBlackPixelReport | null;
  error: string | null;
  lastLayerInfo: string | null;
};

const POLL_INTERVAL_MS = 16;
const XR_REFERENCE_SPACE = "local-floor";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WebXRHost {
  private running = false;
  private frameCount = 0;
  private inspected = false;
  private inspectionPending = false;
  private lastInspection: NonBlackPixelReport | null = null;
  private lastError: Error | null = null;
  private root: ReturnType<typeof createRoot> | null = null;
  private renderer: THREE.WebGPURenderer | null = null;
  private xrDevice: { installRuntime: (options: unknown) => void } | null = null;
  private session: XRSession | null = null;
  private surfaceHost: WebXRSurfaceHost | null = null;
  private device: GPUDevice | null = null;
  private overlayUploadFormat: OverlayUploadFormat = "rgba";
  private lastLayerInfo: string | null = null;
  private lastXrCallbackAt = 0;
  private lastHeartbeatAt = 0;
  private xrFrameRequestActive = false;
  private width = 1600;
  private height = 900;
  private layerReadyLogged = false;
  private debugWindowEnabled = false;
  private readbackRing: TextureReadbackRing | null = null;
  private xrFpsCounter = new FpsCounter();
  private lastFpsLogAt = 0;
  private lastPerfLogAt = 0;
  private xrAdvanceMetric = new IntervalMetric();
  private captureMetric = new IntervalMetric();
  private readySignalMetric = new IntervalMetric();
  private readbackMetric = new IntervalMetric();
  private queueAgeMetric = new IntervalMetric();
  private mapRangeMetric = new IntervalMetric();

  async start(options: StartOptions = {}) {
    if (this.running) {
      return;
    }

    this.frameCount = 0;
    this.xrFpsCounter.reset();
    this.inspected = false;
    this.inspectionPending = false;
    this.lastInspection = null;
    this.lastError = null;
    this.lastLayerInfo = null;
    this.lastXrCallbackAt = 0;
    this.lastHeartbeatAt = 0;
    this.lastFpsLogAt = 0;
    this.lastPerfLogAt = 0;
    this.layerReadyLogged = false;
    this.xrAdvanceMetric.reset();
    this.captureMetric.reset();
    this.readySignalMetric.reset();
    this.readbackMetric.reset();
    this.queueAgeMetric.reset();
    this.mapRangeMetric.reset();
    this.width = options.width ?? 1600;
    this.height = options.height ?? 900;
    this.debugWindowEnabled = options.debugWindow ?? false;
    installWebXRHostPolyfills(this.width, this.height, POLL_INTERVAL_MS);

    try {
      const adapter = await navigator.gpu.requestAdapter();
      assert(adapter, "No WebGPU adapter available");

      const device = await adapter.requestDevice();
      const preferredFormat = navigator.gpu.getPreferredCanvasFormat();
      this.device = device;
      this.readbackRing = new TextureReadbackRing(device, 3);
      this.overlayUploadFormat = preferredFormat.startsWith("bgra") ? "bgra" : "rgba";
      device.addEventListener("uncapturederror", (event: Event) => {
        const gpuEvent = event as Event & { error?: { message?: string } };
        this.lastError = new Error(
          `Uncaptured WebGPU error: ${gpuEvent.error?.message ?? "unknown"}`,
        );
      });

      this.surfaceHost = new WebXRSurfaceHost();
      this.surfaceHost.initialize(
        options.title ?? "PetPlay WebXR Host",
        this.width,
        this.height,
        this.debugWindowEnabled,
      );
      const canvas = this.surfaceHost.getCanvas();
      const context = this.surfaceHost.getContext();
      context.configure({
        device,
        format: preferredFormat,
        alphaMode: "opaque",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });

      const xrRuntimeModulePath = new URL(
        "../submodules/threewebxrwebgpudeno/submodules/xr/packages/react/xr/dist/xr.js",
        import.meta.url,
      ).href;
      const xrOriginModulePath = new URL(
        "../submodules/threewebxrwebgpudeno/submodules/xr/packages/react/xr/dist/origin.js",
        import.meta.url,
      ).href;
      const xrRuntimeModule = await import(xrRuntimeModulePath);
      const xrOriginModule = await import(xrOriginModulePath);
      const iwerModulePath = new URL(
        "../submodules/threewebxrwebgpudeno/submodules/iwer/build/iwer.module.js",
        import.meta.url,
      ).href;
      const iwerModule = await import(iwerModulePath);
      const createXRStore = xrRuntimeModule.createXRStore as (options: Record<string, unknown>) => {
        enterVR: () => Promise<XRSession>;
        getState: () => { xr: { disconnect: () => void } };
        onBeforeRender?: () => void;
        onBeforeFrame?: (scene: THREE.Scene, camera: THREE.Camera, frame?: XRFrame) => void;
      };
      const XR = xrRuntimeModule.XR as React.ComponentType<{ store: unknown; children?: React.ReactNode }>;
      const XROrigin = xrOriginModule.XROrigin as React.ComponentType;
      const XRDevice = iwerModule.XRDevice as new (
        device: unknown,
        options: Record<string, unknown>,
      ) => { installRuntime: (options: unknown) => void };
      const metaQuest3 = iwerModule.metaQuest3;

      this.xrDevice = new XRDevice(metaQuest3, {
        stereoEnabled: true,
        webgpu: {
          canvas,
          context,
          device,
          format: preferredFormat,
          present: () => this.surfaceHost?.present(),
        },
      });
      this.xrDevice.installRuntime({ globalObject: globalThis, polyfillLayers: false });
      assert(navigator.xr, "navigator.xr was not installed");

      const store = createXRStore({
        offerSession: false,
        enterGrantedSession: false,
        emulate: false,
        domOverlay: false,
        webgpu: "required",
      });

      this.root = createRoot(canvas);
      await this.root.configure({
        gl: (async (props: Record<string, unknown>) => {
          const renderer = new THREE.WebGPURenderer({
            ...props,
            canvas,
            context,
            device,
            antialias: false,
            alpha: false,
          });
          renderer.xr.enabled = true;
          renderer.xr.setReferenceSpaceType(XR_REFERENCE_SPACE);
          renderer.setSize(this.width, this.height);
          await renderer.init();
          this.renderer = renderer;
          return renderer;
        }) as never,
        size: { width: this.width, height: this.height, top: 0, left: 0 },
        dpr: 1,
        frameloop: "never",
        camera: { position: [0, 1.6, 0], fov: 75, near: 0.1, far: 100 },
      });

      const rootStore = this.root.render(
        React.createElement(
          XR,
          { store },
          React.createElement(WebXRScene, { XROrigin }),
        ),
      );
      rootStore.getState().xr.disconnect();

      await wait(0);
      advance(performance.now(), true, rootStore.getState());
      this.surfaceHost.present();

      this.session = await store.enterVR();
      assert(this.session, "Failed to enter immersive VR session");
      this.running = true;
      this.lastHeartbeatAt = performance.now();
      LogChannel.log("webxrv2", `[webxrhost] entered VR presenting=${this.renderer?.xr.isPresenting ? "yes" : "no"}`);
      this.startManualXrFrameLoop(rootStore, device);

      while (this.running) {
        if (this.lastError) {
          throw this.lastError;
        }
        const now = performance.now();
        if (now - this.lastHeartbeatAt >= 1000 && this.frameCount === 0) {
          this.lastHeartbeatAt = now;
          const sinceCallback = this.lastXrCallbackAt === 0 ? -1 : Math.round(now - this.lastXrCallbackAt);
          LogChannel.log(
            "webxrv2",
            `[webxrhost] heartbeat frameCount=${this.frameCount} presenting=${
              this.renderer?.xr.isPresenting ? "yes" : "no"
            } sinceCallbackMs=${sinceCallback} ${describeProjectionLayer(this.session, this.overlayUploadFormat)}`,
          );
        }
        await wait(POLL_INTERVAL_MS);
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      await this.stop();
      throw this.lastError;
    }
  }

  getStatus(): WebXRStatus {
    return {
      running: this.running,
      frameCount: this.frameCount,
      xrFps: this.xrFpsCounter.getFps(),
      inspected: this.inspected,
      lastInspection: this.lastInspection,
      error: this.lastError?.message ?? null,
      lastLayerInfo: this.lastLayerInfo ?? describeProjectionLayer(this.session, this.overlayUploadFormat),
    };
  }

  async stop() {
    this.running = false;

    if (this.session) {
      try {
        await this.session.end();
      } catch {
        // Ignore shutdown errors.
      }
      this.session = null;
    }

    if (this.renderer) {
      await this.renderer.setAnimationLoop(null);
      this.renderer.dispose();
      this.renderer = null;
    }

    if (this.root) {
      this.root.unmount();
      this.root = null;
    }

    this.surfaceHost?.cleanup();
    this.surfaceHost = null;

    this.device = null;
    this.readbackRing?.cleanup();
    this.readbackRing = null;
    this.xrFrameRequestActive = false;
    this.xrFpsCounter.reset();
    this.lastFpsLogAt = 0;
    this.lastPerfLogAt = 0;
    this.xrAdvanceMetric.reset();
    this.captureMetric.reset();
    this.readySignalMetric.reset();
    this.readbackMetric.reset();
    this.queueAgeMetric.reset();
    this.mapRangeMetric.reset();
    this.layerReadyLogged = false;
    this.debugWindowEnabled = false;
  }

  async captureOverlayFrame(): Promise<MappedTextureReadback | null> {
    const captureStartedAt = performance.now();
    const device = this.device;
    if (!device) {
      this.lastLayerInfo = "capture skipped: no GPU device";
      return null;
    }

    const layer = getProjectionLayer(this.session);

    if (!layer?.colorTexture || !layer.textureWidth || !layer.textureHeight) {
      this.lastLayerInfo = describeProjectionLayer(this.session, this.overlayUploadFormat);
      return null;
    }

    this.lastLayerInfo =
      `capture frame=${this.frameCount} width=${layer.textureWidth} height=${layer.textureHeight} ` +
      `format=${this.overlayUploadFormat}`;

    const readback = await this.readbackRing?.capture(
      layer.colorTexture,
      layer.textureWidth,
      layer.textureHeight,
      0,
      this.overlayUploadFormat,
    ) ?? null;
    if (readback) {
      this.readySignalMetric.record(readback.readySignalWaitMs);
      this.readbackMetric.record(readback.readbackWaitMs);
      this.queueAgeMetric.record(readback.queueAgeMs);
      this.mapRangeMetric.record(readback.mapRangeMs);
      this.captureMetric.record(performance.now() - captureStartedAt);
    }
    this.maybeLogPerf();
    return readback;
  }

  private startManualXrFrameLoop(
    rootStore: {
      getState: () => unknown;
    },
    device: GPUDevice,
  ) {
    if (!this.session || this.xrFrameRequestActive) {
      return;
    }

    this.xrFrameRequestActive = true;
    const tick = (time: number, frame: XRFrame) => {
      if (!this.running || !this.session) {
        this.xrFrameRequestActive = false;
        return;
      }

      this.lastXrCallbackAt = performance.now();
      const advanceStartedAt = this.lastXrCallbackAt;
      advance(time, true, rootStore.getState() as Parameters<typeof advance>[2], frame);
      this.frameCount++;
      this.xrFpsCounter.mark(this.lastXrCallbackAt);
      this.xrAdvanceMetric.record(performance.now() - advanceStartedAt);
      if (this.lastXrCallbackAt - this.lastFpsLogAt >= 1000) {
        this.lastFpsLogAt = this.lastXrCallbackAt;
        LogChannel.log("fps", `[webxrhost] xr=${this.xrFpsCounter.getFps().toFixed(1)}`);
      }
      this.maybeLogPerf();

      if (!this.layerReadyLogged && this.frameCount >= 1) {
        this.lastLayerInfo = describeProjectionLayer(this.session, this.overlayUploadFormat);
        this.layerReadyLogged = true;
        LogChannel.log("webxrv2", `[webxrhost] frame source ready ${this.lastLayerInfo}`);
      }

      if (!this.inspected && !this.inspectionPending && this.frameCount >= 3) {
        this.inspectionPending = true;
        void this.inspectProjectionLayer(device).finally(() => {
          this.inspectionPending = false;
        });
      }

      this.session.requestAnimationFrame(tick);
    };

    this.session.requestAnimationFrame(tick);
  }

  private async inspectProjectionLayer(device: GPUDevice) {
    const layer = getProjectionLayer(this.session);

    if (!layer?.colorTexture || !layer.textureWidth || !layer.textureHeight) {
      this.lastError = new Error("XR projection layer was not available for inspection");
      return;
    }

    const report = await inspectTextureForNonBlackPixels(
      device,
      layer.colorTexture,
      layer.textureWidth,
      layer.textureHeight,
      0,
    );

    this.lastInspection = report;
    this.inspected = true;
    LogChannel.log(
      "webxrv2",
      `[webxrhost] inspected frame nonZero=${report.nonZeroSamples}/${report.sampleCount} ` +
        `avgLuma=${report.avgLuma.toFixed(2)} max=${report.maxChannel} nonBlack=${report.isNonBlack}`,
    );
  }

  private maybeLogPerf() {
    const now = performance.now();
    if (now - this.lastPerfLogAt < 1000) {
      return;
    }

    this.lastPerfLogAt = now;
    const advanceSample = this.xrAdvanceMetric.flush();
    const readySignalSample = this.readySignalMetric.flush();
    const readbackSample = this.readbackMetric.flush();
    const queueAgeSample = this.queueAgeMetric.flush();
    const mapRangeSample = this.mapRangeMetric.flush();
    const captureSample = this.captureMetric.flush();
    if (!advanceSample && !readySignalSample && !readbackSample && !queueAgeSample && !mapRangeSample && !captureSample) {
      return;
    }

    const parts: string[] = [];
    if (advanceSample) {
      parts.push(
        `advance=${advanceSample.avgMs.toFixed(2)}ms avg ${advanceSample.maxMs.toFixed(2)}ms max`,
      );
    }
    if (readySignalSample) {
      parts.push(
        `ready=${readySignalSample.avgMs.toFixed(2)}ms avg ${readySignalSample.maxMs.toFixed(2)}ms max`,
      );
    }
    if (readbackSample) {
      parts.push(
        `readback=${readbackSample.avgMs.toFixed(2)}ms avg ${readbackSample.maxMs.toFixed(2)}ms max`,
      );
    }
    if (queueAgeSample) {
      parts.push(
        `queue=${queueAgeSample.avgMs.toFixed(2)}ms avg ${queueAgeSample.maxMs.toFixed(2)}ms max`,
      );
    }
    if (mapRangeSample) {
      parts.push(
        `mapRange=${mapRangeSample.avgMs.toFixed(2)}ms avg ${mapRangeSample.maxMs.toFixed(2)}ms max`,
      );
    }
    if (captureSample) {
      parts.push(
        `capture=${captureSample.avgMs.toFixed(2)}ms avg ${captureSample.maxMs.toFixed(2)}ms max`,
      );
    }
    LogChannel.log("perf", `[webxrhost] ${parts.join(" | ")}`);
  }
}
