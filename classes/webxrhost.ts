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
import { PetplayDefaultXRController } from "./environment/petplayXrController.tsx";
import { NativeControllerHud } from "./environment/nativeFrontend.tsx";
import { WebXRScene } from "./environment/scene.tsx";
import { FpsCounter } from "./fpsCounter.ts";
import { IntervalMetric } from "./intervalMetric.ts";
import { tempFile } from "./utils.ts";
import { installWebXRHostPolyfills, type WebXrHostPolyfillOptions } from "./webxrPolyfills.ts";
import {
  type OpenVrHmdEmulationPose,
  type OpenVrOverlayFramePacer,
  type OpenVrOverlayPaceMode,
  tryCreateOpenVrOverlayFramePacer,
} from "./openVrOverlayFramePacing.ts";
import {
  type DirectOpenVrInputSnapshot,
  DirectOpenVrInputSource,
} from "./directOpenVrInputSource.ts";
import { WEBXR_CRASH_ON_DROP_WARMUP_FRAMES } from "./webxrCrashOnDrop.ts";
import { describeProjectionLayer, getProjectionLayer } from "./webxrProjectionLayer.ts";
import { WebXRSurfaceHost } from "./webxrSurfaceHost.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { useFrame as useR3FFrame } from "npm:@react-three/fiber@10.0.0-alpha.2/webgpu"

type OpenVrPoseActionData = ReturnType<typeof OpenVR.InputPoseActionDataStruct.read>;
type OpenVrDigitalActionData = ReturnType<typeof OpenVR.InputDigitalActionDataStruct.read>;
export type ExternalControllerData = [
  OpenVrPoseActionData,
  OpenVrPoseActionData,
  OpenVrDigitalActionData,
  OpenVrDigitalActionData,
  OpenVrDigitalActionData,
  OpenVrDigitalActionData,
];

type StartOptions = {
  width?: number;
  height?: number;
  title?: string;
  debugWindow?: boolean;
  vrSystemPointer?: number | bigint | null;
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
   * `IVRInput` (OpenVR). When provided, {@link DirectOpenVrInputSource} reads trigger / grab
   * buttons directly from the action manifest each frame.
   */
  vrInputPointer?: number | bigint | null;
  /**
   * Each XR session rAF tick, right after `paceToDisplayAndRefreshPoses` (when
   * present) and before HMD/controller emulation. Use to ingest cross-actor
   * controller input (e.g. SharedArrayBuffer) for this display frame.
   * **Must be synchronous** — `XRFrame` is only valid for the synchronous rAF
   * invocation; `await` here invalidates the frame before `advance()` (WebXR / IWER).
   */
  onBeforeExternalControllerApply?: () => void;
  /**
   * Fires with the 6-tuple that `setControllerData` would use for
   * `applyExternalControllerData`. Button states come from
   * {@link DirectOpenVrInputSource} when initialised with `vrInputPointer`.
   */
  onInProcessControllerFrame?: (data: ExternalControllerData) => void;
  /**
   * When `true` (default), drive IWER’s global rAF with OpenVR display timing
   * (`openVrOverlayFramePacing`) instead of a fixed setTimeout. Set `false` to A/B test
   * the old synthetic rAF only.
   */
  useOpenVrOverlayFramePacing?: boolean;
  /** When true, WebXRHost does not read OpenVR HMD poses; an external overlay loop may own them. */
  disableOpenVrHmdPose?: boolean;
  /**
   * OpenVR `paceToDisplay` mode. `vsync` (default) waits for a new display index per tick (~HMD Hz).
   * `fast` samples once with no vsync spin — higher simulation / R3F rate; may duplicate photons, more CPU.
   * Overrides `deno run ... --webxr-openvr-pace=...` when set.
   */
  openVrPace?: OpenVrOverlayPaceMode;
  /**
   * When the OpenVR overlay pacer is **not** used, set Deno’s synthetic `requestAnimationFrame` target
   * (Hz), e.g. 120, instead of `nominalHmdDisplayHz` or 16ms. Ignored when `openVrOverlayPacer` is active.
   * Overrides `deno run ... --webxr-polyfill-hz=...` when set.
   */
  webxrPolyfillHz?: number | null;
  /**
   * Minimum interval between manual XR rAF bodies (pose + `advance`). Offloads sim-vs-photon beat
   * when `openVrPace: fast` runs the loop far above the HMD/overlay (e.g. 200 sim Hz vs 75 display).
   * `undefined` = use `--webxr-sim-tick-hz=...` (default off). `"display"` = `1000 / nominalHmdDisplayHz` (or 90).
   * Overrides CLI when set.
   */
  simTickHz?: number | "display";
};

type WebXRStatus = {
  running: boolean;
  frameCount: number;
  xrFps: number;
  inspected: boolean;
  lastInspection: NonBlackPixelReport | null;
  error: string | null;
  lastLayerInfo: string | null;
  /** Largest wall gap between XR rAF callbacks (ms) since `start` (after first callback). */
  xrRafMaxIntervalMs: number;
  /** Count of rAF gaps > ~1.25× nominal frame time (after `WEBXR_CRASH_ON_DROP_WARMUP_FRAMES`). */
  xrRafSlowFrameCount: number;
  /** `OpenVrOverlayFramePacer` display index gaps (compositor may have missed vsyncs). */
  vsyncDisplayFramesSkipped: number;
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
  /** Debug-only raw OpenVR left controller position, drawn directly by Raylib. */
  raylibDebugLeftControllerPosition?: Float32Array;
};

export type {
  DirectOpenVrControllerPose,
  DirectOpenVrHmdPose,
  DirectOpenVrInputSnapshot,
} from "./directOpenVrInputSource.ts";

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

/**
 * `deno run ... --webxr-log-slow-frames` logs throttled messages when the wall interval between
 * XR rAF callbacks exceeds ~1.3× nominal frame time (after warmup). Use with
 * `GETWEBXRSTATUS` metrics when crash mode stays quiet but motion still judders.
 */
export function getLogSlowXrFrames(): boolean {
  const raw = Deno.args.find((a) => a.startsWith("--webxr-log-slow-frames"));
  if (raw == null) {
    return false;
  }
  const v = raw.split("=", 2)[1]?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") {
    return false;
  }
  return true;
}

function getWebxrFrameLogsEnabled(): boolean {
  const raw = Deno.args.find((a) => a.startsWith("--webxr-frame-logs"));
  if (raw == null) {
    return false;
  }
  const v = raw.split("=", 2)[1]?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

const DEFAULT_XRAF_STRICT_INTERVAL_MULT = 1.12;

/**
 * Tunes `xr-raf-strict` (default ~1.12 = first noticeable gap vs nominal refresh).
 * Example: `deno run ... --webxr-raf-strict-mult=1.08`
 */
export function getXrRafStrictIntervalMultiplier(): number {
  const raw = Deno.args
    .find((a) => a.startsWith("--webxr-raf-strict-mult="))
    ?.split("=", 2)[1]
    ?.trim();
  if (raw == null || raw === "") {
    return DEFAULT_XRAF_STRICT_INTERVAL_MULT;
  }
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 1.0 || n > 2.5) {
    LogChannel.log(
      "webxrv2",
      `[webxrhost] invalid --webxr-raf-strict-mult=${raw}, using ${DEFAULT_XRAF_STRICT_INTERVAL_MULT}`,
    );
    return DEFAULT_XRAF_STRICT_INTERVAL_MULT;
  }
  return n;
}

/**
 * When the OpenVR/startup path does not pass `nominalHmdDisplayHz` but you know the headset (e.g.
 * 75 Hz), set `deno run ... --webxr-fallback-nominal-hz=75` so rAF expect/strict thresholds use
 * 1000/75 ms instead of the 90 Hz fallback.
 */
function getWebxrFallbackNominalHzFromArgs(): number | null {
  const raw = Deno.args
    .find((a) => a.startsWith("--webxr-fallback-nominal-hz="))
    ?.split("=", 2)[1]
    ?.trim();
  if (raw == null || raw === "") {
    return null;
  }
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 30 || n > 240) {
    LogChannel.log("webxrv2", `[webxrhost] invalid --webxr-fallback-nominal-hz=${raw}, ignoring`);
    return null;
  }
  return n;
}

/** Per-frame lerp toward raw OpenVR hand position. `0` = off. Aardvark-style default is raw. */
const DEFAULT_WEBXR_CONTROLLER_POS_LERP = 0;

