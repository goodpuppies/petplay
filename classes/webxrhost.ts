import React from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import "./browserStoragePolyfill.ts";
import { advance, createRoot } from "@react-three/fiber/webgpu";
import { currentXRFrame } from "./xrFrameBridge.ts";
import { createXRStore, XR, XROrigin } from "@pmndrs/xr";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import {
  assert,
  inspectTextureForNonBlackPixels,
  type MappedTextureReadback,
  type NonBlackPixelReport,
  type OverlayUploadFormat,
  type StereoMappedTextureReadback,
  StereoTextureReadbackRing,
  TextureReadbackRing,
} from "./webgpu.ts";
import { NativeControllerHud } from "./environment/nativeFrontend.tsx";
import { WebXRScene } from "./environment/scene.tsx";
import { FpsCounter } from "./fpsCounter.ts";
import { IntervalMetric } from "./intervalMetric.ts";
import { tempFile } from "./utils.ts";
import { installWebXRHostPolyfills, type WebXrHostPolyfillOptions } from "./webxrPolyfills.ts";
import {
  tryCreateOpenVrOverlayFramePacer,
  type OpenVrOverlayFramePacer,
} from "./openVrOverlayFramePacing.ts";
import { describeProjectionLayer, getProjectionLayer } from "./webxrProjectionLayer.ts";
import { WebXRSurfaceHost } from "./webxrSurfaceHost.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";

type StartOptions = {
  width?: number;
  height?: number;
  title?: string;
  debugWindow?: boolean;
  vrSystemPointer?: number | bigint | null;
  vrInputPointer?: number | bigint | null;
  sessionMode?: "immersive-vr" | "immersive-ar";
  alpha?: boolean;
  wristMenuActor?: string | null;
  /** PetPlay `displayInstance` actor id — syncs 16:9 display ↔ OpenVR desktop overlay. */
  displayInstanceActor?: string | null;
  /**
   * When the OpenVR ghost uses only the Raylib path (`overlayRenderMode: "raylib"`), the WebGPU
   * projection layer does not need a full scene draw — Raythree reads the Three graph and
   * Raylib composites elsewhere. This skips `WebGPURenderer` GPU submission while still running
   * the XR camera rig (same as the start of a normal `render` call) so `useFrame` + matrices
   * stay in sync. Set `overlayRenderMode` to `both` or `webgpu` (or `debugWindow: true`) when you
   * need a real WebGPU XR framebuffer for comparison.
   */
  skipWebGpuXrDraw?: boolean;
  /** `IVRSystem` HMD `Prop_DisplayFrequency_Float` (Hz) from the hmd actor — for FPS log context only. */
  nominalHmdDisplayHz?: number | null;
  /**
   * `IVRCompositor` (OpenVR). Used with `vrSystemPointer` for overlay-legal frame pacing
   * (`GetTimeSinceLastVsync` + `CanRenderScene`); omit to skip the compositor gate.
   */
  vrCompositorPointer?: number | bigint | null;
  /**
   * When `true` (default), drive IWER’s global rAF with OpenVR display timing
   * (`openVrOverlayFramePacing`) instead of a fixed setTimeout. Set `false` to A/B test
   * the old synthetic rAF only.
   */
  useOpenVrOverlayFramePacing?: boolean;
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

export type WebXRShadowFrame = {
  frameCount: number;
  eyeWidth: number;
  eyeHeight: number;
  outputWidth: number;
  outputHeight: number;
  lookRotation: Float32Array;
  viewerPosition: Float32Array;
  viewerQuaternion: Float32Array;
  leftEyePosition: Float32Array;
  leftEyeQuaternion: Float32Array;
  leftEyeViewMatrix: Float32Array;
  leftEyeProjectionMatrix: Float32Array;
  rightEyePosition: Float32Array;
  rightEyeQuaternion: Float32Array;
  rightEyeViewMatrix: Float32Array;
  rightEyeProjectionMatrix: Float32Array;
  halfFovInRadians: number;
  ipdMeters: number;
};

const POLL_INTERVAL_MS = 16;
const XR_CONNECT_RETRY_MS = 16;
const XR_CONNECT_TIMEOUT_MS = 1000;
const XR_CONNECT_ERROR_FRAGMENT = "not connected to three.js";
const CONTROLLER_ROTATION_OFFSET = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(-0.7, 0, 0, "XYZ"),
);

type SupportedSessionMode = "immersive-vr" | "immersive-ar";

function getReferenceSpaceType(sessionMode: SupportedSessionMode): XRReferenceSpaceType {
  return sessionMode === "immersive-ar" ? "local" : "local-floor";
}

type CaptureMode = "serial" | "parallel";

function getCaptureMode(): CaptureMode {
  const configured = Deno.args
    .find((arg) => arg.startsWith("--webxr-capture="))
    ?.split("=", 2)[1]
    ?.trim()
    .toLowerCase();
  switch (configured) {
    case "parallel":
      return "parallel";
    case "serial":
    case undefined:
    case "":
      return "serial";
    default:
      LogChannel.log(
        "webxrv2",
        `[webxrhost] unknown --webxr-capture=${configured}, defaulting to serial`,
      );
      return "serial";
  }
}

type ReadbackMode = "split" | "stereo";

function getReadbackMode(): ReadbackMode {
  const configured = Deno.args
    .find((arg) => arg.startsWith("--webxr-readback="))
    ?.split("=", 2)[1]
    ?.trim()
    .toLowerCase();
  switch (configured) {
    case "split":
      return "split";
    case "stereo":
    case undefined:
    case "":
      return "stereo";
    default:
      LogChannel.log(
        "webxrv2",
        `[webxrhost] unknown --webxr-readback=${configured}, defaulting to stereo`,
      );
      return "stereo";
  }
}

type QueueDebugMode = "off" | "sync";

function getQueueDebugMode(): QueueDebugMode {
  const configured = Deno.args
    .find((arg) => arg.startsWith("--webxr-queue-debug="))
    ?.split("=", 2)[1]
    ?.trim()
    .toLowerCase();
  switch (configured) {
    case "sync":
      return "sync";
    case "off":
    case undefined:
    case "":
      return "off";
    default:
      LogChannel.log(
        "webxrv2",
        `[webxrhost] unknown --webxr-queue-debug=${configured}, defaulting to off`,
      );
      return "off";
  }
}

const DEFAULT_READBACK_RING_SIZE = 3;

