import React from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { advance, createRoot } from "@react-three/fiber";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import {
  assert,
  inspectTextureForNonBlackPixels,
  type NonBlackPixelReport,
  type OverlayUploadFormat,
  type StereoMappedTextureReadback,
  TextureReadbackRing,
} from "./webgpu.ts";
import { WebXRScene } from "./scene.tsx";
import { FpsCounter } from "./fpsCounter.ts";
import { IntervalMetric } from "./intervalMetric.ts";
import { installWebXRHostPolyfills } from "./webxrPolyfills.ts";
import { describeProjectionLayer, getProjectionLayer } from "./webxrProjectionLayer.ts";
import { WebXRSurfaceHost } from "./webxrSurfaceHost.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";

type StartOptions = {
  width?: number;
  height?: number;
  title?: string;
  debugWindow?: boolean;
  vrSystemPointer?: number | bigint | null;
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
const XR_CONNECT_RETRY_MS = 16;
const XR_CONNECT_TIMEOUT_MS = 1000;
const XR_CONNECT_ERROR_FRAGMENT = "not connected to three.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isXrConnectionRace(error: unknown): boolean {
  return error instanceof Error && error.message.includes(XR_CONNECT_ERROR_FRAGMENT);
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
  private xrDevice: {
    installRuntime: (options: unknown) => void;
    position?: { set?: (x: number, y: number, z: number) => void };
    quaternion?: { set?: (x: number, y: number, z: number, w: number) => void };
  } | null = null;
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
  private vrSystemPointer: number | bigint | null = null;
  private layerReadyLogged = false;
  private debugWindowEnabled = false;
  private outputLeftReadbackRing: TextureReadbackRing | null = null;
  private outputRightReadbackRing: TextureReadbackRing | null = null;
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
    this.vrSystemPointer = options.vrSystemPointer ?? null;
    installWebXRHostPolyfills(this.width, this.height, POLL_INTERVAL_MS);

    try {
      const adapter = await navigator.gpu.requestAdapter();
      assert(adapter, "No WebGPU adapter available");

      const device = await adapter.requestDevice();
      const preferredFormat = navigator.gpu.getPreferredCanvasFormat();
      this.device = device;
      this.outputLeftReadbackRing = new TextureReadbackRing(device, 3);
      this.outputRightReadbackRing = new TextureReadbackRing(device, 3);
      this.overlayUploadFormat = preferredFormat.startsWith("bgra") ? "bgra" : "rgba";
      device.addEventListener("uncapturederror", (event: Event) => {
        const gpuEvent = event as Event & {
          error?: { message?: string; constructor?: { name?: string } };
        };
        const errorName = gpuEvent.error?.constructor?.name ?? "GPUError";
        this.lastError = new Error(
          `Uncaptured WebGPU error (${errorName}): ${gpuEvent.error?.message ?? "unknown"}`,
        );
      });

      this.surfaceHost = new WebXRSurfaceHost();
      this.surfaceHost.initialize(
        options.title ?? "PetPlay WebXR Host",
        this.width,
        this.height,
        this.debugWindowEnabled,
      );
      LogChannel.log(
        "webxrv2",
        `[webxrhost] surface=${this.width}x${this.height} debugWindow=${
          this.debugWindowEnabled ? "yes" : "no"
        }`,
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
      const createXRStore = xrRuntimeModule.createXRStore as (
        options: Record<string, unknown>,
      ) => {
        enterVR: () => Promise<XRSession>;
        getState: () => { xr: { disconnect: () => void } };
        onBeforeRender?: () => void;
        onBeforeFrame?: (
          scene: THREE.Scene,
          camera: THREE.Camera,
          frame?: XRFrame,
        ) => void;
      };
      const XR = xrRuntimeModule.XR as React.ComponentType<
        { store: unknown; children?: React.ReactNode }
      >;
      const XROrigin = xrOriginModule.XROrigin as React.ComponentType;
      const XRDevice = iwerModule.XRDevice as new (
        device: unknown,
        options: Record<string, unknown>,
      ) => { installRuntime: (options: unknown) => void };
      const metaQuest3 = iwerModule.metaQuest3;

      this.xrDevice = new XRDevice(metaQuest3, {
        stereoEnabled: true,
        fovy: 1.9,
        //ipd: 0.068,
        webgpu: {
          canvas,
          context,
          device,
          format: preferredFormat,
          present: () => this.surfaceHost?.present(),
        },
      });
      this.xrDevice.installRuntime({
        globalObject: globalThis,
        polyfillLayers: false,
      });
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
        //camera: { position: [0, 0, 0], fov: 75, near: 0.1, far: 100 },
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

      this.session = await this.enterVrWhenReady(store);
      assert(this.session, "Failed to enter immersive VR session");
      this.running = true;
      this.lastHeartbeatAt = performance.now();
      LogChannel.log(
        "webxrv2",
        `[webxrhost] entered VR presenting=${this.renderer?.xr.isPresenting ? "yes" : "no"}`,
      );
      this.startManualXrFrameLoop(rootStore, device);

      while (this.running) {
        if (this.lastError) {
          throw this.lastError;
        }
        const now = performance.now();
        if (now - this.lastHeartbeatAt >= 1000 && this.frameCount === 0) {
          this.lastHeartbeatAt = now;
          const sinceCallback = this.lastXrCallbackAt === 0
            ? -1
            : Math.round(now - this.lastXrCallbackAt);
          LogChannel.log(
            "webxrv2",
            `[webxrhost] heartbeat frameCount=${this.frameCount} presenting=${
              this.renderer?.xr.isPresenting ? "yes" : "no"
            } sinceCallbackMs=${sinceCallback} ${
              describeProjectionLayer(this.session, this.overlayUploadFormat)
            }`,
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
      lastLayerInfo: this.lastLayerInfo ??
        describeProjectionLayer(this.session, this.overlayUploadFormat),
    };
  }

  getDevice(): GPUDevice | null {
    return this.device;
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
    this.outputLeftReadbackRing?.cleanup();
    this.outputLeftReadbackRing = null;
    this.outputRightReadbackRing?.cleanup();
    this.outputRightReadbackRing = null;
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
    this.vrSystemPointer = null;
  }

  async captureOverlayFrame(): Promise<StereoMappedTextureReadback | null> {
    return await this.captureProjectionLayerFrame(
      "output",
      this.outputLeftReadbackRing,
      this.outputRightReadbackRing,
    );
  }

  private async captureProjectionLayerFrame(
    label: string,
    leftReadbackRing: TextureReadbackRing | null,
    rightReadbackRing: TextureReadbackRing | null,
  ): Promise<StereoMappedTextureReadback | null> {
    const captureStartedAt = performance.now();
    const device = this.device;
    if (!device) {
      this.lastLayerInfo = `${label} capture skipped: no GPU device`;
      return null;
    }

    const layer = getProjectionLayer(this.session, "color");

    const captureFormat = layer?.format ?? this.overlayUploadFormat;
    if (!layer?.colorTexture || !layer.textureWidth || !layer.textureHeight) {
      this.lastLayerInfo = `${label} ` +
        describeProjectionLayer(this.session, this.overlayUploadFormat);
      return null;
    }

    this.lastLayerInfo =
      `${label} frame=${this.frameCount} eyeWidth=${layer.textureWidth} eyeHeight=${layer.textureHeight} ` +
      `format=${captureFormat} layers=2`;

    const leftReadback = await leftReadbackRing?.capture(
      layer.colorTexture,
      layer.textureWidth,
      layer.textureHeight,
      0,
      captureFormat,
    ) ?? null;
    const rightReadback = await rightReadbackRing?.capture(
      layer.colorTexture,
      layer.textureWidth,
      layer.textureHeight,
      1,
      captureFormat,
    ) ?? null;

    if (!leftReadback || !rightReadback) {
      leftReadback?.destroy();
      rightReadback?.destroy();
      this.maybeLogPerf();
      return null;
    }

    this.readySignalMetric.record(
      Math.max(leftReadback.readySignalWaitMs, rightReadback.readySignalWaitMs),
    );
    this.readbackMetric.record(
      Math.max(leftReadback.readbackWaitMs, rightReadback.readbackWaitMs),
    );
    this.queueAgeMetric.record(Math.max(leftReadback.queueAgeMs, rightReadback.queueAgeMs));
    this.mapRangeMetric.record(Math.max(leftReadback.mapRangeMs, rightReadback.mapRangeMs));
    this.captureMetric.record(performance.now() - captureStartedAt);
    this.maybeLogPerf();
    const release = () => {
      leftReadback.destroy();
      rightReadback.destroy();
    };

    return {
      left: leftReadback,
      right: rightReadback,
      lookRotation: this.getOverlayLookRotationMatrix(),
      halfFovInRadians: (112 / 2) * (Math.PI / 180),
      outputWidth: layer.textureWidth * 2,
      outputHeight: layer.textureWidth * 2,
      unmap: release,
      destroy: release,
    };
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
      this.updateEmulatedHeadsetFromOpenVr();
      advance(
        time,
        true,
        rootStore.getState() as Parameters<typeof advance>[2],
        frame,
      );
      this.frameCount++;
      this.xrFpsCounter.mark(this.lastXrCallbackAt);
      this.xrAdvanceMetric.record(performance.now() - advanceStartedAt);
      if (this.lastXrCallbackAt - this.lastFpsLogAt >= 1000) {
        this.lastFpsLogAt = this.lastXrCallbackAt;
        LogChannel.log(
          "fps",
          `[webxrhost] xr=${this.xrFpsCounter.getFps().toFixed(1)}`,
        );
      }
      this.maybeLogPerf();

      if (!this.layerReadyLogged && this.frameCount >= 1) {
        this.lastLayerInfo = describeProjectionLayer(
          this.session,
          this.overlayUploadFormat,
        );
        this.layerReadyLogged = true;
        LogChannel.log(
          "webxrv2",
          `[webxrhost] frame source ready ${this.lastLayerInfo}`,
        );
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
    const layer = getProjectionLayer(this.session, "color");

    if (!layer?.colorTexture || !layer.textureWidth || !layer.textureHeight) {
      this.lastError = new Error(
        "XR projection layer was not available for inspection",
      );
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
        `avgLuma=${
          report.avgLuma.toFixed(2)
        } max=${report.maxChannel} nonBlack=${report.isNonBlack}`,
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
    if (
      !advanceSample && !readySignalSample && !readbackSample &&
      !queueAgeSample &&
      !mapRangeSample && !captureSample
    ) {
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
        `ready=${readySignalSample.avgMs.toFixed(2)}ms avg ${
          readySignalSample.maxMs.toFixed(2)
        }ms max`,
      );
    }
    if (readbackSample) {
      parts.push(
        `readback=${readbackSample.avgMs.toFixed(2)}ms avg ${
          readbackSample.maxMs.toFixed(2)
        }ms max`,
      );
    }
    if (queueAgeSample) {
      parts.push(
        `queue=${queueAgeSample.avgMs.toFixed(2)}ms avg ${queueAgeSample.maxMs.toFixed(2)}ms max`,
      );
    }
    if (mapRangeSample) {
      parts.push(
        `mapRange=${mapRangeSample.avgMs.toFixed(2)}ms avg ${
          mapRangeSample.maxMs.toFixed(2)
        }ms max`,
      );
    }
    if (captureSample) {
      parts.push(
        `capture=${captureSample.avgMs.toFixed(2)}ms avg ${captureSample.maxMs.toFixed(2)}ms max`,
      );
    }
    LogChannel.log("perf", `[webxrhost] ${parts.join(" | ")}`);
  }

  private async enterVrWhenReady(store: { enterVR: () => Promise<XRSession> }) {
    const deadline = performance.now() + XR_CONNECT_TIMEOUT_MS;
    let attempts = 0;
    let lastError: Error | null = null;

    while (performance.now() < deadline) {
      try {
        return await store.enterVR();
      } catch (error) {
        if (!isXrConnectionRace(error)) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        attempts++;
        await wait(XR_CONNECT_RETRY_MS);
      }
    }

    if (attempts > 0) {
      LogChannel.log(
        "webxrv2",
        `[webxrhost] XR connection retry timed out after ${attempts} attempts`,
      );
    }
    throw lastError ?? new Error("Timed out waiting for XR store to connect");
  }

  private updateEmulatedHeadsetFromOpenVr() {
    if (!this.xrDevice || !this.vrSystemPointer) {
      return;
    }

    const systemPointer = Deno.UnsafePointer.create(
      typeof this.vrSystemPointer === "bigint"
        ? this.vrSystemPointer
        : BigInt(this.vrSystemPointer),
    );
    if (!systemPointer) {
      return;
    }

    const vrSystem = new OpenVR.IVRSystem(systemPointer);
    const poseArrayBuffer = new ArrayBuffer(
      OpenVR.TrackedDevicePoseStruct.byteSize * OpenVR.k_unMaxTrackedDeviceCount,
    );
    const posePtr = Deno.UnsafePointer.of(poseArrayBuffer) as Deno.PointerValue<
      OpenVR.TrackedDevicePose
    >;
    vrSystem.GetDeviceToAbsoluteTrackingPose(
      OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding,
      0.0,
      posePtr,
      OpenVR.k_unMaxTrackedDeviceCount,
    );
    const poseView = new DataView(
      poseArrayBuffer,
      OpenVR.k_unTrackedDeviceIndex_Hmd * OpenVR.TrackedDevicePoseStruct.byteSize,
      OpenVR.TrackedDevicePoseStruct.byteSize,
    );
    const hmdPose = OpenVR.TrackedDevicePoseStruct.read(poseView) as OpenVR.TrackedDevicePose;
    if (!hmdPose.bPoseIsValid) {
      return;
    }

    const m = hmdPose.mDeviceToAbsoluteTracking.m;
    const quaternion = this.matrix3x4ToQuaternion(m);
    this.xrDevice.position?.set?.(m[0][3], m[1][3], m[2][3]);
    this.xrDevice.quaternion?.set?.(
      quaternion[0],
      quaternion[1],
      quaternion[2],
      quaternion[3],
    );
  }

  private matrix3x4ToQuaternion(
    matrix: [
      [number, number, number, number],
      [number, number, number, number],
      [number, number, number, number],
    ],
  ): [number, number, number, number] {
    const m00 = matrix[0][0];
    const m01 = matrix[0][1];
    const m02 = matrix[0][2];
    const m10 = matrix[1][0];
    const m11 = matrix[1][1];
    const m12 = matrix[1][2];
    const m20 = matrix[2][0];
    const m21 = matrix[2][1];
    const m22 = matrix[2][2];
    const trace = m00 + m11 + m22;

    if (trace > 0) {
      const s = Math.sqrt(trace + 1.0) * 2;
      return [
        (m21 - m12) / s,
        (m02 - m20) / s,
        (m10 - m01) / s,
        0.25 * s,
      ];
    }
    if (m00 > m11 && m00 > m22) {
      const s = Math.sqrt(1.0 + m00 - m11 - m22) * 2;
      return [
        0.25 * s,
        (m01 + m10) / s,
        (m02 + m20) / s,
        (m21 - m12) / s,
      ];
    }
    if (m11 > m22) {
      const s = Math.sqrt(1.0 + m11 - m00 - m22) * 2;
      return [
        (m01 + m10) / s,
        0.25 * s,
        (m12 + m21) / s,
        (m02 - m20) / s,
      ];
    }
    const s = Math.sqrt(1.0 + m22 - m00 - m11) * 2;
    return [
      (m02 + m20) / s,
      (m12 + m21) / s,
      0.25 * s,
      (m10 - m01) / s,
    ];
  }

  private getOverlayLookRotationMatrix(): Float32Array {
    const quaternion = (this.xrDevice as {
      quaternion?: {
        quat?: ArrayLike<number>;
        x?: number;
        y?: number;
        z?: number;
        w?: number;
      };
    } | null)?.quaternion;

    const quatValues = quaternion?.quat
      ? [
        Number(quaternion.quat[0] ?? 0),
        Number(quaternion.quat[1] ?? 0),
        Number(quaternion.quat[2] ?? 0),
        Number(quaternion.quat[3] ?? 1),
      ] as const
      : quaternion
      ? [
        Number(quaternion.x ?? 0),
        Number(quaternion.y ?? 0),
        Number(quaternion.z ?? 0),
        Number(quaternion.w ?? 1),
      ] as const
      : null;

    const inverseRotation = new Float32Array(16);
    inverseRotation[15] = 1;

    if (quatValues) {
      const x = -quatValues[0];
      const y = -quatValues[1];
      const z = -quatValues[2];
      const w = quatValues[3];
      const x2 = x + x;
      const y2 = y + y;
      const z2 = z + z;
      const xx = x * x2;
      const xy = x * y2;
      const xz = x * z2;
      const yy = y * y2;
      const yz = y * z2;
      const zz = z * z2;
      const wx = w * x2;
      const wy = w * y2;
      const wz = w * z2;

      inverseRotation[0] = 1 - (yy + zz);
      inverseRotation[1] = xy + wz;
      inverseRotation[2] = xz - wy;
      inverseRotation[4] = xy - wz;
      inverseRotation[5] = 1 - (xx + zz);
      inverseRotation[6] = yz + wx;
      inverseRotation[8] = xz + wy;
      inverseRotation[9] = yz - wx;
      inverseRotation[10] = 1 - (xx + yy);
    } else {
      inverseRotation[0] = 1;
      inverseRotation[5] = 1;
      inverseRotation[10] = 1;
    }

    inverseRotation[8] *= -1;
    inverseRotation[9] *= -1;
    inverseRotation[10] *= -1;
    return inverseRotation;
  }
}