function getWebxrControllerPosLerpFromArgs(): number {
  const raw = Deno.args
    .find((a) => a.startsWith("--webxr-controller-pos-lerp="))
    ?.split("=", 2)[1]
    ?.trim();
  if (raw == null || raw === "") {
    return DEFAULT_WEBXR_CONTROLLER_POS_LERP;
  }
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    LogChannel.log(
      "webxrv2",
      `[webxrhost] invalid --webxr-controller-pos-lerp=${raw}, using ${DEFAULT_WEBXR_CONTROLLER_POS_LERP}`,
    );
    return DEFAULT_WEBXR_CONTROLLER_POS_LERP;
  }
  return n;
}

/**
 * Max hand speed (m/s) between consecutive `applyExternalControllerData` invocations, applied to
 * **raw** OpenVR position before the position lerp. `0` = no cap. Aardvark-style default is raw.
 */
const DEFAULT_WEBXR_CONTROLLER_MAX_HAND_MPS = 0;

function getWebxrControllerMaxHandMpsFromArgs(): number {
  const raw = Deno.args
    .find((a) => a.startsWith("--webxr-controller-max-hand-mps="))
    ?.split("=", 2)[1]
    ?.trim();
  if (raw == null || raw === "") {
    return DEFAULT_WEBXR_CONTROLLER_MAX_HAND_MPS;
  }
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 50) {
    LogChannel.log(
      "webxrv2",
      `[webxrhost] invalid --webxr-controller-max-hand-mps=${raw}, using ${DEFAULT_WEBXR_CONTROLLER_MAX_HAND_MPS}`,
    );
    return DEFAULT_WEBXR_CONTROLLER_MAX_HAND_MPS;
  }
  return n;
}

function getWebxrRaylibControllerDebugEnabled(): boolean {
  const raw = Deno.args
    .find((a) => a.startsWith("--webxr-raylib-controller-debug="))
    ?.split("=", 2)[1]
    ?.trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function getWebxrOpenVrPaceFromArgs(): OpenVrOverlayPaceMode {
  const raw = Deno.args
    .find((a) => a.startsWith("--webxr-openvr-pace="))
    ?.split("=", 2)[1]
    ?.trim()
    .toLowerCase();
  if (raw == null || raw === "" || raw === "vsync" || raw === "display") {
    return "vsync";
  }
  if (raw === "fast" || raw === "throughput" || raw === "max") {
    return "fast";
  }
  LogChannel.log("webxrv2", `[webxrhost] unknown --webxr-openvr-pace=${raw}, using vsync`);
  return "vsync";
}

/** `null` = use `nominalHmdDisplayHz` (or 16ms fallback) for the synthetic rAF when no OpenVR pacer. */
function getWebxrPolyfillHzFromArgs(): number | null {
  const raw = Deno.args
    .find((a) => a.startsWith("--webxr-polyfill-hz="))
    ?.split("=", 2)[1]
    ?.trim();
  if (raw == null || raw === "") {
    return null;
  }
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 30 || n > 360) {
    LogChannel.log("webxrv2", `[webxrhost] invalid --webxr-polyfill-hz=${raw}, ignoring`);
    return null;
  }
  return n;
}

/**
 * `null` = no cap. `"display"` = use `1000 / nominalHmdDisplayHz` (set in `start`). Else 30-240 = Hz.
 */
function getWebxrSimTickHzFromArgs(): number | "display" | null {
  const raw = Deno.args
    .find((a) => a.startsWith("--webxr-sim-tick-hz="))
    ?.split("=", 2)[1]
    ?.trim();
  if (raw == null || raw === "") {
    return null;
  }
  const low = raw.toLowerCase();
  if (low === "display" || low === "hmd" || low === "nominal" || low === "panel") {
    return "display";
  }
  const n = Number.parseFloat(raw);
  if (Number.isFinite(n) && n >= 30 && n <= 240) {
    return n;
  }
  LogChannel.log(
    "webxrv2",
    `[webxrhost] invalid --webxr-sim-tick-hz=${raw}, not capping sim ticks`,
  );
  return null;
}

/**
 * `deno run ... --webxr-crash-on-dropped-frame=...` (or `=off`) throws on suspect dropped frames
 * so a debugger can break on the Error. Options (comma‑separated):
 * - `vsync` — `OpenVrOverlayFramePacer` display index skip (after first index).
 * - `overlay` — `pumpOverlayFrames` sees `host.frameCount` jump by more than one before upload.
 * - `xr-raf` — wall time between `XRSession` rAF callbacks exceeds ~1.85× nominal frame time
 *   (tolerates heavy jitter; often stays quiet when strict mode would fire).
 * - `xr-raf-strict` — first post‑warmup interval **>** `strictMult ×` nominal (default ~1.12×) —
 *   for catching a single “late” rAF when CPU is within budget but cadence slipped.
 * - `controller-stale` — (SAB v4) same **pose matrix hash** on two consecutive XR rAF ticks while
 *   OpenVR |v|/|ω| are above a floor (or stuck `writeSeq`, rare at ~1kHz writes). A fast writer does
 *   not help if tracking hands you the same 3×4 for two **display** frames.
 * Shorthands: `all` = vsync+overlay+`xr-raf` (loose). `all-strict` = vsync+overlay+`xr-raf-strict`.
 *
 * Tuning: `--webxr-raf-strict-mult=1.1`, and `--webxr-fallback-nominal-hz=75` if Hz is not in the
 * start payload. Each mode still skips the first `WEBXR_CRASH_ON_DROP_WARMUP_FRAMES` frames
 * (startup ~2 fps is expected).
 */