function getReadbackRingSize(): number {
  const configured = Deno.args
    .find((arg) => arg.startsWith("--webxr-ring-size="))
    ?.split("=", 2)[1]
    ?.trim();
  if (!configured) {
    return DEFAULT_READBACK_RING_SIZE;
  }
  const parsed = Number.parseInt(configured, 10);
  if (!Number.isFinite(parsed) || parsed < 2 || parsed > 8) {
    LogChannel.log(
      "webxrv2",
      `[webxrhost] invalid --webxr-ring-size=${configured}, defaulting to ${DEFAULT_READBACK_RING_SIZE}`,
    );
    return DEFAULT_READBACK_RING_SIZE;
  }
  return parsed;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isXrConnectionRace(error: unknown): boolean {
  return error instanceof Error && error.message.includes(XR_CONNECT_ERROR_FRAGMENT);
}

type XrControllerBridge = {
  position?: { set?: (x: number, y: number, z: number) => void };
  quaternion?: { set?: (x: number, y: number, z: number, w: number) => void };
  connected?: boolean;
  updateButtonValue?: (id: string, value: number) => void;
};

type XrDeviceBridge = {
  installRuntime: (options: unknown) => void;
  position?: { set?: (x: number, y: number, z: number) => void };
  quaternion?: { set?: (x: number, y: number, z: number, w: number) => void };
  controllers?: {
    left?: XrControllerBridge;
    right?: XrControllerBridge;
  };
};

type OpenVrPoseActionData = ReturnType<typeof OpenVR.InputPoseActionDataStruct.read>;
type OpenVrDigitalActionData = ReturnType<typeof OpenVR.InputDigitalActionDataStruct.read>;
type ExternalControllerData = [
  OpenVrPoseActionData,
  OpenVrPoseActionData,
  OpenVrDigitalActionData,
  OpenVrDigitalActionData,
  OpenVrDigitalActionData,
  OpenVrDigitalActionData,
];

function createStructBuffer<T>(byteSize: number): {
  pointer: Deno.PointerValue<T>;
  view: DataView<ArrayBuffer>;
} {
  const buffer = new ArrayBuffer(byteSize);
  return {
    pointer: Deno.UnsafePointer.of(buffer) as Deno.PointerValue<T>,
    view: new DataView(buffer),
  };
}

export class WebXRHost {
  private running = false;
  private frameCount = 0;
  private inspected = false;
  private inspectionPending = false;
  private lastInspection: NonBlackPixelReport | null = null;
  private lastError: Error | null = null;
  private root: ReturnType<typeof createRoot> | null = null;
  private rootStore: { getState: () => unknown } | null = null;
  private renderer: THREE.WebGPURenderer | null = null;
  private xrDevice: XrDeviceBridge | null = null;
  private session: XRSession | null = null;
  private surfaceHost: WebXRSurfaceHost | null = null;
  private device: GPUDevice | null = null;
  private overlayUploadFormat: OverlayUploadFormat = "rgba";
  private lastLayerInfo: string | null = null;
  private latestControllerData: ExternalControllerData | null = null;
  private lastXrCallbackAt = 0;
  private lastHeartbeatAt = 0;
  private xrFrameRequestActive = false;
  private width = 1600;
  private height = 900;
  private vrSystemPointer: number | bigint | null = null;
  private vrInputPointer: number | bigint | null = null;
  private vrInput: OpenVR.IVRInput | null = null;
  private actionManifestPath: string | null = null;
  private openVrInputInitialized = false;
  private openVrControllerBridgeDisabled = false;
  private openVrControllerBridgeError: string | null = null;
  private actionSetHandle: OpenVR.ActionSetHandle = OpenVR.k_ulInvalidActionSetHandle;
  private handPoseLeftHandle: OpenVR.ActionHandle = OpenVR.k_ulInvalidActionHandle;
  private handPoseRightHandle: OpenVR.ActionHandle = OpenVR.k_ulInvalidActionHandle;
  private triggerLeftHandle: OpenVR.ActionHandle = OpenVR.k_ulInvalidActionHandle;
  private triggerRightHandle: OpenVR.ActionHandle = OpenVR.k_ulInvalidActionHandle;
  private grabLeftHandle: OpenVR.ActionHandle = OpenVR.k_ulInvalidActionHandle;
  private grabRightHandle: OpenVR.ActionHandle = OpenVR.k_ulInvalidActionHandle;
  private readonly handPoseLeftHandlePtr = P.BigUint64P<OpenVR.ActionHandle>();
  private readonly handPoseRightHandlePtr = P.BigUint64P<OpenVR.ActionHandle>();
  private readonly triggerLeftHandlePtr = P.BigUint64P<OpenVR.ActionHandle>();
  private readonly triggerRightHandlePtr = P.BigUint64P<OpenVR.ActionHandle>();
  private readonly grabLeftHandlePtr = P.BigUint64P<OpenVR.ActionHandle>();
  private readonly grabRightHandlePtr = P.BigUint64P<OpenVR.ActionHandle>();
  private readonly actionSetHandlePtr = P.BigUint64P<OpenVR.ActionSetHandle>();
  private readonly leftPoseState = createStructBuffer<OpenVR.InputPoseActionData>(
    OpenVR.InputPoseActionDataStruct.byteSize,
  );
  private readonly rightPoseState = createStructBuffer<OpenVR.InputPoseActionData>(
    OpenVR.InputPoseActionDataStruct.byteSize,
  );
  private readonly leftTriggerState = createStructBuffer<OpenVR.InputDigitalActionData>(
    OpenVR.InputDigitalActionDataStruct.byteSize,
  );
  private readonly rightTriggerState = createStructBuffer<OpenVR.InputDigitalActionData>(
    OpenVR.InputDigitalActionDataStruct.byteSize,
  );
  private readonly leftGrabState = createStructBuffer<OpenVR.InputDigitalActionData>(
    OpenVR.InputDigitalActionDataStruct.byteSize,
  );
  private readonly rightGrabState = createStructBuffer<OpenVR.InputDigitalActionData>(
    OpenVR.InputDigitalActionDataStruct.byteSize,
  );
  private sessionMode: SupportedSessionMode = "immersive-vr";
  private alphaEnabled = false;
  private layerReadyLogged = false;
  private debugWindowEnabled = false;
  private outputLeftReadbackRing: TextureReadbackRing | null = null;
  private outputRightReadbackRing: TextureReadbackRing | null = null;
  private outputStereoReadbackRing: StereoTextureReadbackRing | null = null;
  private xrFpsCounter = new FpsCounter();
  private lastFpsLogAt = 0;
  private lastPerfLogAt = 0;
  /** Time between `session.requestAnimationFrame` invocations (wall clock; reflects compositor rate). */
  private lastXrSessionRafWallAt = 0;
  private xrSessionRafWallIntervalMetric = new IntervalMetric();
  /** Wall time for the full XR rAF tick (after this, `requestAnimationFrame` is scheduled). */
  private xrAdvanceMetric = new IntervalMetric();
  /** `updateEmulatedHeadsetFromOpenVr` */
  private xrHmdEmulationMetric = new IntervalMetric();
  /** `applyExternalControllerData` */
  private xrControllerApplyMetric = new IntervalMetric();
  /** R3F `advance(time)` only (useFrame + internal render path). */
  private xrR3fAdvanceMetric = new IntervalMetric();
  /** `captureShadowPoseFromRenderer` */
  private xrShadowPoseMetric = new IntervalMetric();
  private captureMetric = new IntervalMetric();
  private readySignalMetric = new IntervalMetric();
  private readbackMetric = new IntervalMetric();
  private queueAgeMetric = new IntervalMetric();
  private gpuReadyMetric = new IntervalMetric();
  private shelfMetric = new IntervalMetric();
  private mapRangeMetric = new IntervalMetric();
  private readonly captureMode: CaptureMode = getCaptureMode();
  private readonly readbackMode: ReadbackMode = getReadbackMode();
  private readonly queueDebugMode: QueueDebugMode = getQueueDebugMode();
  private readonly ringSize: number = getReadbackRingSize();
  private skipWebGpuXrDraw = false;
  private originalWebGpuRendererRender: THREE.WebGPURenderer["render"] | null = null;
  private nominalHmdDisplayHz: number | null = null;
  private openVrOverlayPacer: OpenVrOverlayFramePacer | null = null;
  private vrCompositorPointer: number | bigint | null = null;
  private latestShadowPose: {
    viewerPosition: Float32Array;
    viewerQuaternion: Float32Array;
    leftEyePosition: Float32Array;
    leftEyeQuaternion: Float32Array;
    leftEyeViewMatrix: Float32Array;
    leftEyeProjectionMatrix: Float32Array;
    rightEyePosition: Float32Array;
    rightEyeQuaternion: Float32Array;
    rightEyeViewMatrix: Float32Array;
    rightEyeProjectionMatrix: Float32Array;
    halfFovInRadians: number;
    ipdMeters: number;
  } | null = null;

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
    this.lastXrSessionRafWallAt = 0;
    this.lastHeartbeatAt = 0;
    this.lastFpsLogAt = 0;
    this.lastPerfLogAt = 0;
    this.layerReadyLogged = false;
    this.xrSessionRafWallIntervalMetric.reset();
    this.xrAdvanceMetric.reset();
    this.xrHmdEmulationMetric.reset();
    this.xrControllerApplyMetric.reset();
    this.xrR3fAdvanceMetric.reset();
    this.xrShadowPoseMetric.reset();
    this.captureMetric.reset();
    this.readySignalMetric.reset();
    this.readbackMetric.reset();
    this.queueAgeMetric.reset();
    this.gpuReadyMetric.reset();
    this.shelfMetric.reset();
    this.mapRangeMetric.reset();
    this.width = options.width ?? 1600;
    this.height = options.height ?? 900;
    this.debugWindowEnabled = options.debugWindow ?? false;
    this.skipWebGpuXrDraw = Boolean(options.skipWebGpuXrDraw) && !this.debugWindowEnabled;
    this.nominalHmdDisplayHz = options.nominalHmdDisplayHz ?? null;
    this.vrSystemPointer = options.vrSystemPointer ?? null;
    this.vrCompositorPointer = options.vrCompositorPointer ?? null;
    this.vrInputPointer = options.vrInputPointer ?? null;
    this.sessionMode = options.sessionMode === "immersive-ar" ? "immersive-ar" : "immersive-vr";
    this.alphaEnabled = options.alpha ?? this.sessionMode === "immersive-ar";
    const useOverlayPacing = options.useOpenVrOverlayFramePacing !== false;
    this.openVrOverlayPacer = tryCreateOpenVrOverlayFramePacer(
      this.vrSystemPointer,
      this.vrCompositorPointer,
      useOverlayPacing,
    );
    const hostHeartbeatPollMs = 16;
    const nom = this.nominalHmdDisplayHz;
    const rafPolyfillIntervalMs = nom != null && Number.isFinite(nom) && nom > 0 && nom < 1000
      ? 1000 / nom
      : 16;
    const polyfill: WebXrHostPolyfillOptions = {
      pollIntervalMs: rafPolyfillIntervalMs,
      openVrVsyncDrivesRaf: this.openVrOverlayPacer != null,
    };
    installWebXRHostPolyfills(this.width, this.height, polyfill);
    LogChannel.log(
      "webxrv2",
      `[webxrhost] rAF ` +
        (this.openVrOverlayPacer != null
          ? "OpenVR display pacing (Aardvark-style GetTimeSinceLastVsync; IWER rAF delay=0)"
          : `polyfill=${rafPolyfillIntervalMs.toFixed(3)}ms (~${(1000 / rafPolyfillIntervalMs).toFixed(1)}Hz)`) +
        `; IWER XRSession uses global rAF`,
    );

    try {
      const adapter = await navigator.gpu.requestAdapter();
      assert(adapter, "No WebGPU adapter available");

      const device = await adapter.requestDevice();
      const preferredFormat = navigator.gpu.getPreferredCanvasFormat();
      this.device = device;
      if (this.readbackMode === "stereo") {
        this.outputStereoReadbackRing = new StereoTextureReadbackRing(device, this.ringSize);
      } else {
        this.outputLeftReadbackRing = new TextureReadbackRing(device, this.ringSize);
        this.outputRightReadbackRing = new TextureReadbackRing(device, this.ringSize);
      }
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
        } session=${this.sessionMode} alpha=${this.alphaEnabled ? "yes" : "no"} capture=${
          this.captureMode
        } readback=${this.readbackMode} ringSize=${this.ringSize} queueDebug=${this.queueDebugMode}`,
      );
      const canvas = this.surfaceHost.getCanvas();
      const context = this.surfaceHost.getContext();

      const iwerModulePath = new URL(
        "../submodules/threewebxrwebgpudeno/submodules/iwer/build/iwer.module.js",
        import.meta.url,
      ).href;
      const iwerModule = await import(iwerModulePath);
      const XRDevice = iwerModule.XRDevice as new (
        device: unknown,
        options: Record<string, unknown>,
      ) => XrDeviceBridge;
      const metaQuest3 = iwerModule.metaQuest3;

      this.xrDevice = new XRDevice(metaQuest3, {
        stereoEnabled: true,
        fovy: 1.9,
        //ipd: 0.068,
        webgpu: {
          canvas,
          device,
          format: preferredFormat,
          width: this.width,
          height: this.height,
          ...(this.debugWindowEnabled
            ? {
              context,
              present: () => this.surfaceHost?.present(),
            }
            : {}),
        },
      });
      this.xrDevice.installRuntime({
        globalObject: globalThis,
        polyfillLayers: false,
      });
      assert((navigator as unknown as { xr?: XRSystem }).xr, "navigator.xr was not installed");

      const store = createXRStore({
        offerSession: false,
        enterGrantedSession: false,
        emulate: false,
        domOverlay: false,
        webgpu: "required",
        bounded: this.sessionMode === "immersive-ar" ? false : undefined,
        controller: {
          right: () =>
            React.createElement(NativeControllerHud, {
              actorId: options.wristMenuActor ?? null,
            }),
          left: { rayPointer: { minDistance: -1 }, model: false },
        },
      });

      this.root = createRoot(canvas);
      await this.root.configure({
        renderer: (async (props: Record<string, unknown>) => {
          const rendererOptions: Record<string, unknown> = {
            ...props,
            canvas,
            device,
            antialias: false,
            alpha: this.alphaEnabled,
            premultipliedAlpha: false,
          };
          if (context) {
            rendererOptions.context = context;
          }
          const renderer = new THREE.WebGPURenderer(rendererOptions);
          renderer.xr.enabled = true;
          renderer.xr.setReferenceSpaceType(getReferenceSpaceType(this.sessionMode));
          renderer.setSize(this.width, this.height);
          await renderer.init();
          this.renderer = renderer;
          if (this.skipWebGpuXrDraw) {
            this.patchRendererToXrPoseOnly();
          }
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
          React.createElement(WebXRScene, {
          XROrigin,
          displayInstanceActor: options.displayInstanceActor ?? null,
        }),
        ),
      );
      this.rootStore = rootStore;
      rootStore.getState().xr.disconnect();

      await wait(0);
      advance(performance.now());
      if (this.debugWindowEnabled) {
        this.surfaceHost.present();
      }

      this.session = await this.enterXrWhenReady(
        store as unknown as { enterAR: () => Promise<XRSession>; enterVR: () => Promise<XRSession> },
        this.sessionMode,
      );
      assert(this.session, `Failed to enter ${this.sessionMode} session`);
      this.running = true;
      this.lastHeartbeatAt = performance.now();
      if (this.skipWebGpuXrDraw) {
        this.inspected = true;
      }
      LogChannel.log(
        "webxrv2",
        `[webxrhost] entered ${this.sessionMode} presenting=${
          this.renderer?.xr.isPresenting ? "yes" : "no"
        } alpha=${this.alphaEnabled ? "yes" : "no"}${
          this.skipWebGpuXrDraw
            ? " webgpuSceneDraw=no (raylib-only; use overlay \"both\"/\"webgpu\" to draw the projection layer)"
            : ""
        }`,
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
        await wait(hostHeartbeatPollMs);
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

  setControllerData(data: ExternalControllerData | null) {
    this.latestControllerData = data;
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
      if (this.originalWebGpuRendererRender) {
        this.renderer.render = this.originalWebGpuRendererRender;
        this.originalWebGpuRendererRender = null;
      }
      this.skipWebGpuXrDraw = false;
      this.renderer.dispose();
      this.renderer = null;
    }

    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
    this.rootStore = null;

    this.surfaceHost?.cleanup();
    this.surfaceHost = null;

    this.device = null;
    this.outputLeftReadbackRing?.cleanup();
    this.outputLeftReadbackRing = null;
    this.outputRightReadbackRing?.cleanup();
    this.outputRightReadbackRing = null;
    this.outputStereoReadbackRing?.cleanup();
    this.outputStereoReadbackRing = null;
    this.xrFrameRequestActive = false;
    this.xrFpsCounter.reset();
    this.lastFpsLogAt = 0;
    this.lastPerfLogAt = 0;
    this.lastXrSessionRafWallAt = 0;
    this.xrSessionRafWallIntervalMetric.reset();
    this.xrAdvanceMetric.reset();
    this.xrHmdEmulationMetric.reset();
    this.xrControllerApplyMetric.reset();
    this.xrR3fAdvanceMetric.reset();
    this.xrShadowPoseMetric.reset();
    this.captureMetric.reset();
    this.readySignalMetric.reset();
    this.readbackMetric.reset();
    this.queueAgeMetric.reset();
    this.gpuReadyMetric.reset();
    this.shelfMetric.reset();
    this.mapRangeMetric.reset();
    this.layerReadyLogged = false;
    this.debugWindowEnabled = false;
    this.latestShadowPose = null;
    this.vrSystemPointer = null;
    this.vrInputPointer = null;
    this.vrInput = null;
    this.actionManifestPath = null;
    this.openVrInputInitialized = false;
    this.openVrControllerBridgeDisabled = false;
    this.openVrControllerBridgeError = null;
    this.actionSetHandle = OpenVR.k_ulInvalidActionSetHandle;
    this.handPoseLeftHandle = OpenVR.k_ulInvalidActionHandle;
    this.handPoseRightHandle = OpenVR.k_ulInvalidActionHandle;
    this.triggerLeftHandle = OpenVR.k_ulInvalidActionHandle;
    this.triggerRightHandle = OpenVR.k_ulInvalidActionHandle;
    this.grabLeftHandle = OpenVR.k_ulInvalidActionHandle;
    this.grabRightHandle = OpenVR.k_ulInvalidActionHandle;
    this.xrDevice = null;
    this.sessionMode = "immersive-vr";
    this.alphaEnabled = false;
    this.nominalHmdDisplayHz = null;
    this.vrCompositorPointer = null;
    this.openVrOverlayPacer = null;
  }

  async captureOverlayFrame(): Promise<StereoMappedTextureReadback | null> {
    if (this.readbackMode === "stereo") {
      return await this.captureStereoProjectionLayerFrame(
        "output",
        this.outputStereoReadbackRing,
      );
    }
    return await this.captureProjectionLayerFrame(
      "output",
      this.outputLeftReadbackRing,
      this.outputRightReadbackRing,
    );
  }

  captureShadowFrame(): WebXRShadowFrame | null {
    if (!this.running || this.frameCount <= 0) {
      return null;
    }

    const pose = this.latestShadowPose;
    if (!pose) {
      return null;
    }

    const eyeWidth = Math.max(1, Math.round(this.width / 2));
    const eyeHeight = Math.max(1, Math.round(this.height));
    this.lastLayerInfo =
      `shadow frame=${this.frameCount} eyeWidth=${eyeWidth} eyeHeight=${eyeHeight} ` +
      `output=${eyeWidth * 2}x${eyeWidth * 2}`;

    return {
      frameCount: this.frameCount,
      eyeWidth,
      eyeHeight,
      outputWidth: eyeWidth * 2,
      outputHeight: eyeWidth * 2,
      lookRotation: this.getOverlayLookRotationMatrix(),
      viewerPosition: new Float32Array(pose.viewerPosition),
      viewerQuaternion: new Float32Array(pose.viewerQuaternion),
      leftEyePosition: new Float32Array(pose.leftEyePosition),
      leftEyeQuaternion: new Float32Array(pose.leftEyeQuaternion),
      leftEyeViewMatrix: new Float32Array(pose.leftEyeViewMatrix),
      leftEyeProjectionMatrix: new Float32Array(pose.leftEyeProjectionMatrix),
      rightEyePosition: new Float32Array(pose.rightEyePosition),
      rightEyeQuaternion: new Float32Array(pose.rightEyeQuaternion),
      rightEyeViewMatrix: new Float32Array(pose.rightEyeViewMatrix),
      rightEyeProjectionMatrix: new Float32Array(pose.rightEyeProjectionMatrix),
      halfFovInRadians: pose.halfFovInRadians,
      ipdMeters: pose.ipdMeters,
    };
  }

  getRaythreeSceneContext(): {
    scene: THREE.Scene;
    leftCamera: THREE.Camera;
    rightCamera: THREE.Camera;
  } | null {
    const state = this.rootStore?.getState() as { scene?: THREE.Scene } | undefined;
    const scene = state?.scene ?? null;
    const xrCamera = this.renderer?.xr?.getCamera?.() as
      | (THREE.Camera & { cameras?: THREE.Camera[] })
      | null
      | undefined;
    const leftCamera = xrCamera?.cameras?.[0] ?? null;
    const rightCamera = xrCamera?.cameras?.[1] ?? null;
    if (!scene || !leftCamera || !rightCamera) {
      return null;
    }
    return {
      scene,
      leftCamera,
      rightCamera,
    };
  }

  private async captureStereoProjectionLayerFrame(
    label: string,
    stereoReadbackRing: StereoTextureReadbackRing | null,
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
      `format=${captureFormat} colorFormat=${layer.colorFormat ?? "unknown"} layers=2`;

    const stereoReadback = await (stereoReadbackRing?.capture(
      layer.colorTexture,
      layer.textureWidth,
      layer.textureHeight,
      captureFormat,
      this.queueDebugMode === "sync",
    ) ?? Promise.resolve(null));

    if (!stereoReadback) {
      this.maybeLogPerf();
      return null;
    }

    this.readySignalMetric.record(stereoReadback.left.readySignalWaitMs);
    this.readbackMetric.record(stereoReadback.left.readbackWaitMs);
    this.queueAgeMetric.record(stereoReadback.left.queueAgeMs);
    this.gpuReadyMetric.record(stereoReadback.left.gpuReadyMs);
    this.shelfMetric.record(stereoReadback.left.shelfMs);
    this.mapRangeMetric.record(stereoReadback.left.mapRangeMs);
    this.captureMetric.record(performance.now() - captureStartedAt);
    this.maybeLogPerf();

    return {
      left: stereoReadback.left,
      right: stereoReadback.right,
      lookRotation: this.getOverlayLookRotationMatrix(),
      halfFovInRadians: this.latestShadowPose?.halfFovInRadians ?? ((112 / 2) * (Math.PI / 180)),
      outputWidth: layer.textureWidth * 2,
      outputHeight: layer.textureWidth * 2,
      unmap: stereoReadback.unmap,
      destroy: stereoReadback.destroy,
    };
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
      `format=${captureFormat} colorFormat=${layer.colorFormat ?? "unknown"} layers=2`;

    let leftReadback: MappedTextureReadback | null;
    let rightReadback: MappedTextureReadback | null;
    if (this.captureMode === "parallel") {
      // Fire both submits back-to-back, then wait for both in parallel.
      const leftCapturePromise = leftReadbackRing?.capture(
        layer.colorTexture,
        layer.textureWidth,
        layer.textureHeight,
        0,
        captureFormat,
      ) ?? Promise.resolve(null);
      const rightCapturePromise = rightReadbackRing?.capture(
        layer.colorTexture,
        layer.textureWidth,
        layer.textureHeight,
        1,
        captureFormat,
      ) ?? Promise.resolve(null);
      [leftReadback, rightReadback] = await Promise.all([
        leftCapturePromise,
        rightCapturePromise,
      ]);
    } else {
      leftReadback = await (leftReadbackRing?.capture(
        layer.colorTexture,
        layer.textureWidth,
        layer.textureHeight,
        0,
        captureFormat,
      ) ?? Promise.resolve(null));
      rightReadback = await (rightReadbackRing?.capture(
        layer.colorTexture,
        layer.textureWidth,
        layer.textureHeight,
        1,
        captureFormat,
      ) ?? Promise.resolve(null));
    }

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
    this.gpuReadyMetric.record(Math.max(leftReadback.gpuReadyMs, rightReadback.gpuReadyMs));
    this.shelfMetric.record(Math.max(leftReadback.shelfMs, rightReadback.shelfMs));
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
      halfFovInRadians: this.latestShadowPose?.halfFovInRadians ?? ((112 / 2) * (Math.PI / 180)),
      outputWidth: layer.textureWidth * 2,
      outputHeight: layer.textureWidth * 2,
      unmap: release,
      destroy: release,
    };
  }

  /**
   * Swap `WebGPURenderer.render` for a CPU-only path that runs the world-matrix
   * update and `XRManager.updateCamera` (the same preamble as
   * `WebGPURenderer._renderScene` before any GPU work). Use when the OpenVR
   * ghost is Raylib-only; turn off via `StartOptions.skipWebGpuXrDraw` or use
   * overlay "both" / "webgpu" to get a real projection layer again.
   */
  private patchRendererToXrPoseOnly() {
    const r = this.renderer;
    if (!r) {
      return;
    }
    this.originalWebGpuRendererRender = r.render.bind(r);
    r.render = (scene, camera) => {
      this.applyWebGpuXrPoseOnly(scene, camera);
    };
  }

  private applyWebGpuXrPoseOnly(scene: THREE.Object3D, camera: THREE.Camera) {
    const renderer = this.renderer;
    if (!renderer) {
      return;
    }
    if (!renderer.initialized) {
      return;
    }
    if ((renderer as unknown as { _isDeviceLost?: boolean })._isDeviceLost) {
      return;
    }
    const xr = renderer.xr;
    if (scene.matrixWorldAutoUpdate === true) {
      scene.updateMatrixWorld();
    }
    if (camera.parent === null && camera.matrixWorldAutoUpdate === true) {
      camera.updateMatrixWorld();
    }
    if (xr.enabled && xr.isPresenting) {
      if (xr.cameraAutoUpdate) {
        xr.updateCamera(camera as THREE.PerspectiveCamera);
      }
    }
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

      this.openVrOverlayPacer?.paceToDisplayAndRefreshPoses();
      const wallNow = performance.now();
      if (this.lastXrSessionRafWallAt > 0) {
        this.xrSessionRafWallIntervalMetric.record(
          wallNow - this.lastXrSessionRafWallAt,
        );
      }
      this.lastXrSessionRafWallAt = wallNow;
      this.lastXrCallbackAt = wallNow;
      const advanceStartedAt = wallNow;
      const t0 = performance.now();
      this.updateEmulatedHeadsetFromOpenVr();
      this.xrHmdEmulationMetric.record(performance.now() - t0);
      const t1 = performance.now();
      this.applyExternalControllerData();
      this.xrControllerApplyMetric.record(performance.now() - t1);
      // R3F v10's scheduler-based advance() doesn't forward the XRFrame to
      // useFrame callbacks; stash it on the bridge so our useFrame shim can
      // inject it as the third arg downstream.
      currentXRFrame.value = frame;
      const t2 = performance.now();
      try {
        advance(time);
      } finally {
        currentXRFrame.value = undefined;
      }
      this.xrR3fAdvanceMetric.record(performance.now() - t2);
      const t3 = performance.now();
      this.captureShadowPoseFromRenderer();
      this.xrShadowPoseMetric.record(performance.now() - t3);
      this.frameCount++;
      this.xrFpsCounter.mark(this.lastXrCallbackAt);
      this.xrAdvanceMetric.record(performance.now() - advanceStartedAt);
      if (this.lastXrCallbackAt - this.lastFpsLogAt >= 1000) {
        this.lastFpsLogAt = this.lastXrCallbackAt;
        {
          const measured = this.xrFpsCounter.getFps();
          const nom = this.nominalHmdDisplayHz;
          const tail = nom != null && Number.isFinite(nom)
            ? ` measured vs OpenVR ${nom.toFixed(0)} Hz nominal`
            : "";
          LogChannel.log("fps", `[webxrhost] xr=${measured.toFixed(1)}${tail}`);
        }
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
    const rafWallSample = this.xrSessionRafWallIntervalMetric.flush();
    const advanceSample = this.xrAdvanceMetric.flush();
    const hmdSample = this.xrHmdEmulationMetric.flush();
    const controllerSample = this.xrControllerApplyMetric.flush();
    const r3fSample = this.xrR3fAdvanceMetric.flush();
    const poseSample = this.xrShadowPoseMetric.flush();
    const readySignalSample = this.readySignalMetric.flush();
    const readbackSample = this.readbackMetric.flush();
    const queueAgeSample = this.queueAgeMetric.flush();
    const gpuReadySample = this.gpuReadyMetric.flush();
    const shelfSample = this.shelfMetric.flush();
    const mapRangeSample = this.mapRangeMetric.flush();
    const captureSample = this.captureMetric.flush();
    if (
      !rafWallSample && !advanceSample && !hmdSample && !controllerSample && !r3fSample && !poseSample &&
      !readySignalSample && !readbackSample &&
      !queueAgeSample && !gpuReadySample && !shelfSample &&
      !mapRangeSample && !captureSample
    ) {
      return;
    }

    const parts: string[] = [];
    if (rafWallSample) {
      const implied = 1000 / rafWallSample.avgMs;
      parts.push(
        `session-raf=${rafWallSample.avgMs.toFixed(2)}ms avg ` +
          `${rafWallSample.maxMs.toFixed(2)}ms max (~${implied.toFixed(0)}Hz)`,
      );
    }
    if (advanceSample) {
      parts.push(
        `advance=${advanceSample.avgMs.toFixed(2)}ms avg ${advanceSample.maxMs.toFixed(2)}ms max`,
      );
    }
    if (hmdSample) {
      parts.push(
        `hmd=${hmdSample.avgMs.toFixed(2)}ms avg ${hmdSample.maxMs.toFixed(2)}ms max`,
      );
    }
    if (controllerSample) {
      parts.push(
        `ctrl=${controllerSample.avgMs.toFixed(2)}ms avg ${controllerSample.maxMs.toFixed(2)}ms max`,
      );
    }
    if (r3fSample) {
      parts.push(
        `r3f=${r3fSample.avgMs.toFixed(2)}ms avg ${r3fSample.maxMs.toFixed(2)}ms max`,
      );
    }
    if (poseSample) {
      parts.push(
        `pose=${poseSample.avgMs.toFixed(2)}ms avg ${poseSample.maxMs.toFixed(2)}ms max`,
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
    if (gpuReadySample) {
      parts.push(
        `gpuReady=${gpuReadySample.avgMs.toFixed(2)}ms avg ${
          gpuReadySample.maxMs.toFixed(2)
        }ms max`,
      );
    }
    if (shelfSample) {
      parts.push(
        `shelf=${shelfSample.avgMs.toFixed(2)}ms avg ${shelfSample.maxMs.toFixed(2)}ms max`,
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

  private async enterXrWhenReady(
    store: { enterAR: () => Promise<XRSession>; enterVR: () => Promise<XRSession> },
    sessionMode: SupportedSessionMode,
  ) {
    const deadline = performance.now() + XR_CONNECT_TIMEOUT_MS;
    let attempts = 0;
    let lastError: Error | null = null;

    while (performance.now() < deadline) {
      try {
        return await (sessionMode === "immersive-ar" ? store.enterAR() : store.enterVR());
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
    if (!this.xrDevice) {
      return;
    }

    const hmdPose = this.getCurrentOpenVrHmdPose();
    if (!hmdPose) {
      return;
    }

    this.xrDevice.position?.set?.(
      hmdPose.position[0],
      hmdPose.position[1],
      hmdPose.position[2],
    );
    this.xrDevice.quaternion?.set?.(
      hmdPose.quaternion[0],
      hmdPose.quaternion[1],
      hmdPose.quaternion[2],
      hmdPose.quaternion[3],
    );
  }

  private getCurrentOpenVrHmdPose(): {
    matrix: Float32Array;
    position: [number, number, number];
    quaternion: [number, number, number, number];
  } | null {
    if (this.openVrOverlayPacer) {
      return this.openVrOverlayPacer.getCachedHmdEmulation();
    }
    if (!this.vrSystemPointer) {
      return null;
    }

    const systemPointer = Deno.UnsafePointer.create(
      typeof this.vrSystemPointer === "bigint"
        ? this.vrSystemPointer
        : BigInt(this.vrSystemPointer),
    );
    if (!systemPointer) {
      return null;
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
    const hmdPose = OpenVR.TrackedDevicePoseStruct.read(poseView) as unknown as OpenVR.TrackedDevicePose;
    if (!hmdPose.bPoseIsValid) {
      return null;
    }

    const m = hmdPose.mDeviceToAbsoluteTracking.m;
    return {
      matrix: new Float32Array([
        m[0][0], m[1][0], m[2][0], 0,
        m[0][1], m[1][1], m[2][1], 0,
        m[0][2], m[1][2], m[2][2], 0,
        m[0][3], m[1][3], m[2][3], 1,
      ]),
      position: [m[0][3], m[1][3], m[2][3]],
      quaternion: this.matrix3x4ToQuaternion(m),
    };
  }

  private captureShadowPoseFromRenderer() {
    const xrCamera = this.renderer?.xr?.getCamera?.() as
      | (THREE.Camera & { cameras?: THREE.PerspectiveCamera[] })
      | null
      | undefined;
    const leftCamera = xrCamera?.cameras?.[0] ?? null;
    const rightCamera = xrCamera?.cameras?.[1] ?? null;
    if (!xrCamera || !leftCamera || !rightCamera) {
      this.latestShadowPose = null;
      return;
    }

    const viewer = this.objectWorldTransformToPose(xrCamera);
    const left = this.objectWorldTransformToPose(leftCamera);
    const right = this.objectWorldTransformToPose(rightCamera);
    const ipdMeters = Math.hypot(
      right.position[0] - left.position[0],
      right.position[1] - left.position[1],
      right.position[2] - left.position[2],
    );

    this.latestShadowPose = {
      viewerPosition: viewer.position,
      viewerQuaternion: viewer.quaternion,
      leftEyePosition: left.position,
      leftEyeQuaternion: left.quaternion,
      leftEyeViewMatrix: new Float32Array(
        new THREE.Matrix4().copy(leftCamera.matrixWorld).invert().elements,
      ),
      leftEyeProjectionMatrix: new Float32Array(leftCamera.projectionMatrix.elements),
      rightEyePosition: right.position,
      rightEyeQuaternion: right.quaternion,
      rightEyeViewMatrix: new Float32Array(
        new THREE.Matrix4().copy(rightCamera.matrixWorld).invert().elements,
      ),
      rightEyeProjectionMatrix: new Float32Array(rightCamera.projectionMatrix.elements),
      halfFovInRadians: this.projectionMatrixToHalfFovInRadians(leftCamera.projectionMatrix.elements),
      ipdMeters,
    };
  }

  private objectWorldTransformToPose(object: THREE.Object3D) {
    object.updateMatrixWorld(true);
    const matrix = object.matrixWorld;
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(position, quaternion, scale);
    return {
      position: new Float32Array([position.x, position.y, position.z]),
      quaternion: new Float32Array([quaternion.x, quaternion.y, quaternion.z, quaternion.w]),
    };
  }

  private projectionMatrixToHalfFovInRadians(matrixValues: ArrayLike<number>): number {
    const m5 = Number(matrixValues[5] ?? 0);
    if (!Number.isFinite(m5) || m5 === 0) {
      return (112 / 2) * (Math.PI / 180);
    }
    return Math.atan(1 / m5);
  }

  private applyExternalControllerData() {
    if (!this.xrDevice?.controllers) {
      return;
    }

    const data = this.latestControllerData;
    if (!data) {
      if (this.xrDevice.controllers.left) {
        this.xrDevice.controllers.left.connected = false;
      }
      if (this.xrDevice.controllers.right) {
        this.xrDevice.controllers.right.connected = false;
      }
      return;
    }

    this.updateControllerState(
      this.xrDevice.controllers.left,
      "left",
      data[0],
      data[2],
      data[4],
    );
    this.updateControllerState(
      this.xrDevice.controllers.right,
      "right",
      data[1],
      data[3],
      data[5],
    );
  }

  private updateEmulatedControllersFromOpenVr() {
    if (
      !this.xrDevice?.controllers ||
      !this.vrInputPointer ||
      this.openVrControllerBridgeDisabled
    ) {
      return;
    }

    try {
      const vrInput = this.ensureOpenVrInput();
      if (!vrInput) {
        return;
      }

      this.updateOpenVrActionState(vrInput);

      this.readPoseAction(vrInput, this.handPoseLeftHandle, this.leftPoseState);
      this.readPoseAction(vrInput, this.handPoseRightHandle, this.rightPoseState);
      this.readDigitalAction(vrInput, this.triggerLeftHandle, this.leftTriggerState);
      this.readDigitalAction(vrInput, this.triggerRightHandle, this.rightTriggerState);
      this.readDigitalAction(vrInput, this.grabLeftHandle, this.leftGrabState);
      this.readDigitalAction(vrInput, this.grabRightHandle, this.rightGrabState);

      const leftPoseData = OpenVR.InputPoseActionDataStruct.read(this.leftPoseState.view);
      const rightPoseData = OpenVR.InputPoseActionDataStruct.read(this.rightPoseState.view);
      const leftTriggerData = OpenVR.InputDigitalActionDataStruct.read(this.leftTriggerState.view);
      const rightTriggerData = OpenVR.InputDigitalActionDataStruct.read(this.rightTriggerState.view);
      const leftGrabData = OpenVR.InputDigitalActionDataStruct.read(this.leftGrabState.view);
      const rightGrabData = OpenVR.InputDigitalActionDataStruct.read(this.rightGrabState.view);

      this.updateControllerState(
        this.xrDevice.controllers.left,
        "left",
        leftPoseData,
        leftTriggerData,
        leftGrabData,
      );
      this.updateControllerState(
        this.xrDevice.controllers.right,
        "right",
        rightPoseData,
        rightTriggerData,
        rightGrabData,
      );
    } catch (error) {
      this.openVrControllerBridgeDisabled = true;
      this.openVrControllerBridgeError = this.describeOpenVrInputError(error);
      LogChannel.log(
        "webxrv2",
        `[webxrhost] disabling OpenVR controller bridge: ${this.openVrControllerBridgeError}`,
      );
    }
  }

  private ensureOpenVrInput(): OpenVR.IVRInput | null {
    if (this.vrInput) {
      return this.vrInput;
    }
    if (!this.vrInputPointer) {
      return null;
    }

    const inputPointer = Deno.UnsafePointer.create(
      typeof this.vrInputPointer === "bigint"
        ? this.vrInputPointer
        : BigInt(this.vrInputPointer),
    );
    if (!inputPointer) {
      return null;
    }

    this.vrInput = new OpenVR.IVRInput(inputPointer);
    this.initializeOpenVrInputHandles(this.vrInput);
    return this.vrInput;
  }

  private initializeOpenVrInputHandles(vrInput: OpenVR.IVRInput) {
    if (this.openVrInputInitialized) {
      return;
    }

    this.actionManifestPath ??= tempFile("./resources/actions.json", import.meta.dirname!);
    let error = vrInput.SetActionManifestPath(this.actionManifestPath);
    if (error !== OpenVR.InputError.VRInputError_None) {
      throw new Error(`Failed to set OpenVR action manifest path: ${error}`);
    }

    this.handPoseLeftHandle = this.getActionHandle(
      vrInput,
      "/actions/main/in/HandPoseLeft",
      this.handPoseLeftHandlePtr,
    );
    this.handPoseRightHandle = this.getActionHandle(
      vrInput,
      "/actions/main/in/HandPoseRight",
      this.handPoseRightHandlePtr,
    );
    this.triggerLeftHandle = this.getActionHandle(
      vrInput,
      "/actions/main/in/TriggerLeft",
      this.triggerLeftHandlePtr,
    );
    this.triggerRightHandle = this.getActionHandle(
      vrInput,
      "/actions/main/in/TriggerRight",
      this.triggerRightHandlePtr,
    );
    this.grabLeftHandle = this.getActionHandle(
      vrInput,
      "/actions/main/in/GrabLeft",
      this.grabLeftHandlePtr,
    );
    this.grabRightHandle = this.getActionHandle(
      vrInput,
      "/actions/main/in/GrabRight",
      this.grabRightHandlePtr,
    );

    error = vrInput.GetActionSetHandle("/actions/main", this.actionSetHandlePtr);
    if (error !== OpenVR.InputError.VRInputError_None) {
      throw new Error(`Failed to get OpenVR action set handle: ${error}`);
    }
    this.actionSetHandle = new Deno.UnsafePointerView(this.actionSetHandlePtr).getBigUint64();
    this.openVrInputInitialized = true;
  }

  private getActionHandle(
    vrInput: OpenVR.IVRInput,
    path: string,
    handlePtr: Deno.PointerObject<OpenVR.ActionHandle>,
  ): OpenVR.ActionHandle {
    const error = vrInput.GetActionHandle(path, handlePtr);
    if (error !== OpenVR.InputError.VRInputError_None) {
      throw new Error(`Failed to get OpenVR action handle for ${path}: ${error}`);
    }
    return new Deno.UnsafePointerView(handlePtr).getBigUint64();
  }

  private updateOpenVrActionState(vrInput: OpenVR.IVRInput) {
    const [activeActionSetPtr] = createStruct<OpenVR.ActiveActionSet>(
      {
        ulActionSet: this.actionSetHandle,
        ulRestrictedToDevice: OpenVR.k_ulInvalidInputValueHandle,
        ulSecondaryActionSet: 0n,
        unPadding: 0,
        nPriority: 0,
      },
      OpenVR.ActiveActionSetStruct,
    );
    const error = vrInput.UpdateActionState(
      activeActionSetPtr,
      OpenVR.ActiveActionSetStruct.byteSize,
      1,
    );
    if (error !== OpenVR.InputError.VRInputError_None) {
      throw new Error(`Failed to update OpenVR action state: ${error}`);
    }
  }

  private readPoseAction(
    vrInput: OpenVR.IVRInput,
    handle: OpenVR.ActionHandle,
    target: {
      pointer: Deno.PointerValue<OpenVR.InputPoseActionData>;
      view: DataView<ArrayBuffer>;
    },
  ) {
    new Uint8Array(target.view.buffer, target.view.byteOffset, target.view.byteLength).fill(0);
    const error = vrInput.GetPoseActionDataRelativeToNow(
      handle,
      OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding,
      0,
      target.pointer,
      OpenVR.InputPoseActionDataStruct.byteSize,
      OpenVR.k_ulInvalidInputValueHandle,
    );
    if (
      error !== OpenVR.InputError.VRInputError_None &&
      error !== OpenVR.InputError.VRInputError_NoData &&
      error !== OpenVR.InputError.VRInputError_InvalidDevice
    ) {
      throw new Error(`Failed to read OpenVR pose action: ${error}`);
    }
  }

  private readDigitalAction(
    vrInput: OpenVR.IVRInput,
    handle: OpenVR.ActionHandle,
    target: {
      pointer: Deno.PointerValue<OpenVR.InputDigitalActionData>;
      view: DataView<ArrayBuffer>;
    },
  ) {
    new Uint8Array(target.view.buffer, target.view.byteOffset, target.view.byteLength).fill(0);
    const error = vrInput.GetDigitalActionData(
      handle,
      target.pointer,
      OpenVR.InputDigitalActionDataStruct.byteSize,
      OpenVR.k_ulInvalidInputValueHandle,
    );
    if (
      error !== OpenVR.InputError.VRInputError_None &&
      error !== OpenVR.InputError.VRInputError_NoData &&
      error !== OpenVR.InputError.VRInputError_InvalidDevice
    ) {
      throw new Error(`Failed to read OpenVR digital action: ${error}`);
    }
  }

  private describeOpenVrInputError(error: unknown): string {
    if (!(error instanceof Error)) {
      return String(error);
    }

    const match = error.message.match(/: (\d+)$/);
    if (!match) {
      return error.message;
    }

    const code = Number(match[1]) as OpenVR.InputError;
    const codeName = OpenVR.InputError[code];
    return codeName ? `${error.message} (${codeName})` : error.message;
  }

  private updateControllerState(
    controller: XrControllerBridge | undefined,
    handedness: "left" | "right",
    poseData: OpenVrPoseActionData,
    triggerData: OpenVrDigitalActionData,
    grabData: OpenVrDigitalActionData,
  ) {
    if (!controller) {
      return;
    }

    const pose = poseData?.pose;
    const tracking = pose?.mDeviceToAbsoluteTracking?.m;
    const isConnected = Boolean(poseData?.bActive) && Boolean(pose?.bPoseIsValid) && Array.isArray(tracking);
    controller.connected = isConnected;
    controller.updateButtonValue?.("trigger", triggerData?.bState ? 1 : 0);
    controller.updateButtonValue?.("squeeze", grabData?.bState ? 1 : 0);
    if (!isConnected) {
      return;
    }

    const m = tracking;
    const baseQuaternion = this.matrix3x4ToQuaternion(m);
    const correctedQuaternion = new THREE.Quaternion(
      baseQuaternion[0],
      baseQuaternion[1],
      baseQuaternion[2],
      baseQuaternion[3],
    );
    correctedQuaternion.multiply(CONTROLLER_ROTATION_OFFSET);
    controller.position?.set?.(m[0][3], m[1][3], m[2][3]);
    controller.quaternion?.set?.(
      correctedQuaternion.x,
      correctedQuaternion.y,
      correctedQuaternion.z,
      correctedQuaternion.w,
    );
  }

  private matrix3x4ToQuaternion(
    matrix:
      | [
          [number, number, number, number],
          [number, number, number, number],
          [number, number, number, number],
        ]
      | number[][],
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
    const poseQuaternion = this.latestShadowPose?.viewerQuaternion;
    const deviceQuaternion = (this.xrDevice as {
      quaternion?: {
        quat?: ArrayLike<number>;
        x?: number;
        y?: number;
        z?: number;
        w?: number;
      };
    } | null)?.quaternion;

    const quatValues = poseQuaternion
      ? [
        Number(poseQuaternion[0] ?? 0),
        Number(poseQuaternion[1] ?? 0),
        Number(poseQuaternion[2] ?? 0),
        Number(poseQuaternion[3] ?? 1),
      ] as const
      : deviceQuaternion?.quat
      ? [
        Number(deviceQuaternion.quat[0] ?? 0),
        Number(deviceQuaternion.quat[1] ?? 0),
        Number(deviceQuaternion.quat[2] ?? 0),
        Number(deviceQuaternion.quat[3] ?? 1),
      ] as const
      : deviceQuaternion
      ? [
        Number(deviceQuaternion.x ?? 0),
        Number(deviceQuaternion.y ?? 0),
        Number(deviceQuaternion.z ?? 0),
        Number(deviceQuaternion.w ?? 1),
      ] as const
      : null;

    const lookRotation = new THREE.Matrix4();
    if (!quatValues) {
      return new Float32Array(lookRotation.identity().elements);
    }

    const worldFromHmd = new THREE.Matrix4().makeRotationFromQuaternion(
      new THREE.Quaternion(
        quatValues[0],
        quatValues[1],
        quatValues[2],
        quatValues[3],
      ),
    );
    const hmdFromWorld = worldFromHmd.invert();
    const zFlip = new THREE.Matrix4().makeScale(1, 1, -1);
    lookRotation.multiplyMatrices(hmdFromWorld, zFlip);
    return new Float32Array(lookRotation.elements);
  }

  private getViewerPositionVector(): Float32Array {
    const position = (this.xrDevice as {
      position?: {
        x?: number;
        y?: number;
        z?: number;
        vec3?: ArrayLike<number>;
      };
    } | null)?.position;

    if (position?.vec3) {
      return new Float32Array([
        Number(position.vec3[0] ?? 0),
        Number(position.vec3[1] ?? 0),
        Number(position.vec3[2] ?? 0),
      ]);
    }

    return new Float32Array([
      Number(position?.x ?? 0),
      Number(position?.y ?? 0),
      Number(position?.z ?? 0),
    ]);
  }

  private getViewerQuaternionVector(): Float32Array {
    const quaternion = (this.xrDevice as {
      quaternion?: {
        x?: number;
        y?: number;
        z?: number;
        w?: number;
        quat?: ArrayLike<number>;
      };
    } | null)?.quaternion;

    if (quaternion?.quat) {
      return new Float32Array([
        Number(quaternion.quat[0] ?? 0),
        Number(quaternion.quat[1] ?? 0),
        Number(quaternion.quat[2] ?? 0),
        Number(quaternion.quat[3] ?? 1),
      ]);
    }

    return new Float32Array([
      Number(quaternion?.x ?? 0),
      Number(quaternion?.y ?? 0),
      Number(quaternion?.z ?? 0),
      Number(quaternion?.w ?? 1),
    ]);
  }
}