export function getCrashOnDroppedFrameMode(): {
  vsync: boolean;
  overlay: boolean;
  xrRaf: boolean;
  xrRafStrict: boolean;
  /** `petplay/webxr` SAB ingest: same controller sample for two display frames. */
  controllerSabStale: boolean;
} {
  const raw = Deno.args
    .find((a) => a.startsWith("--webxr-crash-on-dropped-frame="))
    ?.split("=", 2)[1]
    ?.trim()
    .toLowerCase();
  if (raw == null || raw === "" || raw === "off") {
    return {
      vsync: false,
      overlay: false,
      xrRaf: false,
      xrRafStrict: false,
      controllerSabStale: false,
    };
  }
  if (raw === "all") {
    return {
      vsync: true,
      overlay: true,
      xrRaf: true,
      xrRafStrict: false,
      controllerSabStale: false,
    };
  }
  if (raw === "all-strict") {
    return {
      vsync: true,
      overlay: true,
      xrRaf: false,
      xrRafStrict: true,
      controllerSabStale: false,
    };
  }
  const parts = raw.split(",").map((s) => s.trim());
  return {
    vsync: parts.includes("vsync"),
    overlay: parts.includes("overlay"),
    xrRaf: parts.includes("xr-raf") || parts.includes("raf"),
    xrRafStrict: parts.includes("xr-raf-strict"),
    controllerSabStale: parts.includes("controller-stale") || parts.includes("ctrl-stale"),
  };
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

type XrPoseOnlyRenderer = {
  xr: XrPoseOnlyManager;
  backend: { isWebGPUBackend: true };
  domElement: unknown;
  hasInitialized: () => true;
  init: () => Promise<void>;
  render: (scene: THREE.Object3D, camera: THREE.Camera) => void;
  setSize: (width: number, height: number) => void;
  getSize: (target: THREE.Vector2) => THREE.Vector2;
  setPixelRatio: (value: number) => void;
  getPixelRatio: () => number;
  setViewport: (...args: unknown[]) => void;
  getViewport: (target: THREE.Vector4) => THREE.Vector4;
  setScissor: (...args: unknown[]) => void;
  getScissor: (target: THREE.Vector4) => THREE.Vector4;
  setScissorTest: (value: boolean) => void;
  getScissorTest: () => boolean;
  setClearColor: (...args: unknown[]) => void;
  getClearColor: (target: THREE.Color) => THREE.Color;
  getClearAlpha: () => number;
  clear: (...args: unknown[]) => void;
  setAnimationLoop: (callback: XRFrameRequestCallback | null) => void;
  dispose: () => void;
  initialized: true;
};

class XrPoseOnlyManager extends EventTarget {
  enabled = true;
  isPresenting = false;
  cameraAutoUpdate = true;
  private foveation = 0;
  private referenceSpaceType: XRReferenceSpaceType = "local-floor";
  private session: XRSession | null = null;
  private referenceSpace: XRReferenceSpace | null = null;
  private readonly camera = new THREE.ArrayCamera([
    new THREE.PerspectiveCamera(),
    new THREE.PerspectiveCamera(),
  ]);

  setReferenceSpaceType(type: XRReferenceSpaceType) {
    this.referenceSpaceType = type;
  }

  async setSession(session: XRSession | null) {
    if (this.session === session) {
      return;
    }
    if (!session) {
      this.session = null;
      this.referenceSpace = null;
      this.isPresenting = false;
      this.dispatchEvent(new Event("sessionend"));
      return;
    }

    this.session = session;
    this.referenceSpace = await session.requestReferenceSpace(this.referenceSpaceType);
    const bindingCtor = (globalThis as unknown as {
      XRGPUBinding?: new (session: XRSession, device: unknown) => {
        createProjectionLayer: (init?: Record<string, unknown>) => XRLayer;
      };
    }).XRGPUBinding;
    if (!bindingCtor) {
      throw new Error("XRGPUBinding unavailable for pose-only WebXR renderer");
    }
    const binding = new bindingCtor(session, createPoseOnlyGpuDevice());
    session.updateRenderState({
      layers: [binding.createProjectionLayer({ textureType: "texture-array" })],
    });
    this.isPresenting = true;
    this.dispatchEvent(new Event("sessionstart"));
  }

  getSession(): XRSession | null {
    return this.session;
  }

  getReferenceSpace(): XRReferenceSpace | null {
    return this.referenceSpace;
  }

  getReferenceSpaceType(): XRReferenceSpaceType {
    return this.referenceSpaceType;
  }

  getBaseLayer(): XRLayer | null {
    return this.session?.renderState.layers?.[0] ?? this.session?.renderState.baseLayer ?? null;
  }

  setFoveation(value: number) {
    this.foveation = value;
  }

  getFoveation(): number {
    return this.foveation;
  }

  setAnimationLoop(_callback: XRFrameRequestCallback | null) {
    // WebXRHost owns the manual XR rAF loop.
  }

  updateFromFrame(frame: XRFrame) {
    const referenceSpace = this.referenceSpace;
    if (!referenceSpace) {
      return;
    }
    const pose = frame.getViewerPose(referenceSpace);
    if (!pose) {
      return;
    }

    const cameras = this.camera.cameras as THREE.PerspectiveCamera[];
    for (let i = 0; i < 2; i++) {
      const view = pose.views[i];
      const camera = cameras[i];
      if (!view || !camera) {
        continue;
      }
      camera.matrix.fromArray(view.transform.matrix);
      camera.matrix.decompose(camera.position, camera.quaternion, camera.scale);
      camera.matrixWorld.copy(camera.matrix);
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      camera.projectionMatrix.fromArray(view.projectionMatrix);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      camera.updateMatrixWorld(true);
    }

    this.camera.matrix.fromArray(pose.transform.matrix);
    this.camera.matrix.decompose(this.camera.position, this.camera.quaternion, this.camera.scale);
    this.camera.matrixWorld.copy(this.camera.matrix);
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    this.camera.updateMatrixWorld(true);
  }

  getCamera(): THREE.ArrayCamera {
    return this.camera;
  }

  updateCamera(_camera: THREE.PerspectiveCamera) {
    // updateFromFrame already owns the XR camera matrices.
  }
}

function createPoseOnlyGpuDevice() {
  const texture = {
    createView: () => ({}),
    destroy: () => {},
  };
  return {
    createTexture: () => texture,
  };
}

function createXrPoseOnlyRenderer(
  canvas: unknown,
  width: number,
  height: number,
): XrPoseOnlyRenderer {
  const xr = new XrPoseOnlyManager();
  const size = new THREE.Vector2(width, height);
  const viewport = new THREE.Vector4(0, 0, width, height);
  const scissor = new THREE.Vector4(0, 0, width, height);
  const clearColor = new THREE.Color(0, 0, 0);
  let pixelRatio = 1;
  let clearAlpha = 1;
  let scissorTest = false;
  return {
    xr,
    backend: { isWebGPUBackend: true },
    domElement: canvas,
    hasInitialized: () => true,
    init: async () => {},
    render: (scene, camera) => {
      if (scene.matrixWorldAutoUpdate === true) {
        scene.updateMatrixWorld();
      }
      if (camera.parent === null && camera.matrixWorldAutoUpdate === true) {
        camera.updateMatrixWorld();
      }
    },
    setSize: (nextWidth, nextHeight) => {
      size.set(nextWidth, nextHeight);
      viewport.set(0, 0, nextWidth, nextHeight);
      scissor.set(0, 0, nextWidth, nextHeight);
    },
    getSize: (target) => target.copy(size),
    setPixelRatio: (value) => {
      pixelRatio = value;
    },
    getPixelRatio: () => pixelRatio,
    setViewport: (...args) => {
      if (args.length >= 4) {
        viewport.set(Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3]));
      } else if (args[0] instanceof THREE.Vector4) {
        viewport.copy(args[0]);
      }
    },
    getViewport: (target) => target.copy(viewport),
    setScissor: (...args) => {
      if (args.length >= 4) {
        scissor.set(Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3]));
      } else if (args[0] instanceof THREE.Vector4) {
        scissor.copy(args[0]);
      }
    },
    getScissor: (target) => target.copy(scissor),
    setScissorTest: (value) => {
      scissorTest = value;
    },
    getScissorTest: () => scissorTest,
    setClearColor: (...args) => {
      if (args[0] instanceof THREE.Color) {
        clearColor.copy(args[0]);
      } else if (args[0] != null) {
        clearColor.set(args[0] as THREE.ColorRepresentation);
      }
      if (typeof args[1] === "number") {
        clearAlpha = args[1];
      }
    },
    getClearColor: (target) => target.copy(clearColor),
    getClearAlpha: () => clearAlpha,
    clear: () => {},
    setAnimationLoop: () => {},
    dispose: () => {
      void xr.setSession(null);
    },
    initialized: true,
  };
}

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
  private renderer: THREE.WebGPURenderer | XrPoseOnlyRenderer | null = null;
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
  private disableOpenVrHmdPose = false;
  private sessionMode: SupportedSessionMode = "immersive-vr";
  private alphaEnabled = false;
  private layerReadyLogged = false;
  private debugWindowEnabled = false;
  private outputLeftReadbackRing: TextureReadbackRing | null = null;
  private outputRightReadbackRing: TextureReadbackRing | null = null;
  private outputStereoReadbackRing: StereoTextureReadbackRing | null = null;
  private xrFpsCounter = new FpsCounter();
  private frameLogsEnabled = false;
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
  /**
   * When set, at least this many ms between `session.requestAnimationFrame` sim ticks
   * (reduces 200+ Hz sim vs ~75 Hz display judder with `--webxr-openvr-pace=fast`).
   */
  private xrSimTickMinIntervalMs: number | null = null;
  private xrSimTickDelayTimeout: ReturnType<typeof setTimeout> | null = null;
  private openVrOverlayPacer: OpenVrOverlayFramePacer | null = null;
  /**
   * When true, OpenVR pacing + IVRInput + `syncEmulatedDevicePosesToSpaces` run from IWER
   * `onBeforeFrameStart` (see iwer `XRSession.ts`), not from the session rAF tick — Aardvark order.
   */
  private openVrDrivenBeforeIwerFrameStart = false;
  /** Set in `start` from `getCrashOnDroppedFrameMode().xrRaf` (1.85× nominal). */
  private crashOnDroppedXrRaf = false;
  /** Set in `start` from `getCrashOnDroppedFrameMode().xrRafStrict` (default ~1.12× nominal). */
  private crashOnDroppedXrRafStrict = false;
  private xrRafStrictIntervalMult = DEFAULT_XRAF_STRICT_INTERVAL_MULT;
  private logSlowXrFrames = false;
  private lastSlowXrFrameLogAt = 0;
  private xrRafMaxIntervalMs = 0;
  private xrRafSlowFrameCount = 0;
  private vrCompositorPointer: number | bigint | null = null;
  private vrInputPointer: number | bigint | null = null;
  private externalPacerTimestamp = 0;
  private externalPacerFrameSeq = 0;
  private consumedExternalPacerFrameSeq = 0;
  private externalPacerXrTickPending = false;
  private requestExternalPacerXrTick: (() => void) | null = null;
  private externalPacerSyntheticAdvanceTime = 0;
  private useExternalPacerTiming = false;
  private onBeforeExternalControllerApply: (() => void) | undefined;
  private onInProcessControllerFrame: ((data: ExternalControllerData) => void) | undefined;
  private latestShadowPose: {
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
  } | null = null;

  /** Lerp `α` per XR frame toward raw pose position (`--webxr-controller-pos-lerp`, `0` = raw). */
  private readonly emulatedControllerPosLerp = getWebxrControllerPosLerpFromArgs();
  private readonly emulatedControllerMaxHandMps = getWebxrControllerMaxHandMpsFromArgs();
  private readonly raylibDebugControllerCube = getWebxrRaylibControllerDebugEnabled();
  /** App-wide single source of OpenVR HMD + controller pose (allocation-free). */
  private readonly directOpenVrInputSource = new DirectOpenVrInputSource();
  private directRaylibOpenVrHmdPoseLogged = false;
  private emulatedControllerApplyPrevWallAt = 0;
  private readonly emulatedControllerPosLeft = new THREE.Vector3();
  private readonly emulatedControllerPosRight = new THREE.Vector3();
  private readonly emulatedControllerRawPrevLeft = new THREE.Vector3();
  private readonly emulatedControllerRawPrevRight = new THREE.Vector3();
  private emulatedControllerPosInited: { left: boolean; right: boolean } = {
    left: false,
    right: false,
  };
  private readonly tempEmulatedControllerPosTarget = new THREE.Vector3();
  private readonly tempEmulatedControllerRawDelta = new THREE.Vector3();

  async start(options: StartOptions = {}) {
    if (this.running) {
      return;
    }

    if (this.xrSimTickDelayTimeout != null) {
      clearTimeout(this.xrSimTickDelayTimeout);
      this.xrSimTickDelayTimeout = null;
    }
    this.xrSimTickMinIntervalMs = null;

    this.frameCount = 0;
    this.xrFpsCounter.reset();
    this.inspected = false;
    this.inspectionPending = false;
    this.lastInspection = null;
    this.lastError = null;
    this.lastLayerInfo = null;
    this.lastXrCallbackAt = 0;
    this.lastXrSessionRafWallAt = 0;
    this.externalPacerTimestamp = 0;
    this.externalPacerFrameSeq = 0;
    this.consumedExternalPacerFrameSeq = 0;
    this.externalPacerXrTickPending = false;
    this.requestExternalPacerXrTick = null;
    this.externalPacerSyntheticAdvanceTime = 0;
    this.lastSlowXrFrameLogAt = 0;
    this.xrRafMaxIntervalMs = 0;
    this.xrRafSlowFrameCount = 0;
    this.lastHeartbeatAt = 0;
    this.lastFpsLogAt = 0;
    this.lastPerfLogAt = 0;
    this.frameLogsEnabled = getWebxrFrameLogsEnabled();
    this.layerReadyLogged = false;
    this.resetEmulatedControllerPositionSmoothing();
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
    const nominalFromPayload = options.nominalHmdDisplayHz ?? null;
    const nominalFromFallbackCli = nominalFromPayload == null
      ? getWebxrFallbackNominalHzFromArgs()
      : null;
    this.nominalHmdDisplayHz = nominalFromPayload ?? nominalFromFallbackCli ?? null;
    if (nominalFromFallbackCli != null) {
      LogChannel.log(
        "webxrv2",
        `[webxrhost] --webxr-fallback-nominal-hz=${nominalFromFallbackCli} (rAF strict/loose expect ms)`,
      );
    }
    {
      const simFromOpt = options.simTickHz;
      const simFromArg = getWebxrSimTickHzFromArgs();
      const simMode: number | "display" | null = simFromOpt !== undefined ? simFromOpt : simFromArg;
      if (simMode === "display") {
        const nom = this.nominalHmdDisplayHz;
        this.xrSimTickMinIntervalMs = 1000 /
          (nom != null && Number.isFinite(nom) && nom > 0 ? nom : 90);
      } else if (typeof simMode === "number" && simMode > 0) {
        this.xrSimTickMinIntervalMs = 1000 / simMode;
      }
      if (this.xrSimTickMinIntervalMs != null) {
        LogChannel.log(
          "webxrv2",
          `[webxrhost] XR sim tick min ${this.xrSimTickMinIntervalMs.toFixed(2)}ms (~${
            (1000 / this.xrSimTickMinIntervalMs).toFixed(0)
          } Hz) — set --webxr-sim-tick-hz=display or 75 to reduce micro judder when sim (fast pace) outruns the overlay/HMD`,
        );
      }
    }
    this.vrSystemPointer = options.vrSystemPointer ?? null;
    this.vrCompositorPointer = options.vrCompositorPointer ?? null;
    this.vrInputPointer = options.vrInputPointer ?? null;
    if (this.vrInputPointer != null) {
      this.directOpenVrInputSource.initialize(this.vrInputPointer);
    }
    this.disableOpenVrHmdPose = options.disableOpenVrHmdPose ?? false;
    this.onBeforeExternalControllerApply = options.onBeforeExternalControllerApply;
    this.onInProcessControllerFrame = options.onInProcessControllerFrame;
    this.sessionMode = options.sessionMode === "immersive-ar" ? "immersive-ar" : "immersive-vr";
    this.alphaEnabled = options.alpha ?? this.sessionMode === "immersive-ar";
    const useOverlayPacing = options.useOpenVrOverlayFramePacing !== false;
    // Detect raylib mode: if OpenVR pacer is disabled but we have OpenVR pointers, raylib will drive timing
    this.useExternalPacerTiming = !useOverlayPacing &&
      (this.vrSystemPointer != null || this.vrCompositorPointer != null);
    const crashOnDrop = getCrashOnDroppedFrameMode();
    this.crashOnDroppedXrRaf = crashOnDrop.xrRaf;
    this.crashOnDroppedXrRafStrict = crashOnDrop.xrRafStrict;
    this.xrRafStrictIntervalMult = getXrRafStrictIntervalMultiplier();
    this.logSlowXrFrames = getLogSlowXrFrames();
    const openVrPace = options.openVrPace ?? getWebxrOpenVrPaceFromArgs();
    this.openVrOverlayPacer = tryCreateOpenVrOverlayFramePacer(
      this.vrSystemPointer,
      this.vrCompositorPointer,
      useOverlayPacing,
      crashOnDrop.vsync,
      openVrPace,
      "webxrhost-pacer",
    );
    if (crashOnDrop.vsync || crashOnDrop.overlay || crashOnDrop.xrRaf || crashOnDrop.xrRafStrict) {
      LogChannel.log(
        "webxrv2",
        `[webxrhost] --webxr-crash-on-dropped-frame: vsync=${crashOnDrop.vsync} overlay=${crashOnDrop.overlay} xr-raf=${crashOnDrop.xrRaf} xr-raf-strict=${crashOnDrop.xrRafStrict}${
          crashOnDrop.xrRafStrict
            ? ` (mult=${this.xrRafStrictIntervalMult.toFixed(3)} nominal=${
              this.nominalHmdDisplayHz != null
                ? `${this.nominalHmdDisplayHz.toFixed(0)}Hz`
                : "fallback 90Hz"
            })`
            : ""
        }`,
      );
    }
    if (this.logSlowXrFrames) {
      LogChannel.log(
        "webxrv2",
        "[webxrhost] --webxr-log-slow-frames enabled (throttled soft logs)",
      );
    }
    const hostHeartbeatPollMs = 16;
    const nom = this.nominalHmdDisplayHz;
    const polyfillHzOverride = options.webxrPolyfillHz ?? getWebxrPolyfillHzFromArgs();
    if (this.openVrOverlayPacer != null && polyfillHzOverride != null) {
      LogChannel.log(
        "webxrv2",
        "[webxrhost] --webxr-polyfill-hz ignored when OpenVR pacer is active (rAF delay=0; use --webxr-openvr-pace=fast for a higher sim tick rate)",
      );
    }
    const rafPolyfillIntervalMs =
      polyfillHzOverride != null && Number.isFinite(polyfillHzOverride) && polyfillHzOverride > 0
        ? 1000 / polyfillHzOverride
        : nom != null && Number.isFinite(nom) && nom > 0 && nom < 1000
        ? 1000 / nom
        : 16;
    // Use 0ms delay when external pacer is active (raylib mode); the manual loop consumes at
    // most one XR tick per external pacer pulse so this stays low-latency without running ahead.
    const actualPollIntervalMs = this.useExternalPacerTiming ? 0 : rafPolyfillIntervalMs;
    const polyfill: WebXrHostPolyfillOptions = {
      pollIntervalMs: actualPollIntervalMs,
      openVrVsyncDrivesRaf: this.openVrOverlayPacer != null,
    };
    installWebXRHostPolyfills(this.width, this.height, polyfill);
    LogChannel.log(
      "webxrv2",
      `[webxrhost] rAF ` +
        (this.openVrOverlayPacer != null
          ? (openVrPace === "fast"
            ? "OpenVR fast pace (single GetTimeSinceLastVsync; IWER rAF delay=0)"
            : "OpenVR display pacing (Aardvark-style wait for new vsync index; IWER rAF delay=0)")
          : this.useExternalPacerTiming
          ? `external OpenVR pacer (IWER rAF delay=${
            actualPollIntervalMs.toFixed(0)
          }ms; one XR tick per pacer pulse)`
          : `polyfill=${rafPolyfillIntervalMs.toFixed(3)}ms (~${
            (1000 / rafPolyfillIntervalMs).toFixed(1)
          }Hz)`) +
        `; IWER XRSession uses global rAF`,
    );

    try {
      const useRealWebGpuRenderer = !this.skipWebGpuXrDraw;
      let device: GPUDevice | ReturnType<typeof createPoseOnlyGpuDevice>;
      let preferredFormat = "bgra8unorm";
      if (useRealWebGpuRenderer) {
        const adapter = await navigator.gpu.requestAdapter();
        assert(adapter, "No WebGPU adapter available");

        const gpuDevice = await adapter.requestDevice();
        preferredFormat = navigator.gpu.getPreferredCanvasFormat();
        this.device = gpuDevice;
        if (this.readbackMode === "stereo") {
          this.outputStereoReadbackRing = new StereoTextureReadbackRing(gpuDevice, this.ringSize);
        } else {
          this.outputLeftReadbackRing = new TextureReadbackRing(gpuDevice, this.ringSize);
          this.outputRightReadbackRing = new TextureReadbackRing(gpuDevice, this.ringSize);
        }
        gpuDevice.addEventListener("uncapturederror", (event: Event) => {
          const gpuEvent = event as Event & {
            error?: { message?: string; constructor?: { name?: string } };
          };
          const errorName = gpuEvent.error?.constructor?.name ?? "GPUError";
          this.lastError = new Error(
            `Uncaptured WebGPU error (${errorName}): ${gpuEvent.error?.message ?? "unknown"}`,
          );
        });
        device = gpuDevice;
      } else {
        this.device = null;
        device = createPoseOnlyGpuDevice();
      }
      this.overlayUploadFormat = preferredFormat.startsWith("bgra") ? "bgra" : "rgba";

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
        } session=${this.sessionMode} alpha=${
          this.alphaEnabled ? "yes" : "no"
        } capture=${this.captureMode} readback=${this.readbackMode} ringSize=${this.ringSize} queueDebug=${this.queueDebugMode}`,
      );
      const canvas = this.surfaceHost.getCanvas();
      const context = useRealWebGpuRenderer ? this.surfaceHost.getContext() : null;

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
      const xrDevWithHook = this.xrDevice as XrDeviceBridge & {
        setBeforeFrameStartHook?: (cb: ((frame: XRFrame) => void) | null | undefined) => void;
      };
      if (typeof xrDevWithHook.setBeforeFrameStartHook === "function") {
        xrDevWithHook.setBeforeFrameStartHook((frame) => {
          this.applyOpenVrTrackingBeforeIwerOnFrameStart(frame);
        });
        this.openVrDrivenBeforeIwerFrameStart = true;
        LogChannel.log(
          "webxrv2",
          "[webxrhost] IWER onBeforeFrameStart: OpenVR runs before tracked-input onFrameStart (Aardvark order)",
        );
      }
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
          left: () =>
            React.createElement(PetplayDefaultXRController, {
              model: false,
              rayPointer: {
                minDistance: -1,
              },
            }),
        },
      });

      // @ts-expect-error #TODO
      this.root = createRoot(canvas);
      await this.root.configure({
        renderer: (async (props: Record<string, unknown>) => {
          if (!useRealWebGpuRenderer) {
            const renderer = createXrPoseOnlyRenderer(canvas, this.width, this.height);
            renderer.xr.enabled = true;
            renderer.xr.setReferenceSpaceType(getReferenceSpaceType(this.sessionMode));
            renderer.setSize(this.width, this.height);
            this.renderer = renderer;
            LogChannel.log(
              "webxrv2",
              "[webxrhost] using pose-only renderer shim (no WebGPU renderer in raylib-only mode)",
            );
            return renderer;
          }
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

      let sceneMountedResolve!: () => void
      const sceneMounted = new Promise<void>((resolve) => {
        sceneMountedResolve = resolve
      })

      function SceneMountedMarker() {
        React.useLayoutEffect(() => {
          sceneMountedResolve()
        }, [])
        return null
      }

      function NoR3FDefaultRender() {
        useR3FFrame(() => { }, {
          id: "petplay-no-r3f-default-render",
          phase: "render",
        })

        return null
      }

      const rootStore = this.root.render(
        React.createElement(
          XR,
          { store },
          React.createElement(SceneMountedMarker),
          React.createElement(NoR3FDefaultRender), // for the test
          React.createElement(WebXRScene, {
            XROrigin,
            displayInstanceActor: options.displayInstanceActor ?? null,
          }),
        ),
      );
      this.rootStore = rootStore;
      rootStore.getState().xr.disconnect();

      //await wait(0);
      await sceneMounted
      advance(performance.now());
      if (this.debugWindowEnabled) {
        this.surfaceHost.present();
      }

      this.session = await this.enterXrWhenReady(
        store as unknown as {
          enterAR: () => Promise<XRSession>;
          enterVR: () => Promise<XRSession>;
        },
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
            ? ' webgpuSceneDraw=no (raylib-only; use overlay "both"/"webgpu" to draw the projection layer)'
            : ""
        }`,
      );
      this.startManualXrFrameLoop(rootStore, this.device);

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
      xrRafMaxIntervalMs: this.xrRafMaxIntervalMs,
      xrRafSlowFrameCount: this.xrRafSlowFrameCount,
      vsyncDisplayFramesSkipped: this.openVrOverlayPacer?.getFramesSkippedCount() ?? 0,
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
    if (this.xrSimTickDelayTimeout != null) {
      clearTimeout(this.xrSimTickDelayTimeout);
      this.xrSimTickDelayTimeout = null;
    }

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
    this.directOpenVrInputSource.resetInput();
    if (this.xrDevice != null && this.openVrDrivenBeforeIwerFrameStart) {
      const d = this.xrDevice as XrDeviceBridge & {
        setBeforeFrameStartHook?: (cb: ((frame: XRFrame) => void) | null | undefined) => void;
      };
      d.setBeforeFrameStartHook?.(null);
      this.openVrDrivenBeforeIwerFrameStart = false;
    }
    this.xrDevice = null;
    this.sessionMode = "immersive-vr";
    this.alphaEnabled = false;
    this.nominalHmdDisplayHz = null;
    this.vrCompositorPointer = null;
    this.openVrOverlayPacer = null;
    this.externalPacerXrTickPending = false;
    this.requestExternalPacerXrTick = null;
    this.crashOnDroppedXrRaf = false;
    this.crashOnDroppedXrRafStrict = false;
    this.onBeforeExternalControllerApply = undefined;
    this.onInProcessControllerFrame = undefined;
    this.xrSimTickMinIntervalMs = null;
    this.resetEmulatedControllerPositionSmoothing();
  }

  private resetEmulatedControllerPositionSmoothing() {
    this.emulatedControllerPosInited = { left: false, right: false };
    this.emulatedControllerPosLeft.set(0, 0, 0);
    this.emulatedControllerPosRight.set(0, 0, 0);
    this.emulatedControllerRawPrevLeft.set(0, 0, 0);
    this.emulatedControllerRawPrevRight.set(0, 0, 0);
    this.emulatedControllerApplyPrevWallAt = 0;
  }

  private beginEmulatedControllerDataFrame(): number {
    const now = performance.now();
    if (this.emulatedControllerApplyPrevWallAt <= 0) {
      return 1 / 90;
    }
    return Math.max(1e-3, (now - this.emulatedControllerApplyPrevWallAt) / 1000);
  }

  private endEmulatedControllerDataFrame() {
    this.emulatedControllerApplyPrevWallAt = performance.now();
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
      lookRotation: new Float32Array(pose.lookRotation),
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
      ...(this.raylibDebugControllerCube &&
          this.directOpenVrInputSource.hasLeftController()
        ? {
          raylibDebugLeftControllerPosition: new Float32Array(
            this.directOpenVrInputSource.getSnapshot().controllers.left!.position,
          ),
        }
        : {}),
    };
  }

  applyDirectOpenVrShadowPose(openVrHmd: OpenVrHmdEmulationPose | null) {
    if (!openVrHmd || !this.latestShadowPose) {
      return;
    }
    const pose = this.latestShadowPose;
    const directViewer = {
      position: new Float32Array(openVrHmd.position),
      quaternion: new Float32Array(openVrHmd.quaternion),
    };
    const directEyes = this.buildOpenVrDirectEyePoses(openVrHmd.matrix, pose.ipdMeters);
    this.latestShadowPose = {
      ...pose,
      lookRotation: this.getOverlayLookRotationMatrixFromWorldHmd(openVrHmd.matrix),
      viewerPosition: directViewer.position,
      viewerQuaternion: directViewer.quaternion,
      leftEyePosition: directEyes.left.position,
      leftEyeQuaternion: directEyes.left.quaternion,
      leftEyeViewMatrix: directEyes.left.viewMatrix,
      rightEyePosition: directEyes.right.position,
      rightEyeQuaternion: directEyes.right.quaternion,
      rightEyeViewMatrix: directEyes.right.viewMatrix,
    };
  }

  /**
   * Forward to {@link DirectOpenVrInputSource.update}. Thin wrapper so callers
   * don't need a direct reference to the source. Allocation-free.
   */
  updateDirectOpenVrInputs(
    hmd: OpenVrHmdEmulationPose | null,
    leftController: OpenVrHmdEmulationPose | null,
    rightController: OpenVrHmdEmulationPose | null,
  ): void {
    this.directOpenVrInputSource.update(hmd, leftController, rightController);
  }

  /**
   * Read-only snapshot accessor for downstream consumers. The returned
   * snapshot identity is stable across frames; its inner `Float32Array` fields
   * are shared mutating buffers. Not yet wired to r3f.
   */
  getDirectOpenVrInputs(): DirectOpenVrInputSnapshot {
    return this.directOpenVrInputSource.getSnapshot();
  }

  /** Direct access to the shared source instance for consumers that need its helpers. */
  getDirectOpenVrInputSource(): DirectOpenVrInputSource {
    return this.directOpenVrInputSource;
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
    device: GPUDevice | null,
  ) {
    if (!this.session || this.xrFrameRequestActive) {
      return;
    }

    this.xrFrameRequestActive = true;
    let tick: (time: number, frame: XRFrame) => void;
    const requestNextTick = (delayMs = 0) => {
      if (!this.running || !this.session) {
        this.xrFrameRequestActive = false;
        this.externalPacerXrTickPending = false;
        return;
      }
      if (delayMs <= 0) {
        if (this.useExternalPacerTiming) {
          this.externalPacerXrTickPending = true;
        }
        this.session.requestAnimationFrame(tick);
        return;
      }
      this.xrSimTickDelayTimeout = setTimeout(() => {
        this.xrSimTickDelayTimeout = null;
        if (this.useExternalPacerTiming) {
          this.externalPacerXrTickPending = true;
        }
        this.session?.requestAnimationFrame(tick);
      }, delayMs);
    };
    this.requestExternalPacerXrTick = () => {
      if (
        !this.running || !this.session || !this.useExternalPacerTiming ||
        this.externalPacerXrTickPending
      ) {
        return;
      }
      requestNextTick();
    };
    tick = (time: number, frame: XRFrame) => {
      const tickT0 = performance.now();
      if (!this.running || !this.session) {
        this.xrFrameRequestActive = false;
        this.externalPacerXrTickPending = false;
        return;
      }

      if (this.useExternalPacerTiming) {
        this.externalPacerXrTickPending = false;
        const hasUnconsumedPacerPulse =
          this.externalPacerFrameSeq !== this.consumedExternalPacerFrameSeq;
        const pacerAgeMs = this.externalPacerTimestamp > 0
          ? tickT0 - this.externalPacerTimestamp
          : Number.POSITIVE_INFINITY;
        if (!hasUnconsumedPacerPulse || pacerAgeMs > 25) {
          if (pacerAgeMs > 25) {
            this.consumedExternalPacerFrameSeq = this.externalPacerFrameSeq;
          }
          return;
        }
        this.consumedExternalPacerFrameSeq = this.externalPacerFrameSeq;
      }

      if (!this.running || !this.session) {
        this.xrFrameRequestActive = false;
        this.externalPacerXrTickPending = false;
        return;
      }

      // OpenVR pacing + IVRInput: when IWER exposes `setBeforeFrameStartHook`, they run in
      // `applyOpenVrTrackingBeforeIwerOnFrameStart` **before** `XRTrackedInput.onFrameStart`
      // (see iwer `XRSession.ts`). Otherwise keep the legacy path here (older iwer build).
      if (!this.openVrDrivenBeforeIwerFrameStart) {
        this.openVrOverlayPacer?.paceToDisplayAndRefreshPoses();
        this.openVrOverlayPacer?.maybeLogFps();
        this.onBeforeExternalControllerApply?.();
        const tHmd = performance.now();
        this.updateEmulatedHeadsetFromOpenVr();
        this.xrHmdEmulationMetric.record(performance.now() - tHmd);
        this.directOpenVrInputSource.updateActionState();
        const tCtrl = performance.now();
        this.applyExternalControllerData();
        this.xrControllerApplyMetric.record(performance.now() - tCtrl);
        this.syncIwerEmulatedPosesToSpaces();
      }

      const wallNow = performance.now();
      const nom = this.nominalHmdDisplayHz;
      const expectedMs = nom != null && nom > 0 && Number.isFinite(nom) ? 1000 / nom : 1000 / 90;
      const rafIntervalMs = this.lastXrSessionRafWallAt > 0
        ? wallNow - this.lastXrSessionRafWallAt
        : 0;
      if (rafIntervalMs > 0 && this.frameCount >= WEBXR_CRASH_ON_DROP_WARMUP_FRAMES) {
        if (this.crashOnDroppedXrRafStrict) {
          const limitMs = expectedMs * this.xrRafStrictIntervalMult;
          if (rafIntervalMs > limitMs) {
            throw new Error(
              `[webxrhost] XR rAF strict: interval ${rafIntervalMs.toFixed(2)}ms > ${
                limitMs.toFixed(2)
              }ms ` +
                `(${this.xrRafStrictIntervalMult.toFixed(3)}× nominal ${
                  expectedMs.toFixed(2)
                }ms; ` +
                `~${(1000 / rafIntervalMs).toFixed(1)} Hz effective vs ${
                  nom != null && nom > 0 && Number.isFinite(nom) ? `${nom.toFixed(0)}` : "90"
                } Hz nominal)`,
            );
          }
        }
        if (this.crashOnDroppedXrRaf) {
          const limitMs = expectedMs * 1.85;
          if (rafIntervalMs > limitMs) {
            throw new Error(
              `[webxrhost] XR rAF wall gap ${rafIntervalMs.toFixed(2)}ms > ${
                limitMs.toFixed(1)
              }ms ` +
                `(~${(1000 / rafIntervalMs).toFixed(1)} Hz effective vs nominal ${
                  nom?.toFixed(0) ?? "90"
                } Hz)`,
            );
          }
        }
      }
      if (rafIntervalMs > 0 && this.frameCount >= WEBXR_CRASH_ON_DROP_WARMUP_FRAMES) {
        this.xrRafMaxIntervalMs = Math.max(this.xrRafMaxIntervalMs, rafIntervalMs);
        if (rafIntervalMs > expectedMs * 1.25) {
          this.xrRafSlowFrameCount++;
        }
        if (
          this.logSlowXrFrames &&
          rafIntervalMs > expectedMs * 1.3 &&
          wallNow - this.lastSlowXrFrameLogAt >= 400
        ) {
          this.lastSlowXrFrameLogAt = wallNow;
          LogChannel.log(
            "webxrv2",
            `[webxrhost] slow XR rAF interval ${rafIntervalMs.toFixed(1)}ms (nominal ${
              expectedMs.toFixed(2)
            }ms; ~${(1000 / rafIntervalMs).toFixed(0)} Hz effective) frameCount=${this.frameCount}`,
          );
        }
      }
      if (this.lastXrSessionRafWallAt > 0) {
        this.xrSessionRafWallIntervalMetric.record(rafIntervalMs);
      }
      this.lastXrSessionRafWallAt = wallNow;
      this.lastXrCallbackAt = wallNow;
      const advanceStartedAt = wallNow;
      // R3F v10's scheduler-based advance() doesn't forward the XRFrame to
      // useFrame callbacks; stash it on the bridge so our useFrame shim can
      // inject it as the third arg downstream.
      currentXRFrame.value = frame;
      (this.renderer as XrPoseOnlyRenderer | null)?.xr?.updateFromFrame?.(frame);
      const t2 = performance.now();
      try {
        advance(this.getAdvanceTimestamp(time, expectedMs));
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
      if (this.frameLogsEnabled && this.lastXrCallbackAt - this.lastFpsLogAt >= 1000) {
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

      if (device && !this.inspected && !this.inspectionPending && this.frameCount >= 3) {
        this.inspectionPending = true;
        void this.inspectProjectionLayer(device).finally(() => {
          this.inspectionPending = false;
        });
      }

      const minInterval = this.xrSimTickMinIntervalMs;
      if (this.useExternalPacerTiming) {
        // External Raylib/OpenVR mode is edge-triggered by `signalExternalPacerAdvanced`.
        // Do not poll here; even a 1ms timer loop can disturb the pacer's wait-for-vsync cadence.
      } else if (minInterval == null) {
        requestNextTick();
      } else {
        const wait = Math.max(0, minInterval - (performance.now() - tickT0));
        requestNextTick(wait);
      }
    };

    if (this.useExternalPacerTiming) {
      if (this.externalPacerFrameSeq !== this.consumedExternalPacerFrameSeq) {
        this.requestExternalPacerXrTick?.();
      }
    } else {
      requestNextTick();
    }
  }

  /**
   * Signal that an external pacer (e.g., raylib overlay) has advanced to a new frame.
   * Used to synchronize webxrhost's rAF loop with the external pacer's timing.
   */
  signalExternalPacerAdvanced(): void {
    this.externalPacerTimestamp = performance.now();
    this.externalPacerFrameSeq++;
    this.requestExternalPacerXrTick?.();
  }

  private getAdvanceTimestamp(time: number, expectedMs: number): number {
    if (!this.useExternalPacerTiming) {
      return time;
    }
    if (this.externalPacerSyntheticAdvanceTime === 0) {
      this.externalPacerSyntheticAdvanceTime = time;
      return time;
    }
    const stepMs = expectedMs > 0 && Number.isFinite(expectedMs) ? expectedMs : 1000 / 90;
    this.externalPacerSyntheticAdvanceTime += stepMs;
    return this.externalPacerSyntheticAdvanceTime;
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
    if (!this.frameLogsEnabled) {
      return;
    }
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
      !rafWallSample && !advanceSample && !hmdSample && !controllerSample && !r3fSample &&
      !poseSample &&
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
        `ctrl=${controllerSample.avgMs.toFixed(2)}ms avg ${
          controllerSample.maxMs.toFixed(2)
        }ms max`,
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

  private syncIwerEmulatedPosesToSpaces() {
    if (!this.xrDevice) {
      return;
    }
    const dev = this.xrDevice as unknown as { syncEmulatedDevicePosesToSpaces?: () => void };
    // Must call as `dev.method()` so `this` inside IWER stays the XRDevice (extracting
    // the function and doing `fn()` breaks `this[P_DEVICE]` and throws).
    dev.syncEmulatedDevicePosesToSpaces?.();
  }

  /**
   * IWER `XRSession.onDeviceFrame`: runs after `XRFrame` is created, **before**
   * `device.onFrameStart` → `XRTrackedInput.applyPoseToTargetRaySpace` (see iwer source).
   * Mirrors Aardvark `runFrame`: `updateOpenVrPoses` then `doInputWork` before any use of poses.
   */
  private applyOpenVrTrackingBeforeIwerOnFrameStart(_frame: XRFrame): void {
    if (!this.session) {
      return;
    }
    this.openVrOverlayPacer?.paceToDisplayAndRefreshPoses();
    this.openVrOverlayPacer?.maybeLogFps();
    this.onBeforeExternalControllerApply?.();
    const tHmd = performance.now();
    this.updateEmulatedHeadsetFromOpenVr();
    this.xrHmdEmulationMetric.record(performance.now() - tHmd);
    this.directOpenVrInputSource.updateActionState();
    const tCtrl = performance.now();
    this.applyExternalControllerData();
    this.xrControllerApplyMetric.record(performance.now() - tCtrl);
    this.syncIwerEmulatedPosesToSpaces();
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
    if (this.disableOpenVrHmdPose) {
      return null;
    }
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
    const hmdPose = OpenVR.TrackedDevicePoseStruct.read(
      poseView,
    ) as unknown as OpenVR.TrackedDevicePose;
    if (!hmdPose.bPoseIsValid) {
      return null;
    }

    const m = hmdPose.mDeviceToAbsoluteTracking.m;
    return {
      matrix: new Float32Array([
        m[0][0],
        m[1][0],
        m[2][0],
        0,
        m[0][1],
        m[1][1],
        m[2][1],
        0,
        m[0][2],
        m[1][2],
        m[2][2],
        0,
        m[0][3],
        m[1][3],
        m[2][3],
        1,
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
    let left = this.objectWorldTransformToPose(leftCamera);
    let right = this.objectWorldTransformToPose(rightCamera);
    const ipdMeters = Math.hypot(
      right.position[0] - left.position[0],
      right.position[1] - left.position[1],
      right.position[2] - left.position[2],
    );
    const openVrHmd = this.openVrOverlayPacer?.getCachedHmdEmulation() ?? null;
    const directViewer = openVrHmd
      ? {
        position: new Float32Array(openVrHmd.position),
        quaternion: new Float32Array(openVrHmd.quaternion),
      }
      : viewer;
    if (openVrHmd) {
      const directEyes = this.buildOpenVrDirectEyePoses(
        openVrHmd.matrix,
        ipdMeters,
      );
      left = directEyes.left;
      right = directEyes.right;
      if (!this.directRaylibOpenVrHmdPoseLogged) {
        this.directRaylibOpenVrHmdPoseLogged = true;
        LogChannel.log(
          "webxrv2",
          "[webxrhost] Raylib shadow camera uses direct OpenVR HMD pose",
        );
      }
    }

    this.latestShadowPose = {
      lookRotation: openVrHmd
        ? this.getOverlayLookRotationMatrixFromWorldHmd(openVrHmd.matrix)
        : this.getOverlayLookRotationMatrixFromQuaternion(directViewer.quaternion),
      viewerPosition: directViewer.position,
      viewerQuaternion: directViewer.quaternion,
      leftEyePosition: left.position,
      leftEyeQuaternion: left.quaternion,
      leftEyeViewMatrix: left.viewMatrix ??
        new Float32Array(new THREE.Matrix4().copy(leftCamera.matrixWorld).invert().elements),
      leftEyeProjectionMatrix: new Float32Array(leftCamera.projectionMatrix.elements),
      rightEyePosition: right.position,
      rightEyeQuaternion: right.quaternion,
      rightEyeViewMatrix: right.viewMatrix ??
        new Float32Array(new THREE.Matrix4().copy(rightCamera.matrixWorld).invert().elements),
      rightEyeProjectionMatrix: new Float32Array(rightCamera.projectionMatrix.elements),
      halfFovInRadians: this.projectionMatrixToHalfFovInRadians(
        leftCamera.projectionMatrix.elements,
      ),
      ipdMeters,
    };
  }

  private buildOpenVrDirectEyePoses(worldFromHmdValues: Float32Array, ipdMeters: number) {
    const worldFromHmd = new THREE.Matrix4().fromArray(worldFromHmdValues as unknown as number[]);
    const left = this.matrixWorldToPose(
      new THREE.Matrix4().copy(worldFromHmd).multiply(
        new THREE.Matrix4().makeTranslation(-ipdMeters * 0.5, 0, 0),
      ),
    );
    const right = this.matrixWorldToPose(
      new THREE.Matrix4().copy(worldFromHmd).multiply(
        new THREE.Matrix4().makeTranslation(ipdMeters * 0.5, 0, 0),
      ),
    );
    return { left, right };
  }

  private objectWorldTransformToPose(object: THREE.Object3D) {
    object.updateMatrixWorld(true);
    return this.matrixWorldToPose(object.matrixWorld);
  }

  private matrixWorldToPose(matrix: THREE.Matrix4) {
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(position, quaternion, scale);
    return {
      position: new Float32Array([position.x, position.y, position.z]),
      quaternion: new Float32Array([quaternion.x, quaternion.y, quaternion.z, quaternion.w]),
      viewMatrix: new Float32Array(new THREE.Matrix4().copy(matrix).invert().elements),
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

    this.updateEmulatedControllersFromOpenVr();
  }

  private updateEmulatedControllersFromOpenVr() {
    if (!this.xrDevice?.controllers) {
      return;
    }

    const snapshot = this.directOpenVrInputSource.getSnapshot();
    const stepDt = this.beginEmulatedControllerDataFrame();
    try {
      const leftPoseData: OpenVrPoseActionData = snapshot.controllers.left
        ? {
          bActive: 1,
          activeOrigin: 0n,
          pose: {
            mDeviceToAbsoluteTracking: {
              m: this.quaternionToMatrix3x4(
                snapshot.controllers.left.quaternion,
                snapshot.controllers.left.position,
              ),
            },
            vVelocity: { v: [0, 0, 0] },
            vAngularVelocity: { v: [0, 0, 0] },
            eTrackingResult: 0,
            bPoseIsValid: 1,
            bDeviceIsConnected: 1,
          },
        }
        : {
          bActive: 0,
          activeOrigin: 0n,
          pose: {
            mDeviceToAbsoluteTracking: { m: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] },
            vVelocity: { v: [0, 0, 0] },
            vAngularVelocity: { v: [0, 0, 0] },
            eTrackingResult: 0,
            bPoseIsValid: 0,
            bDeviceIsConnected: 0,
          },
        };

      const rightPoseData: OpenVrPoseActionData = snapshot.controllers.right
        ? {
          bActive: 1,
          activeOrigin: 0n,
          pose: {
            mDeviceToAbsoluteTracking: {
              m: this.quaternionToMatrix3x4(
                snapshot.controllers.right.quaternion,
                snapshot.controllers.right.position,
              ),
            },
            vVelocity: { v: [0, 0, 0] },
            vAngularVelocity: { v: [0, 0, 0] },
            eTrackingResult: 0,
            bPoseIsValid: 1,
            bDeviceIsConnected: 1,
          },
        }
        : {
          bActive: 0,
          activeOrigin: 0n,
          pose: {
            mDeviceToAbsoluteTracking: { m: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] },
            vVelocity: { v: [0, 0, 0] },
            vAngularVelocity: { v: [0, 0, 0] },
            eTrackingResult: 0,
            bPoseIsValid: 0,
            bDeviceIsConnected: 0,
          },
        };

      const leftTriggerData: OpenVrDigitalActionData = {
        bActive: snapshot.controllers.left ? 1 : 0,
        activeOrigin: 0n,
        bState: snapshot.controllers.left?.trigger ?? 0,
        bChanged: 0,
        fUpdateTime: 0,
      };
      const rightTriggerData: OpenVrDigitalActionData = {
        bActive: snapshot.controllers.right ? 1 : 0,
        activeOrigin: 0n,
        bState: snapshot.controllers.right?.trigger ?? 0,
        bChanged: 0,
        fUpdateTime: 0,
      };
      const leftGrabData: OpenVrDigitalActionData = {
        bActive: snapshot.controllers.left ? 1 : 0,
        activeOrigin: 0n,
        bState: snapshot.controllers.left?.grab ?? 0,
        bChanged: 0,
        fUpdateTime: 0,
      };
      const rightGrabData: OpenVrDigitalActionData = {
        bActive: snapshot.controllers.right ? 1 : 0,
        activeOrigin: 0n,
        bState: snapshot.controllers.right?.grab ?? 0,
        bChanged: 0,
        fUpdateTime: 0,
      };

      const frameTuple: ExternalControllerData = [
        leftPoseData,
        rightPoseData,
        leftTriggerData,
        rightTriggerData,
        leftGrabData,
        rightGrabData,
      ];
      this.onInProcessControllerFrame?.(frameTuple);

      this.updateControllerState(
        this.xrDevice.controllers.left,
        "left",
        leftPoseData,
        leftTriggerData,
        leftGrabData,
        stepDt,
      );
      this.updateControllerState(
        this.xrDevice.controllers.right,
        "right",
        rightPoseData,
        rightTriggerData,
        rightGrabData,
        stepDt,
      );
    } finally {
      this.endEmulatedControllerDataFrame();
    }
  }

  private quaternionToMatrix3x4(
    quaternion: Float32Array,
    position: Float32Array,
  ): [
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
  ] {
    const x = quaternion[0];
    const y = quaternion[1];
    const z = quaternion[2];
    const w = quaternion[3];

    const xx = x * x;
    const yy = y * y;
    const zz = z * z;
    const xy = x * y;
    const xz = x * z;
    const yz = y * z;
    const wx = w * x;
    const wy = w * y;
    const wz = w * z;

    return [
      [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), position[0]],
      [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), position[1]],
      [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy), position[2]],
    ];
  }

  private updateControllerState(
    controller: XrControllerBridge | undefined,
    handedness: "left" | "right",
    poseData: OpenVrPoseActionData,
    triggerData: OpenVrDigitalActionData,
    grabData: OpenVrDigitalActionData,
    stepDtSec: number,
  ) {
    if (!controller) {
      return;
    }

    const pose = poseData?.pose;
    const tracking = pose?.mDeviceToAbsoluteTracking?.m;
    const isConnected = Boolean(poseData?.bActive) && Boolean(pose?.bPoseIsValid) &&
      Array.isArray(tracking);
    controller.connected = isConnected;
    controller.updateButtonValue?.("trigger", triggerData?.bState ? 1 : 0);
    controller.updateButtonValue?.("squeeze", grabData?.bState ? 1 : 0);
    if (!isConnected) {
      if (handedness === "left") {
        this.emulatedControllerPosInited.left = false;
      } else {
        this.emulatedControllerPosInited.right = false;
      }
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
    const rawX = m[0][3];
    const rawY = m[1][3];
    const rawZ = m[2][3];
    const lerpA = this.emulatedControllerPosLerp;
    const vMax = this.emulatedControllerMaxHandMps;
    const lastRaw = handedness === "left"
      ? this.emulatedControllerRawPrevLeft
      : this.emulatedControllerRawPrevRight;
    const smooth = handedness === "left"
      ? this.emulatedControllerPosLeft
      : this.emulatedControllerPosRight;
    const inited = handedness === "left"
      ? this.emulatedControllerPosInited.left
      : this.emulatedControllerPosInited.right;
    let tx = rawX;
    let ty = rawY;
    let tz = rawZ;
    if (vMax > 0 && inited) {
      this.tempEmulatedControllerRawDelta.set(
        rawX - lastRaw.x,
        rawY - lastRaw.y,
        rawZ - lastRaw.z,
      );
      const maxDelta = vMax * stepDtSec;
      const dLen = this.tempEmulatedControllerRawDelta.length();
      if (dLen > maxDelta && dLen > 1e-20) {
        this.tempEmulatedControllerRawDelta.multiplyScalar(maxDelta / dLen);
        tx = lastRaw.x + this.tempEmulatedControllerRawDelta.x;
        ty = lastRaw.y + this.tempEmulatedControllerRawDelta.y;
        tz = lastRaw.z + this.tempEmulatedControllerRawDelta.z;
      }
    }
    lastRaw.set(rawX, rawY, rawZ);
    if (lerpA <= 0) {
      controller.position?.set?.(tx, ty, tz);
    } else if (!inited) {
      smooth.set(tx, ty, tz);
      controller.position?.set?.(smooth.x, smooth.y, smooth.z);
    } else {
      this.tempEmulatedControllerPosTarget.set(tx, ty, tz);
      smooth.lerp(this.tempEmulatedControllerPosTarget, lerpA);
      controller.position?.set?.(smooth.x, smooth.y, smooth.z);
    }
    if (handedness === "left") {
      this.emulatedControllerPosInited.left = true;
    } else {
      this.emulatedControllerPosInited.right = true;
    }
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

    if (!quatValues) {
      return new Float32Array(new THREE.Matrix4().identity().elements);
    }

    return this.getOverlayLookRotationMatrixFromQuaternion(quatValues);
  }

  private getOverlayLookRotationMatrixFromQuaternion(quatValues: ArrayLike<number>): Float32Array {
    const worldFromHmd = new THREE.Matrix4().makeRotationFromQuaternion(
      new THREE.Quaternion(
        Number(quatValues[0] ?? 0),
        Number(quatValues[1] ?? 0),
        Number(quatValues[2] ?? 0),
        Number(quatValues[3] ?? 1),
      ),
    );
    return this.getOverlayLookRotationMatrixFromWorldHmd(
      new Float32Array(worldFromHmd.elements),
    );
  }

  private getOverlayLookRotationMatrixFromWorldHmd(
    worldFromHmdValues: ArrayLike<number>,
  ): Float32Array {
    const hmdFromWorld = new THREE.Matrix4()
      .fromArray(worldFromHmdValues as unknown as number[])
      .invert();
    const zFlip = new THREE.Matrix4().makeScale(1, 1, -1);
    const lookRotation = new THREE.Matrix4();
    lookRotation.multiplyMatrices(hmdFromWorld, zFlip);
    return new Float32Array(lookRotation.elements);
  }
}
