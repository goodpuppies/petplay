/**
 * Decoupled desktop view: a raylib **window** that renders the `webxr` scene's IR.
 *
 * The scene, its update loop and its XR session live in the `webxr` worker. This
 * actor owns nothing but a window: it receives `WebXRRaythreeRenderPayload`
 * (`WEBXRVIEWFRAME`), rasterizes it with `WebXRRaythreeRaylibRenderer` straight
 * into its own framebuffer, and re-draws the latest payload at its own rate. So a
 * VR session and a desktop window can show the same scene at the same time, at
 * independent render rates, with exactly one scene update between them.
 *
 * Unlike the interactive desktop control surface (`desktopControlSurface.tsx`,
 * which mounts a second `WebXRScene`), this view holds no React tree, no spatial
 * graph and no pointer handles: it is a pure IR consumer. It is a **preview** and
 * takes no viewpoint input — moving the shared viewpoint from here would shift
 * the rendered XR view while the OpenVR overlays (placed in absolute tracking
 * space) stayed put, desyncing the two coordinate frames.
 *
 * `STARTDESKTOPVIEW { capturePath, hidden, width, height }` renders it headless:
 * wait for the first IR frame, draw it, write one PNG through the same screen
 * capture path and close. That is how `client capture` takes a screenshot with no
 * preview window left running.
 *
 * `camera: "vrc"` renders from the calibrated VRChat user camera instead of the headset,
 * into a transparent window with no FPS counter: the PetPlay layer of a recording,
 * captured by OBS (PipeWire window capture keeps alpha) and stacked over VRChat's own
 * camera output. Calibration lives in the scene (`STARTVRCCAMERACALIBRATION`); until it
 * exists the window stays fully transparent.
 * `depthDebug: true` adds live-depth/head-pose visuals and OSC fly-camera controls to that same
 * transparent window. It can be toggled in place; recording mode restores mouse passthrough.
 *
 * Runs as a child OS process (`{ worker: "process" }`) so the window's GL context
 * and event loop stay out of the host process, matching `displayOverlayHost`.
 */
import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import raylib from "../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import { getRaylibLibraryPath } from "../classes/nativeLibraryPaths.ts";
import { WebXRRaythreeRaylibRenderer } from "../classes/webxrRaythreeRaylibRenderer.ts";
import type { WebXRRaythreeRenderPayload } from "../classes/webxrRaythreeScene.ts";
import {
  getScreenCaptureStatus,
  hasPendingScreenCapture,
  requestScreenCapture,
  runPendingScreenCapture,
} from "../classes/environment/screenCapture.ts";
import { getAgentReplBaseUrl, wait } from "../classes/utils.ts";
import { OverlaySceneInbox } from "../classes/overlaySceneDelivery.ts";
import {
  OVERLAY_SCENE_WIRE_FORMAT,
  type OverlayScenePacket,
  OverlaySceneWireDecoder,
} from "../classes/overlaySceneWire.ts";
import * as THREE from "three";
import { SharedDepthFrames, type SharedFrameNotice } from "../classes/vrchatDepth/sharedFrames.ts";
import { DepthLatencyTracker } from "../classes/vrchatDepth/latency.ts";
import {
  type CameraControlEndpoint,
  DirectCameraControl,
} from "../classes/vrchatDepth/directCameraControl.ts";
import {
  debugFrameFromRaw,
  debugFrameFromSource,
  type VrcDepthDebugFrame,
  VrcDepthDebugView,
} from "../classes/vrchatDepth/debugView.ts";
import type { VrcDepthFramePayload } from "../classes/vrchatDepth/wire.ts";
import { cameraWorldPose, headWorldPose } from "../classes/vrchatDepth/sync.ts";
import { foregroundCamera } from "../classes/vrchatDepth/foreground.ts";
import { GpuDepthSource } from "../classes/vrchatDepth/gpuDepthSource.ts";
import { lightingDebugLine, parseLighting } from "../classes/vrchatDepth/lighting.ts";
import {
  environmentFromRecord,
  setEnvironmentLighting,
} from "../classes/vrchatDepth/environmentLighting.ts";
import { lightVolumeCache } from "../classes/vrchatDepth/lightVolumes.ts";
import { DriverEyeView } from "../classes/vrchatDepth/driverEyeView.ts";
import {
  cameraPoseFromWorld,
  type FlyCameraInput,
  stepFlyCamera,
} from "../classes/vrchatDepth/flyCamera.ts";
import type { VrcWorldCameraPose } from "../classes/vrcCameraCalibration.ts";

export type StartDesktopViewPayload = {
  x?: number;
  y?: number;
  /** Interactive OSC fly-camera and local live-depth view. */
  depthDebug?: boolean;
  depthForeground?: boolean;
  depthVisuals?: boolean;
  /** Capture VRChat's window as a GL texture instead of through ffmpeg (default true). */
  gpuCapture?: boolean;
  /** Draw the captured VRChat frame behind PetPlay, so both come from one frame (default true). */
  depthComposite?: boolean;
  depthShadows?: boolean;
  depthLightVolumes?: boolean;
  depthLightVolumeStrength?: number;
  cameraOriginTarget?: string | null;
  depthTarget?: string | null;
  flySpeed?: number;
  /** `webxr` actor id to register with (frames + camera offset). */
  webxrTarget?: string | null;
  width?: number;
  height?: number;
  /** Target frames per second; 0 = uncapped (raylib `SetTargetFPS`). */
  fps?: number;
  /** Draw an IR/payload diagnostics line into the window. */
  diagnostics?: boolean;
  title?: string;
  /** One-shot: write this PNG once a frame has been drawn, then close the window. */
  capturePath?: string | null;
  /** Create the window hidden — used by the one-shot capture path. */
  hidden?: boolean;
  /** Viewpoint: the headset's left eye (default) or the calibrated VRChat camera. */
  camera?: "headset" | "vrc";
  /**
   * VR's depth source without a desktop window: a hidden window whose GL context runs the GPU
   * capture (`gpuDepthSource.ts`) and forwards frames to the intake (`depthTarget`), as a
   * background lease holder the debug view can take over. Draws nothing, registers no scene view.
   */
  captureOnly?: boolean;
  /** Vertical FOV for `camera: "vrc"` when VRChat has not reported its zoom. */
  fovYDeg?: number;
};

/** Stable renderer context id: asset sync is incremental per id. */
const RENDER_CONTEXT_ID = "desktop-decoupled-view";
/** Yield between draws so incoming scenes can be decoded and cached. */
const LOOP_SLEEP_MS = 1;
/** Loop sleep while there is nothing new to draw; only window events are polled. */
const IDLE_LOOP_SLEEP_MS = 4;
/** `captureOnly` polling: VRChat redraws at most every ~11 ms; 2 ms keeps the added delay small. */
const CAPTURE_ONLY_SLEEP_MS = 2;
/** An unchanged payload is still redrawn this often, so the window never shows stale damage. */
const IDLE_REDRAW_MS = 250;
/** One-shot captures wait this long for a payload carrying geometry before giving up on it. */
const CAPTURE_FALLBACK_MS = 5_000;
/** Silence this long after receiving frames means the scene's view registry was rebuilt. */
const VIEW_REREGISTER_AFTER_MS = 5_000;
const TRANSPARENT = { r: 0, g: 0, b: 0, a: 0 };
const VRC_CAMERA_NEAR_METERS = 0.03;
const VRC_CAMERA_FAR_METERS = 500;

const state = actorState({
  name: "desktop_view",
  running: false,
  stopRequested: false,
  lastError: null as string | null,
  webxrTarget: null as string | null,
  registered: false,
  width: 1280,
  height: 720,
  fps: 120,
  title: "PetPlay Desktop View",
  /** Payloads received from the scene / rendered in the window / acked back. */
  framesReceived: 0,
  framesRendered: 0,
  framesAcked: 0,
  /** Payloads that arrived while one was still in flight renderer-side. */
  lastRenderMs: 0,
  lastWindowFps: 0,
  /** One-shot capture request (path), what it wrote, and whether the window is hidden. */
  capturePath: null as string | null,
  captureWritten: null as string | null,
  hidden: false,
  /** What the last received IR frame actually carried; the view's own diagnostics. */
  lastPayload: null as {
    instances: number;
    geometries: number;
    materials: number;
    textures: number;
    lights: number;
    panels: number;
    texts: number;
    frameCount: number;
  } | null,
  /** Cumulative asset batches the view has received (priming + deltas). */
  assetsSeen: { geometries: 0, materials: 0, textures: 0 },
  /** Draw the IR/payload diagnostics line into the window. */
  diagnostics: false,
  camera: "headset" as "headset" | "vrc",
  depthDebug: false,
  /** `captureOnly`: GPU depth capture for VR, no drawing (fixed for the window's lifetime). */
  captureOnly: false,
  depthForeground: true,
  depthVisuals: false,
  gpuCapture: true,
  depthComposite: true,
  /** PetPlay's objects cast shadows onto VRChat's surfaces from VRChat's light (H toggles). */
  depthShadows: true,
  depthLightVolumes: true,
  depthLightVolumeStrength: 1,
  cameraOriginTarget: null as string | null,
  depthTarget: null as string | null,
  flySpeed: 3,
  startPosition: null as [number, number] | null,
  fovYDeg: 45,
  /** `camera: "vrc"`: whether the last frame carried a calibrated camera. */
  vrcCameraCalibrated: false,
  loop: null as Promise<void> | null,
});

/** Latest IR to draw; replaced as frames arrive, never queued. */
let latestPayload: WebXRRaythreeRenderPayload | null = null;
let latestSeq = 0;
let renderedSeq = 0;
let lastFrameAt = 0;
let sceneInbox = new OverlaySceneInbox();
let wireDecoder = new OverlaySceneWireDecoder();
/** Set when the webxr scene stream restarts; the window loop then replaces its renderer. */
let sceneStreamChanged = false;
let sceneStreamResets = 0;
let lastDecodeMs = 0;
let lastPacketBytes = 0;
let lastEndDrawingMs = 0;
let depthView: VrcDepthDebugView | null = null;
let depthRenderer: WebXRRaythreeRaylibRenderer | null = null;
let flyPose: VrcWorldCameraPose | null = null;
let flyControlled = false;
let flySentAt = 0;
let flyLastInputAt = 0;
let flyPending = false;
let lastDebugFrame: VrcDepthDebugFrame | null = null;
let directDepthRevision = 0;
let depthRenderedRevision = -1;
let directDepthFrames = 0;
let captureWorker: Worker | null = null;
let sharedFrames: SharedDepthFrames | null = null;
let captureOwner: string | null = null;
let captureStart: Promise<void> | null = null;
let captureStopped: (() => void) | null = null;
let captureError: string | null = null;
let sharedDepthFrames = 0;
/** GPU capture on the render thread (`state.gpuCapture`); the worker then only forwards frames. */
let gpuDepth: GpuDepthSource | null = null;
let gpuStatusAt = 0;
let captureStop: Promise<void> | null = null;
const depthLatency = new DepthLatencyTracker();
let drawnDepthRevision = -1;
let commandError: string | null = null;
let directCameraControl: DirectCameraControl | null = null;
let playerControlMode = false;
let driverEyeView: DriverEyeView | null = null;
let playerInputSignature = "";
let playerInputSentAt = 0;
let playerTrigger = false;
let playerTriggerPending = Promise.resolve();
const playerInputs = ["Vertical", "Horizontal", "LookHorizontal", "Jump", "Run", "UseRight", "GrabRight"];

async function resetPlayerHandAim() {
  // This debug helper only attaches when the synthetic lab is configured; it never
  // overrides a real tracked controller. Close the proxy after the one-shot pose change.
  const { SyntheticDriver } = await import("../utils/vrlab/driver.ts");
  const driver = await SyntheticDriver.attach();
  try {
    await driver.setPose("right", { position: [0, 1.6, -0.7], rotation: [0.34289780745545134, 0, 0, 0.9393727128473789] });
    await driver.setPose("left", { position: [-0.3, 1.2, -0.2], rotation: [0, 0, 0, 1] });
  } finally { driver.close(); }
}

function sendPlayerInputs(values: number[]) {
  const control = directCameraControl;
  if (!control) return;
  const signature = values.join(",");
  if (signature === playerInputSignature &&
    (values.every((value) => value === 0) || Date.now() - playerInputSentAt < 100)) return;
  playerInputSignature = signature;
  playerInputSentAt = Date.now();
  const trigger = values[5] !== 0;
  if (trigger !== playerTrigger) {
    playerTrigger = trigger;
    // OSC Use controls held items; the synthetic trigger also drives VRChat's normal
    // controller Interact path, including world buttons/doors and camera UI.
    playerTriggerPending = playerTriggerPending.then(async () => {
      const { SyntheticDriver } = await import("../utils/vrlab/driver.ts");
      const driver = await SyntheticDriver.attach();
      try { await driver.setInput("right", { trigger: trigger ? 1 : 0 }); }
      finally { driver.close(); }
    }).catch((error) => { commandError = messageOf(error); });
  }
  void (async () => {
    // Camera Flying redirects locomotion to the camera. Release it before player input.
    await control.release();
    for (let i = 0; i < playerInputs.length; i++) {
      await control.sendPlayerInput(playerInputs[i], values[i], i >= 3);
    }
  })().catch((error) => { commandError = messageOf(error); });
}
let cameraControlGeneration = 0;

new PostMan(
  state,
  {
    __INIT__: (_payload: void) => {},
    __SHUTDOWN__: async (_payload: unknown) => {
      await stopDesktopView();
    },
    __HEALTH__: (_payload: unknown) => getDesktopViewStatus(),
    __SNAPSHOT__: (_payload: unknown) => ({
      started: state.running,
      options: {
        webxrTarget: state.webxrTarget,
        cameraOriginTarget: state.cameraOriginTarget,
        depthTarget: state.depthTarget,
        flySpeed: state.flySpeed,
        camera: state.camera,
        depthDebug: state.depthDebug,
        title: state.title,
        depthForeground: state.depthForeground,
        depthVisuals: state.depthVisuals,
        depthComposite: state.depthComposite,
        gpuCapture: state.gpuCapture,
        depthShadows: state.depthShadows,
        depthLightVolumes: state.depthLightVolumes,
        depthLightVolumeStrength: state.depthLightVolumeStrength,
        width: state.running ? raylib.GetScreenWidth() : state.width,
        height: state.running ? raylib.GetScreenHeight() : state.height,
        x: state.running ? raylib.H.GetWindowPosition().x : undefined,
        y: state.running ? raylib.H.GetWindowPosition().y : undefined,
        fps: state.fps,
        diagnostics: state.diagnostics,
      },
    }),
    __RESTORE__: (payload: { started: boolean; options: StartDesktopViewPayload } | null) => {
      if (payload?.started) startDesktopView(payload.options);
    },
    STARTDESKTOPVIEW: (payload: StartDesktopViewPayload | null) => {
      startDesktopView(payload ?? {});
      return getDesktopViewStatus();
    },
    SETDEPTHFOREGROUND: (
      payload: {
        enabled?: boolean;
        visuals?: boolean;
        composite?: boolean;
        gpuCapture?: boolean;
        shadows?: boolean;
        lightVolumes?: boolean;
        lightVolumeStrength?: number;
      },
    ) => {
      if (Number.isFinite(payload.lightVolumeStrength)) {
        state.depthLightVolumeStrength = Math.max(0, Math.min(8, payload.lightVolumeStrength!));
      }
      if (typeof payload.lightVolumes === "boolean") state.depthLightVolumes = payload.lightVolumes;
      if (typeof payload.shadows === "boolean") state.depthShadows = payload.shadows;
      if (typeof payload.enabled === "boolean") state.depthForeground = payload.enabled;
      if (typeof payload.visuals === "boolean") state.depthVisuals = payload.visuals;
      if (typeof payload.composite === "boolean") state.depthComposite = payload.composite;
      if (typeof payload.gpuCapture === "boolean" && payload.gpuCapture !== state.gpuCapture) {
        state.gpuCapture = payload.gpuCapture;
        // Swap capture paths: release the lease, then claim it again in the new mode.
        if (state.depthDebug) void stopSharedCapture().then(() => subscribeDepthDebug());
      }
      return {
        enabled: state.depthForeground,
        visuals: state.depthVisuals,
        composite: state.depthComposite,
        gpuCapture: state.gpuCapture,
        shadows: state.depthShadows,
        lightVolumes: state.depthLightVolumes,
        lightVolumeStrength: state.depthLightVolumeStrength,
      };
    },
    STOPDESKTOPVIEW: async (_payload: void) => {
      await stopDesktopView();
      return getDesktopViewStatus();
    },
    /** One frame of scene IR from the `webxr` actor. */
    WEBXRVIEWFRAME: receiveScene,
    VRCDEPTHDEBUGSOURCE: (source: VrcDepthFramePayload) => {
      if (!state.depthDebug) return;
      lastDebugFrame = debugFrameFromSource(source, ++directDepthRevision, state.depthVisuals);
      directDepthFrames++;
    },
    WEBXRVIEWFRAMEPACKET: (packet: OverlayScenePacket) => {
      const startedAt = performance.now();
      const streamBefore = wireDecoder.streamId;
      const decoded = wireDecoder.decode(packet);
      // A new sender stream (the webxr actor reloaded): its asset ids start over, so the renderer's
      // cached geometry and materials would draw new objects with old assets.
      if (streamBefore !== null && wireDecoder.streamId !== streamBefore) sceneStreamChanged = true;
      lastDecodeMs = performance.now() - startedAt;
      lastPacketBytes = packet.data.length;
      if (decoded.stale) acknowledgeScene(decoded);
      else receiveScene(decoded.payload);
    },
    REQUESTCAPTURE: async (payload: { path?: string } | null) => {
      if (!state.running) {
        return { ok: false, error: "desktop view is not running" };
      }
      try {
        const path = await requestScreenCapture(payload?.path ?? `${Deno.cwd()}/desktop-view.png`, {
          keepAlpha: state.camera === "vrc",
        });
        return { ok: true, path };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
    GETCAPTURESTATUS: (_payload: void) => getScreenCaptureStatus(),
    /** Same movement path as keyboard input, also usable for headless debugging. */
    DEPTHDEBUGMOVE: (payload: { input: FlyCameraInput; seconds: number }) => {
      if (!state.depthDebug) throw new Error("not a depth debug window");
      const pose = moveDebugCamera(payload.input, payload.seconds);
      sendDebugPose();
      return pose;
    },
    DEPTHDEBUGSETPOSE: (payload: VrcWorldCameraPose) => {
      if (!state.depthDebug || !state.cameraOriginTarget) {
        throw new Error("depth debug camera unavailable");
      }
      if (
        payload.position.length !== 3 || payload.rotationDeg.length !== 3 ||
        ![...payload.position, ...payload.rotationDeg].every(Number.isFinite)
      ) throw new Error("invalid camera pose");
      flyPose = { position: [...payload.position], rotationDeg: [...payload.rotationDeg] };
      return { sequence: sendDebugPose(), pose: flyPose };
    },
    DEPTHDEBUGHOME: (_payload: null) => homeDebugCamera(),
    SETPLAYERCONTROLMODE: (payload: { enabled: boolean }) => {
      sendPlayerInputs(playerInputs.map(() => 0));
      playerControlMode = payload.enabled;
      releaseDebugCamera();
      flyPose = null;
      if (playerControlMode) void resetPlayerHandAim().catch(() => {});
      return { playerControlMode };
    },
    SETDRIVEREYEVIEW: (payload: { enabled: boolean }) => {
      driverEyeView?.dispose();
      driverEyeView = payload.enabled ? new DriverEyeView() : null;
      return { enabled: driverEyeView != null };
    },
    /** `durationMs`, or `{ durationMs, intervalUs }`: a V8 profile of this view's main thread. */
    PROFILECPU: async (request: number | { durationMs: number; intervalUs?: number }) => {
      const { captureCpuProfile } = await import("../classes/cpuProfile.ts");
      return typeof request === "number"
        ? await captureCpuProfile(request)
        : await captureCpuProfile(request.durationMs, request.intervalUs);
    },
    GETDEPTHLATENCY: (payload: { reset?: boolean } | null) => {
      if (payload?.reset) depthLatency.reset();
      return depthLatency.report();
    },
  } as const,
);

globalThis.addEventListener("unload", () => {
  state.stopRequested = true;
});

/** Keep dependencies before returning credit: rendering may skip superseded snapshots. */
function receiveScene(payload: WebXRRaythreeRenderPayload): void {
  sceneInbox.receive(payload);
  latestPayload = payload;
  if (!state.depthTarget && payload.vrcDepthDebug) lastDebugFrame = payload.vrcDepthDebug;
  latestSeq++;
  state.framesReceived++;
  lastFrameAt = performance.now();
  state.lastPayload = {
    instances: payload.leftEye.frame.instances.length,
    geometries: payload.leftEye.assets.geometries.length,
    materials: payload.leftEye.assets.materials.length,
    textures: payload.leftEye.assets.textures.length,
    lights: payload.leftEye.frame.lights.length,
    panels: payload.ui?.panels?.length ?? 0,
    texts: payload.ui?.texts?.length ?? 0,
    frameCount: payload.frame.frameCount,
  };
  state.assetsSeen.geometries += payload.leftEye.assets.geometries.length;
  state.assetsSeen.materials += payload.leftEye.assets.materials.length;
  state.assetsSeen.textures += payload.leftEye.assets.textures.length;
  acknowledgeScene(payload);
}

function acknowledgeScene(payload: Pick<WebXRRaythreeRenderPayload, "delivery">): void {
  if (!state.registered || !state.webxrTarget) return;
  state.framesAcked++;
  PostMan.PostMessage({
    target: state.webxrTarget,
    type: "WEBXRVIEWFRAMEACK",
    payload: { actorId: state.id, delivery: payload.delivery },
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getDesktopViewStatus() {
  return {
    pid: Deno.pid,
    running: state.running,
    stopRequested: state.stopRequested,
    lastError: state.lastError,
    webxrTarget: state.webxrTarget,
    registered: state.registered,
    width: state.width,
    height: state.height,
    fpsTarget: state.fps,
    windowFps: state.lastWindowFps,
    framesReceived: state.framesReceived,
    framesRendered: state.framesRendered,
    framesAcked: state.framesAcked,
    payloadHeld: latestPayload != null,
    renderLagFrames: Math.max(0, latestSeq - renderedSeq),
    lastRenderMs: Number(state.lastRenderMs.toFixed(3)),
    lastDecodeMs,
    lastPacketBytes,
    lastEndDrawingMs,
    wireFormat: OVERLAY_SCENE_WIRE_FORMAT,
    lastPayload: state.lastPayload,
    assetsSeen: { ...state.assetsSeen },
    capturePath: state.capturePath,
    captureWritten: state.captureWritten,
    hidden: state.hidden,
    camera: state.camera,
    depthDebug: state.depthDebug,
    depthForeground: state.depthForeground,
    foregroundResolution: lastDebugFrame
      ? {
        width: lastDebugFrame.foregroundBlock?.depthWidth ?? lastDebugFrame.foreground?.width ??
          lastDebugFrame.mesh.width,
        height: lastDebugFrame.foregroundBlock?.depthHeight ?? lastDebugFrame.foreground?.height ??
          lastDebugFrame.mesh.height,
      }
      : null,
    debugMeshResolution: lastDebugFrame
      ? { width: lastDebugFrame.mesh.width, height: lastDebugFrame.mesh.height }
      : null,
    depthVisuals: state.depthVisuals,
    transparent: state.running && raylib.IsWindowState(raylib.ConfigFlags.FLAG_WINDOW_TRANSPARENT),
    inputPassthrough: state.running &&
      raylib.IsWindowState(raylib.ConfigFlags.FLAG_WINDOW_MOUSE_PASSTHROUGH),
    flyControlled,
    flySpeed: state.flySpeed,
    playerControlMode,
    driverEyeView: driverEyeView != null,
    driverEyeStatus: driverEyeView?.status() ?? null,
    flyPose,
    directDepthFrames,
    depthTransport: gpuDepth ? "gpu-texture" : captureWorker ? "shared-memory" : "actor-wire",
    gpuCapture: gpuDepth?.status() ?? null,
    depthComposite: state.depthComposite,
    depthShadows: state.depthShadows,
    sceneStreamResets,
    sceneStream: wireDecoder.streamId,
    lightVolumes: lightVolumeCache.status(),
    depthLightVolumes: state.depthLightVolumes,
    depthLightVolumeStrength: state.depthLightVolumeStrength,
    sharedDepthFrames,
    captureError,
    captureLosses,
    commandError,
    cameraControlTransport: directCameraControl ? "direct-osc" : "actor",
    latency: depthLatency.report().summary,
    depthAgeMs: lastDebugFrame ? Date.now() - lastDebugFrame.receivedAt : null,
    observedCamera: lastDebugFrame
      ? cameraPoseFromWorld(cameraWorldPose(lastDebugFrame.header))
      : null,
    vrcCameraCalibrated: state.vrcCameraCalibrated,
    loopRunning: state.loop != null,
  };
}

function startDesktopView(payload: StartDesktopViewPayload): void {
  if (payload.depthForeground != null) state.depthForeground = payload.depthForeground;
  if (payload.gpuCapture != null) state.gpuCapture = payload.gpuCapture;
  if (payload.depthComposite != null) state.depthComposite = payload.depthComposite;
  if (payload.depthShadows != null) state.depthShadows = payload.depthShadows;
  if (payload.depthLightVolumes != null) state.depthLightVolumes = payload.depthLightVolumes;
  if (Number.isFinite(payload.depthLightVolumeStrength)) {
    state.depthLightVolumeStrength = Math.max(0, Math.min(8, payload.depthLightVolumeStrength!));
  }
  if (payload.depthVisuals != null) state.depthVisuals = payload.depthVisuals;
  state.webxrTarget = payload.webxrTarget ?? state.webxrTarget;
  state.width = positiveInt(payload.width, state.width);
  state.height = positiveInt(payload.height, state.height);
  state.fps = payload.fps == null || payload.fps < 0 ? state.fps : Math.round(payload.fps);
  state.diagnostics = payload.diagnostics ?? state.diagnostics;
  state.title = payload.title ?? state.title;
  // Per-run directive, not sticky state: a later plain start must not capture
  // again and close itself.
  state.capturePath = payload.capturePath ?? null;
  state.captureWritten = null;
  state.hidden = payload.hidden ?? state.hidden;
  state.fovYDeg = payload.fovYDeg != null && payload.fovYDeg > 1 ? payload.fovYDeg : state.fovYDeg;
  state.cameraOriginTarget = payload.cameraOriginTarget ?? state.cameraOriginTarget;
  if (payload.flySpeed != null && Number.isFinite(payload.flySpeed)) {
    state.flySpeed = Math.max(0.1, Math.min(48, payload.flySpeed));
  }
  if (payload.depthTarget && payload.depthTarget !== state.depthTarget) {
    if (state.depthTarget) {
      PostMan.PostMessage({
        target: state.depthTarget,
        type: "UNREGISTERDEPTHDEBUGVIEW",
        payload: { actorId: state.id },
      });
    }
    state.depthTarget = payload.depthTarget;
    if (state.depthDebug) {
      subscribeDepthDebug();
      if (state.registered) {
        unregisterWithWebXr();
        registerWithWebXr();
      }
    }
  }
  if (state.loop != null) {
    if (state.running && payload.x != null && payload.y != null) {
      raylib.SetWindowPosition(payload.x, payload.y);
    }
    if (state.running && (payload.width != null || payload.height != null)) {
      raylib.SetWindowSize(state.width, state.height);
    }
    if (payload.depthDebug != null && payload.depthDebug !== state.depthDebug) {
      unregisterWithWebXr();
      setDepthDebugMode(payload.depthDebug);
      registerWithWebXr();
    }
    return;
  }
  // Fixed for the window's lifetime: it decides the window flags and the registration.
  state.camera = payload.camera ?? state.camera;
  state.captureOnly = payload.captureOnly ?? false;
  // The capture runs on the depth-debug plumbing (lease, capture worker), minus every visual.
  state.depthDebug = state.captureOnly || (payload.depthDebug ?? false);
  if (state.captureOnly) {
    state.hidden = true;
    state.width = state.height = 64;
  }
  state.cameraOriginTarget = payload.cameraOriginTarget ?? null;
  state.startPosition = payload.x != null && payload.y != null ? [payload.x, payload.y] : null;
  state.stopRequested = false;
  state.lastError = null;
  state.framesReceived = 0;
  state.framesRendered = 0;
  state.framesAcked = 0;
  latestPayload = null;
  latestSeq = 0;
  renderedSeq = 0;
  sceneInbox = new OverlaySceneInbox();
  wireDecoder = new OverlaySceneWireDecoder();
  lastDecodeMs = lastPacketBytes = lastEndDrawingMs = 0;
  state.loop = runDesktopViewWindow()
    .catch((error) => {
      state.lastError = error instanceof Error ? error.stack ?? error.message : messageOf(error);
      LogChannel.error(
        "actor",
        `[desktopView] window loop failed: ${
          error instanceof Error ? error.stack : state.lastError
        }`,
      );
    })
    .finally(() => {
      state.loop = null;
      state.running = false;
    });
}

async function stopDesktopView(): Promise<void> {
  state.stopRequested = true;
  // The loop closes the window itself; only a window that ignores the flag
  // (blocked in a raylib call) needs the forced path.
  await Promise.race([state.loop ?? Promise.resolve(), wait(2_000)]);
  unregisterWithWebXr();
}

function positiveInt(value: number | undefined, fallback: number): number {
  return value != null && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function registerWithWebXr(): void {
  const target = state.webxrTarget;
  if (target == null) {
    LogChannel.log("actor", "[desktopView] no webxr target; rendering nothing until one is set");
    return;
  }
  PostMan.PostMessage({
    target,
    type: "REGISTERWEBXRVIEW",
    // No `cameraControl`: this is a preview. View control moves the rendered XR
    // pose, which desyncs it from the OpenVR overlays placed in absolute space.
    payload: {
      actorId: state.id,
      label: state.depthDebug
        ? state.depthTarget ? "vrc-depth-debug-direct" : "vrc-depth-debug"
        : state.camera === "vrc"
        ? "vrc-camera"
        : "desktop",
      camera: state.camera,
      wireFormat: OVERLAY_SCENE_WIRE_FORMAT,
    },
  });
  state.registered = true;
  LogChannel.log("actor", `[desktopView] registered with ${target} as ${state.id}`);
}

function unregisterWithWebXr(): void {
  const target = state.webxrTarget;
  if (target == null || !state.registered) {
    return;
  }
  state.registered = false;
  PostMan.PostMessage({
    target,
    type: "UNREGISTERWEBXRVIEW",
    payload: { actorId: state.id },
  });
}

async function runDesktopViewWindow(): Promise<void> {
  const width = state.width;
  const height = state.height;
  raylib.loadRaylib(getRaylibLibraryPath());
  let windowUp = false;
  let renderer: WebXRRaythreeRaylibRenderer | null = null;
  let captureRequested = false;
  try {
    let flags = 0;
    if (state.hidden) flags |= raylib.ConfigFlags.FLAG_WINDOW_HIDDEN;
    if (state.camera === "vrc") {
      // A capture surface, not a window to use: no border, never focused, and clicks pass through
      // to whatever is below, so a fully transparent layer cannot swallow desktop input.
      flags |= raylib.ConfigFlags.FLAG_WINDOW_TRANSPARENT |
        raylib.ConfigFlags.FLAG_WINDOW_UNDECORATED;
      if (!state.depthDebug) {
        flags |= raylib.ConfigFlags.FLAG_WINDOW_MOUSE_PASSTHROUGH |
          raylib.ConfigFlags.FLAG_WINDOW_UNFOCUSED;
      }
    }
    if (flags !== 0) raylib.SetConfigFlags(flags);
    raylib.H.InitWindow(width, height, state.title);
    if (state.startPosition) {
      raylib.SetWindowPosition(state.startPosition[0], state.startPosition[1]);
    }
    if (state.depthDebug) {
      setDepthDebugMode(true);
    }
    windowUp = true;
    // Raylib waits synchronously in EndDrawing when capped, blocking scene messages.
    // Pace with the async loop below so delivery and decoding continue between draws.
    raylib.SetTargetFPS(0);
    renderer = new WebXRRaythreeRaylibRenderer();
    state.running = true;
    LogChannel.log(
      "actor",
      `[desktopView] window ${width}x${height} fps=${state.fps} hidden=${state.hidden} - IR consumer, no local scene`,
    );
    if (!state.captureOnly) registerWithWebXr();
    if (state.depthDebug) subscribeDepthDebug();

    let fpsMarkAt = performance.now();
    let drawsSinceFpsMark = 0;
    const windowStartedAt = fpsMarkAt;
    let lastDrawAt = 0;
    while (!raylib.WindowShouldClose() && !state.stopRequested) {
      const loopStartedAt = performance.now();
      if (state.captureOnly) {
        // Only the capture: poll for VRChat's redraws, keep the hidden window's events drained.
        if (gpuDepth) pollGpuDepth();
        raylib.PollInputEvents();
        await wait(CAPTURE_ONLY_SLEEP_MS);
        continue;
      }
      if (state.depthDebug) pollDebugCameraInput();
      if (gpuDepth) pollGpuDepth();
      driverEyeView?.poll();
      // Draw only when there is something new: an unchanged scene costs a
      // window-event poll, not a full re-render at the window's refresh rate.
      const drawDue = flyControlled ||
        depthRenderedRevision !== (lastDebugFrame?.mesh.revision ?? -1) ||
        latestSeq !== renderedSeq || hasPendingScreenCapture() ||
        raylib.IsWindowResized() || performance.now() - lastDrawAt >= IDLE_REDRAW_MS;
      if (drawDue) {
        if (sceneStreamChanged) {
          sceneStreamChanged = false;
          sceneStreamResets++;
          renderer.dispose();
          renderer = new WebXRRaythreeRaylibRenderer();
          LogChannel.log("actor", "[desktopView] webxr scene stream restarted: renderer assets reset");
        }
        drawLatestFrame(renderer);
        drawsSinceFpsMark++;
        lastDrawAt = performance.now();
        // After EndDrawing: the frame is complete and no draw is in flight, which
        // is the only point where reading the framebuffer is safe.
        runPendingScreenCapture();
      } else {
        raylib.PollInputEvents();
      }
      // One-shot capture. The first payloads a view receives can still be
      // priming frames with no geometry, so wait for one that carries content;
      // a scene that is legitimately empty still gets captured on the fallback
      // rather than hanging the caller.
      const payload = state.lastPayload;
      const hasGeometry = payload != null &&
        (payload.instances > 0 || payload.panels > 0 || payload.texts > 0);
      const captureReady = latestPayload != null &&
        (hasGeometry || performance.now() - windowStartedAt > CAPTURE_FALLBACK_MS);
      if (state.capturePath != null && !captureRequested && captureReady) {
        captureRequested = true;
        if (!hasGeometry) {
          LogChannel.log("actor", "[desktopView] capture fallback: no payload carried geometry");
        }
        requestScreenCapture(state.capturePath)
          .then((written) => {
            state.captureWritten = written;
            LogChannel.log("actor", `[desktopView] capture written ${written}`);
          })
          .catch((error) => {
            state.lastError = messageOf(error);
            LogChannel.error("actor", `[desktopView] capture failed: ${state.lastError}`);
          })
          .finally(() => {
            state.stopRequested = true;
          });
      }
      const now = performance.now();
      if (now - fpsMarkAt >= 500) {
        state.lastWindowFps = Math.round(drawsSinceFpsMark * 1000 / (now - fpsMarkAt));
        drawsSinceFpsMark = 0;
        fpsMarkAt = now;
      }
      // A `/reload` of the webxr actor rebuilds its view registry; a view that
      // was receiving frames and stopped is the cheap signal to register again.
      if (
        state.registered && state.framesReceived > 0 && lastFrameAt > 0 &&
        now - lastFrameAt > VIEW_REREGISTER_AFTER_MS
      ) {
        state.registered = false;
        registerWithWebXr();
        lastFrameAt = now;
      }
      const remainingMs = drawDue && state.fps > 0
        ? Math.max(LOOP_SLEEP_MS, 1000 / state.fps - (performance.now() - loopStartedAt))
        : drawDue
        ? LOOP_SLEEP_MS
        : IDLE_LOOP_SLEEP_MS;
      await wait(remainingMs);
    }
  } finally {
    releaseDebugCamera();
    await stopDirectCameraControl();
    await stopSharedCapture();
    if (state.depthTarget) {
      PostMan.PostMessage({
        target: state.depthTarget,
        type: "UNREGISTERDEPTHDEBUGVIEW",
        payload: { actorId: state.id },
      });
    }
    depthView?.dispose();
    depthView = null;
    depthRenderer?.dispose();
    depthRenderer = null;
    unregisterWithWebXr();
    renderer?.dispose();
    if (windowUp) {
      raylib.H.CloseWindow();
      raylib.unloadRaylib();
    }
    state.running = false;
  }
}

/**
 * Draws the latest payload into the window framebuffer. The loop calls this for
 * new payloads, pending captures and resizes, plus an `IDLE_REDRAW_MS` keepalive.
 */
function drawLatestFrame(renderer: WebXRRaythreeRaylibRenderer): void {
  drawnDepthRevision = -1;
  renderer.setDepthForeground(null);
  raylib.BeginDrawing();
  try {
    const scene = sceneInbox.current();
    const payload = scene?.payload ?? null;
    if (state.depthDebug) {
      drawDepthDebugFrame(renderer, payload);
      if (scene) sceneInbox.markAdopted(scene);
      renderedSeq = latestSeq;
      return;
    }
    const vrcView = state.camera === "vrc";
    if (payload == null) {
      raylib.H.ClearBackground(vrcView ? TRANSPARENT : { r: 12, g: 14, b: 18, a: 255 });
      return;
    }
    const matrices = vrcView ? vrcCameraMatrices(payload) : {
      projectionMatrix: payload.frame.leftEyeProjectionMatrix,
      viewMatrix: payload.frame.leftEyeViewMatrix,
    };
    state.vrcCameraCalibrated = vrcView && matrices != null;
    if (matrices == null) {
      // Uncalibrated: an empty layer rather than a headset view a stream would show.
      raylib.H.ClearBackground(TRANSPARENT);
      if (state.diagnostics) {
        raylib.H.DrawText("VRC camera not calibrated", 16, 16, 20, {
          r: 255,
          g: 214,
          b: 120,
          a: 255,
        });
      }
      return;
    }
    const renderStartedAt = performance.now();
    renderer.renderExtraction(
      payload.leftEye,
      payload.background,
      matrices,
      RENDER_CONTEXT_ID,
      payload.ui,
    );
    state.lastRenderMs = performance.now() - renderStartedAt;
    if (scene) sceneInbox.markAdopted(scene);
    state.framesRendered += 1;
    if (renderedSeq !== latestSeq) {
      renderedSeq = latestSeq;
    }
    // Window-side diagnostics: drawn every frame so a capture proves both the
    // framebuffer path and what the IR carried. The VRC camera layer is recorded, so
    // it carries no counter unless diagnostics are asked for.
    if (!vrcView || state.diagnostics) raylib.DrawFPS(16, 16);
    // VRChat depth sync status, bottom-left, clear of the depth block in the top-left corner.
    const debugLines = vrcView ? payload.vrcDebugLines ?? [] : [];
    for (let i = 0; i < debugLines.length; i++) {
      const y = raylib.GetScreenHeight() - 16 - (debugLines.length - i) * 22;
      raylib.H.DrawText(debugLines[i], 17, y + 1, 20, { r: 0, g: 0, b: 0, a: 200 });
      raylib.H.DrawText(debugLines[i], 16, y, 20, { r: 120, g: 240, b: 255, a: 255 });
    }
    if (state.diagnostics) {
      raylib.H.DrawText(
        `ir=${state.framesReceived} rendered=${state.framesRendered} inst=${
          state.lastPayload?.instances ?? 0
        } assets=${state.assetsSeen.geometries}/${state.assetsSeen.materials}/${state.assetsSeen.textures} ui=${
          state.lastPayload?.panels ?? 0
        }/${state.lastPayload?.texts ?? 0}`,
        16,
        44,
        20,
        { r: 255, g: 214, b: 120, a: 255 },
      );
    }
  } finally {
    const endStartedAt = performance.now();
    raylib.EndDrawing();
    if (drawnDepthRevision >= 0) depthLatency.swapped(drawnDepthRevision, Date.now());
    lastEndDrawingMs = performance.now() - endStartedAt;
  }
}

/** One GPU-captured frame per VRChat redraw: decode its header/small grid, forward it for VR. */
function pollGpuDepth(): void {
  const source = gpuDepth!;
  const raw = source.poll();
  const now = Date.now();
  if (now - gpuStatusAt >= 1000) {
    gpuStatusAt = now;
    const status = source.status();
    captureWorker?.postMessage({
      status: {
        ...status,
        metrics: {
          decodeMs: status.decodeMs,
          lastFailure: status.lastFailure ?? status.openError,
          failures: status.failures,
          repeats: status.repeats,
        },
      },
    });
  }
  if (!raw) return;
  raw.decodedAt = now;
  sharedDepthFrames++;
  const { foregroundBlock: _block, ...wire } = raw;
  if (state.captureOnly) {
    captureWorker?.postMessage({ raw: wire });
    return;
  }
  lastDebugFrame = debugFrameFromRaw(raw, ++directDepthRevision, state.depthVisuals);
  depthLatency.observe({
    revision: lastDebugFrame.mesh.revision,
    pose: cameraPoseFromWorld(cameraWorldPose(raw.header)),
    capturedAt: raw.receivedAt,
    sourceCapturedAt: raw.receivedAt,
    decodedAt: now,
    deliveredAt: now,
    preparedAt: Date.now(),
  });
  // The VR scene is in another process: the worker turns the small grid into its wire frame.
  captureWorker?.postMessage({ raw: wire });
}

/** Toggle input on the existing transparent recording overlay without replacing its window. */
function subscribeDepthDebug(): void {
  if (!state.depthTarget || captureWorker || captureStart) return;
  captureStart = startSharedCapture().catch((error) => {
    captureError = String(error);
    if (state.depthTarget && state.depthDebug && !state.captureOnly) {
      PostMan.PostMessage({
        target: state.depthTarget,
        type: "REGISTERDEPTHDEBUGVIEW",
        payload: { actorId: state.id },
      });
    }
    // A previous view's lease may still be expiring during reload. Initial claim failures
    // need the same retry as a later worker loss, rather than permanent actor-wire fallback.
    if (captureRetry) clearTimeout(captureRetry);
    captureRetry = setTimeout(() => {
      captureRetry = null;
      if (state.depthDebug && !state.stopRequested) subscribeDepthDebug();
    }, 3000);
  }).finally(() => {
    captureStart = null;
  });
}

async function startSharedCapture(): Promise<void> {
  if (captureStop) await captureStop;
  if (!state.depthDebug || state.stopRequested) return;
  const target = state.depthTarget;
  if (!target) return;
  const owner = `${state.id}:${crypto.randomUUID()}`;
  const config = await PostMan.PostMessage({
    target,
    type: "CLAIMDEPTHCAPTURE",
    payload: { owner, background: state.captureOnly },
  }, true) as { grid?: number; __actorError?: unknown };
  if (!config?.grid || config.__actorError) {
    throw new Error("intake does not support shared capture");
  }
  if (!state.depthDebug || state.stopRequested) {
    PostMan.PostMessage({ target, type: "RELEASEDEPTHCAPTURE", payload: { owner } });
    return;
  }
  captureOwner = owner;
  const gpu = state.gpuCapture;
  const foregroundGrid = gpu ? 0 : 512;
  sharedFrames = new SharedDepthFrames(config.grid * config.grid, undefined, foregroundGrid ** 2);
  try {
    const worker = new Worker(
      new URL("../classes/vrchatDepth/captureWorker.ts", import.meta.url).href,
      { type: "module" },
    );
    captureWorker = worker;
    captureError = null;
    worker.onmessage = (
      event: MessageEvent<
        {
          frame?: SharedFrameNotice;
          stopped?: boolean;
          wants?: { colors: boolean };
          error?: string;
          fatal?: boolean;
          table?: {
            id: number;
            data: Uint8Array;
            width: number;
            height: number;
            size: number;
            tiles: number;
          };
        }
      >,
    ) => {
      if (event.data.stopped) {
        captureStopped?.();
        return;
      }
      if (event.data.wants && gpuDepth && state.captureOnly) {
        // The debug view draws the colours itself; only the VR helper follows webxr's request.
        gpuDepth.colors = event.data.wants.colors;
        return;
      }
      if (event.data.table) {
        const { id, ...table } = event.data.table;
        gpuDepth?.receiveTable(id, table);
        return;
      }
      if (event.data.error) {
        captureError = event.data.error;
        if (event.data.fatal) fallbackFromSharedCapture();
        return;
      }
      if (!event.data.frame || !sharedFrames) return;
      const deliveredAt = Date.now();
      const raw = sharedFrames.read(event.data.frame);
      if (raw) {
        lastDebugFrame = debugFrameFromRaw(raw, ++directDepthRevision, state.depthVisuals);
        depthLatency.observe({
          revision: lastDebugFrame.mesh.revision,
          pose: cameraPoseFromWorld(cameraWorldPose(raw.header)),
          capturedAt: raw.receivedAt,
          sourceCapturedAt: raw.sourceCapturedAt,
          decodedAt: raw.decodedAt,
          deliveredAt,
          preparedAt: Date.now(),
        });
        sharedDepthFrames++;
      }
    };
    worker.onerror = (event) => {
      captureError = event.message;
      fallbackFromSharedCapture();
    };
    worker.postMessage({
      buffer: sharedFrames.buffer,
      capacity: sharedFrames.capacity,
      grid: config.grid,
      foregroundGrid,
      owner,
      target,
      baseUrl: getAgentReplBaseUrl(),
      external: gpu,
    });
    if (gpu) {
      gpuDepth = new GpuDepthSource(config.grid);
      gpuDepth.requestTable = (request) =>
        worker.postMessage({ buildTable: request }, [request.samples.buffer]);
    }
    PostMan.PostMessage({
      target,
      type: "UNREGISTERDEPTHDEBUGVIEW",
      payload: { actorId: state.id },
    });
  } catch (error) {
    await stopSharedCapture();
    throw error;
  }
}

/** Shared-capture losses since start; the view claims the capture again after each. */
let captureLosses = 0;
let captureRetry: ReturnType<typeof setTimeout> | null = null;
const CAPTURE_RETRY_MS = 3000;

function fallbackFromSharedCapture(): void {
  captureLosses++;
  LogChannel.log(
    "actor",
    `[desktopView] shared depth capture lost (${captureError}); actor-wire until it is claimed again`,
  );
  void stopSharedCapture().finally(() => {
    if (state.depthTarget && state.depthDebug && !state.stopRequested) {
      if (!state.captureOnly) {
        PostMan.PostMessage({
          target: state.depthTarget,
          type: "REGISTERDEPTHDEBUGVIEW",
          payload: { actorId: state.id },
        });
      }
      // The intake's local capture serves meanwhile; claim it back rather than stay on the slow path.
      if (captureRetry) clearTimeout(captureRetry);
      captureRetry = setTimeout(() => {
        captureRetry = null;
        if (state.depthDebug && !state.stopRequested) subscribeDepthDebug();
      }, CAPTURE_RETRY_MS);
    }
  });
}

function stopSharedCapture(): Promise<void> {
  captureStop ??= stopSharedCaptureNow().finally(() => {
    captureStop = null;
  });
  return captureStop;
}

async function stopSharedCaptureNow(): Promise<void> {
  const worker = captureWorker;
  const owner = captureOwner;
  captureWorker = null;
  captureOwner = null;
  gpuDepth?.dispose();
  gpuDepth = null;
  if (worker) {
    const stopped = new Promise<void>((resolve) => {
      captureStopped = resolve;
    });
    worker.postMessage({ stop: true });
    await Promise.race([stopped, wait(2000)]);
    worker.terminate();
    captureStopped = null;
  }
  sharedFrames = null;
  if (owner && state.depthTarget) {
    PostMan.PostMessage({
      target: state.depthTarget,
      type: "RELEASEDEPTHCAPTURE",
      payload: { owner },
    });
  }
}

function setDepthDebugMode(enabled: boolean): void {
  releaseDebugCamera();
  depthView?.dispose();
  depthRenderer?.dispose();
  depthView = enabled ? new VrcDepthDebugView() : null;
  depthRenderer = enabled ? new WebXRRaythreeRaylibRenderer() : null;
  state.depthDebug = enabled;
  if (enabled) void startDirectCameraControl();
  else void stopDirectCameraControl();
  if (enabled) subscribeDepthDebug();
  else {
    void stopSharedCapture();
    if (state.depthTarget) {
      PostMan.PostMessage({
        target: state.depthTarget,
        type: "UNREGISTERDEPTHDEBUGVIEW",
        payload: { actorId: state.id },
      });
    }
  }
  flyPose = null;
  flyLastInputAt = performance.now();
  raylib.SetExitKey(enabled ? raylib.KeyboardKey.KEY_NULL : raylib.KeyboardKey.KEY_ESCAPE);
  if (enabled) {
    raylib.ClearWindowState(
      raylib.ConfigFlags.FLAG_WINDOW_MOUSE_PASSTHROUGH | raylib.ConfigFlags.FLAG_WINDOW_UNFOCUSED,
    );
  } else if (state.camera === "vrc") {
    raylib.SetWindowState(raylib.ConfigFlags.FLAG_WINDOW_MOUSE_PASSTHROUGH);
  }
}

/** Hold-to-control keeps ordinary desktop typing and VR locomotion available on release. */
function homeDebugCamera() {
  const data = lastDebugFrame ?? latestPayload?.vrcDepthDebug;
  if (!data || Date.now() - data.receivedAt > 1500) throw new Error("Fresh depth is required to locate the avatar");
  releaseDebugCamera();
  // One metre forward avoids rendering from inside the avatar's head/hair.
  flyPose = stepFlyCamera(cameraPoseFromWorld(headWorldPose(data.header)), { forward: 1 }, 0.1, 10);
  return { sequence: sendDebugPose(), pose: flyPose };
}

function pollDebugCameraInput(): void {
  const pointer = raylib.H.GetMousePosition();
  const overViewButton = pointer.x >= raylib.GetScreenWidth()-220 && pointer.x <= raylib.GetScreenWidth()-12 &&
    pointer.y >= 33 && pointer.y <= 59;
  if (raylib.IsWindowFocused() && (raylib.IsKeyPressed(raylib.KeyboardKey.KEY_I) ||
    overViewButton && raylib.IsMouseButtonPressed(raylib.MouseButton.MOUSE_BUTTON_LEFT))) {
    driverEyeView?.dispose();
    driverEyeView = driverEyeView ? null : new DriverEyeView();
  }
  if (raylib.IsWindowFocused() && raylib.IsKeyPressed(raylib.KeyboardKey.KEY_P)) {
    sendPlayerInputs(playerInputs.map(() => 0));
    playerControlMode = !playerControlMode;
    releaseDebugCamera();
    flyPose = null;
    if (playerControlMode) void resetPlayerHandAim().catch(() => {});
  }
  if (raylib.IsWindowFocused() && raylib.IsKeyPressed(raylib.KeyboardKey.KEY_B) && state.webxrTarget) {
    // B freezes/resumes the existing ball; Shift+B keeps the fixed occlusion cube.
    const cube = raylib.IsKeyDown(raylib.KeyboardKey.KEY_LEFT_SHIFT) ||
      raylib.IsKeyDown(raylib.KeyboardKey.KEY_RIGHT_SHIFT);
    void PostMan.PostMessage({
      target: state.webxrTarget,
      type: "VRCDEPTHDEBUGCUBE",
      payload: { enabled: true, lit: !cube, toggleFollow: !cube },
    }, true)
      .catch((error) => {
        commandError = String(error);
      });
  }
  if (playerControlMode) {
    const active = raylib.IsWindowFocused() && !raylib.IsKeyDown(raylib.KeyboardKey.KEY_ESCAPE) && !overViewButton;
    const k = raylib.KeyboardKey;
    if (active && raylib.IsKeyPressed(k.KEY_T)) {
      void resetPlayerHandAim().catch((error) => { commandError = messageOf(error); });
    }
    const down = (key: number) => active && raylib.IsKeyDown(key) ? 1 : 0;
    sendPlayerInputs([
      down(k.KEY_W) - down(k.KEY_S), down(k.KEY_D) - down(k.KEY_A),
      down(k.KEY_E) - down(k.KEY_Q), down(k.KEY_SPACE), down(k.KEY_LEFT_SHIFT),
      active && raylib.IsMouseButtonDown(raylib.MouseButton.MOUSE_BUTTON_LEFT) ? 1 : 0,
      down(k.KEY_G),
    ]);
    if (active && raylib.IsKeyPressed(k.KEY_HOME)) {
      try { homeDebugCamera(); } catch (error) { commandError = messageOf(error); }
    }
    return;
  }
  if (raylib.IsWindowFocused() && raylib.IsKeyPressed(raylib.KeyboardKey.KEY_HOME)) {
    try { homeDebugCamera(); } catch (error) { commandError = messageOf(error); }
  }
  if (raylib.IsKeyPressed(raylib.KeyboardKey.KEY_O)) state.depthForeground = !state.depthForeground;
  if (raylib.IsKeyPressed(raylib.KeyboardKey.KEY_V)) state.depthVisuals = !state.depthVisuals;
  if (raylib.IsKeyPressed(raylib.KeyboardKey.KEY_F)) state.depthComposite = !state.depthComposite;
  if (raylib.IsKeyPressed(raylib.KeyboardKey.KEY_H)) state.depthShadows = !state.depthShadows;
  if (raylib.IsKeyPressed(raylib.KeyboardKey.KEY_L)) {
    state.depthLightVolumes = !state.depthLightVolumes;
  }
  const now = performance.now();
  const seconds = (now - flyLastInputAt) / 1000;
  flyLastInputAt = now;
  const data = lastDebugFrame ?? latestPayload?.vrcDepthDebug;
  const usable = data != null;
  const held = raylib.IsWindowFocused() &&
    raylib.IsMouseButtonDown(raylib.MouseButton.MOUSE_BUTTON_RIGHT);
  if (
    !held || !usable || !state.cameraOriginTarget || raylib.IsKeyDown(raylib.KeyboardKey.KEY_ESCAPE)
  ) {
    releaseDebugCamera();
    if (raylib.IsWindowFocused() && raylib.IsKeyPressed(raylib.KeyboardKey.KEY_R) && data) {
      flyPose ??= cameraPoseFromWorld(cameraWorldPose(data.header));
      sendDebugPose();
    }
    if (depthView && raylib.IsKeyPressed(raylib.KeyboardKey.KEY_C)) {
      depthView.shading = depthView.shading === "depth" ? "color" : "depth";
    }
    return;
  }
  if (!flyControlled) {
    if (!flyPose) {
      flyPose = cameraPoseFromWorld(cameraWorldPose(data!.header));
    }
    flyControlled = true;
    flyPending = false;
    raylib.DisableCursor();
  }
  const keys = raylib.KeyboardKey;
  const wheel = raylib.GetMouseWheelMove();
  if (wheel) state.flySpeed = Math.max(0.1, Math.min(48, state.flySpeed * Math.pow(1.25, wheel)));
  const mouse = raylib.H.GetMouseDelta();
  const input: FlyCameraInput = {
    forward: Number(raylib.IsKeyDown(keys.KEY_W)) - Number(raylib.IsKeyDown(keys.KEY_S)),
    right: Number(raylib.IsKeyDown(keys.KEY_D)) - Number(raylib.IsKeyDown(keys.KEY_A)),
    up: Number(raylib.IsKeyDown(keys.KEY_E)) - Number(raylib.IsKeyDown(keys.KEY_Q)),
    fast: raylib.IsKeyDown(keys.KEY_LEFT_SHIFT),
    mouseX: mouse.x,
    mouseY: mouse.y,
  };
  if (input.forward || input.right || input.up || mouse.x || mouse.y) {
    moveDebugCamera(input, seconds);
    flyPending = true;
  }
  // This poll is already frame-paced. A second 60 Hz time gate can miss by fractions of a
  // millisecond and skip a whole frame, alternating short and long camera steps.
  if (flyPending) sendDebugPose();
  if (depthView && raylib.IsKeyPressed(keys.KEY_C)) {
    depthView.shading = depthView.shading === "depth" ? "color" : "depth";
  }
}

function moveDebugCamera(input: FlyCameraInput, seconds: number): VrcWorldCameraPose {
  const data = lastDebugFrame ?? latestPayload?.vrcDepthDebug;
  if (!data) throw new Error("waiting for the first VRChat depth frame");
  if (!state.cameraOriginTarget) throw new Error("camera origin actor unavailable");
  flyPose ??= cameraPoseFromWorld(cameraWorldPose(data.header));
  flyPose = stepFlyCamera(flyPose, input, seconds, state.flySpeed);
  return flyPose;
}

async function startDirectCameraControl() {
  const generation = ++cameraControlGeneration;
  const target = state.cameraOriginTarget;
  if (!target) return;
  try {
    const endpoint = await PostMan.PostMessage({
      target,
      type: "GETUSERCAMERACONTROLENDPOINT",
      payload: null,
    }, true) as CameraControlEndpoint | null;
    if (endpoint && state.depthDebug && generation === cameraControlGeneration) {
      directCameraControl = new DirectCameraControl(endpoint);
    }
  } catch { /* Older/unavailable camera actors retain the existing command path. */ }
}

async function stopDirectCameraControl() {
  driverEyeView?.dispose();
  driverEyeView = null;
  if (playerTrigger) sendPlayerInputs(playerInputs.map(() => 0));
  await playerTriggerPending;
  cameraControlGeneration++;
  const control = directCameraControl;
  directCameraControl = null;
  if (control) {
    for (let i = 0; i < playerInputs.length; i++) {
      await control.sendPlayerInput(playerInputs[i], 0, i >= 3).catch(() => {});
    }
    await control.close().catch((error) => {
      commandError = String(error);
    });
  }
}

function sendDebugPose(): number | null {
  if (!flyPose || !state.cameraOriginTarget) return null;
  // /Pose itself enables Flying. Keep it on for the whole gesture, not one OSC toggle per frame.
  const sequence = depthLatency.command(flyPose, Date.now());
  const sent = directCameraControl
    ? directCameraControl.sendPose(flyPose).then(() => true)
    : PostMan.PostMessage({
      target: state.cameraOriginTarget,
      type: "SETUSERCAMERAPOSE",
      payload: flyPose,
    }, true);
  void sent
    .then((result) => {
      if (result === true) {
        depthLatency.acknowledge(sequence, Date.now());
        commandError = null;
      } else commandError = JSON.stringify(result);
    }).catch((error) => {
      commandError = String(error);
    });
  flySentAt = performance.now();
  flyPending = false;
  return sequence;
}

function releaseDebugCamera(): void {
  if (!flyControlled) return;
  if (flyPending) sendDebugPose();
  flyControlled = false;
  raylib.EnableCursor();
  if (directCameraControl) {
    void directCameraControl.release().catch((error) => {
      commandError = String(error);
    });
  } else if (state.cameraOriginTarget) {
    PostMan.PostMessage({
      target: state.cameraOriginTarget,
      type: "SETUSERCAMERAFLYING",
      payload: false,
    });
  }
}

function drawDepthDebugFrame(
  renderer: WebXRRaythreeRaylibRenderer,
  payload: WebXRRaythreeRenderPayload | null,
): void {
  const startedAt = performance.now();
  const data = lastDebugFrame ?? payload?.vrcDepthDebug;
  const background: [number, number, number, number] = [0, 0, 0, 0];
  const alignment = payload?.vrcDepthAlignment;
  const foreground = data?.foreground ?? data?.mesh;
  const fresh = data != null && Date.now() - data.receivedAt < 500;
  if (driverEyeView) {
    if (fresh && alignment && data?.header.lighting) {
      setEnvironmentLighting(environmentFromRecord(data.header.lighting, alignment));
    }
    driverEyeView.draw();
    raylib.H.DrawRectangle(0, 0, raylib.GetScreenWidth(), 32, { r: 12, g: 14, b: 18, a: 255 });
    raylib.H.DrawText(`DRIVER VIEW | I: Stream camera | P: ${playerControlMode ? "fly camera" : "player mode"} | WASD: walk | Q/E: turn | LMB: trigger | B: freeze ball | T: reset aim`,
      16, 10, 18, { r: 180, g: 235, b: 255, a: 255 });
    drawViewToggle();
    return;
  }
  const matrices = data && alignment
    ? foregroundCamera(data, alignment)
    : payload
    ? vrcCameraMatrices(payload)
    : null;
  // The block only describes the window texture while that capture is still bound.
  const block = gpuDepth?.capture && data?.foregroundBlock?.textureId === gpuDepth.capture.textureId
    ? data.foregroundBlock
    : undefined;
  // PetPlay's objects drawn here take VRChat's lighting at the wearer (environmentLighting.ts).
  if (fresh && alignment && data!.header.lighting) {
    setEnvironmentLighting(environmentFromRecord(data!.header.lighting, alignment));
  }
  renderer.setShadows(state.depthShadows);
  renderer.setSpatialLightingEnabled(state.depthLightVolumes);
  renderer.setSpatialLightingStrength(state.depthLightVolumeStrength);
  renderer.setDepthForeground(
    state.depthForeground && fresh && alignment
      ? {
        depth: foreground!.depth,
        width: foreground!.width,
        height: foreground!.height,
        revision: data!.mesh.revision,
        scale: alignment.scale,
        block,
      }
      : null,
  );
  // Composite: VRChat's frame behind PetPlay, both from the same captured frame, instead of
  // overlaying VRChat's live window, which always runs ahead of the captured pose.
  const composite = state.depthComposite && block != null;
  raylib.H.ClearBackground(TRANSPARENT);
  if (composite) {
    raylib.H.DrawTexturePro(
      {
        id: block!.textureId,
        width: block!.textureWidth,
        height: block!.textureHeight,
        mipmaps: 1,
        format: raylib.PixelFormat.PIXELFORMAT_UNCOMPRESSED_R8G8B8A8,
      } as never,
      { x: 0, y: 0, width: block!.textureWidth, height: block!.textureHeight },
      { x: 0, y: 0, width: raylib.GetScreenWidth(), height: raylib.GetScreenHeight() },
      { x: 0, y: 0 },
      0,
      { r: 255, g: 255, b: 255, a: 255 },
    );
  }
  if (payload && matrices) {
    renderer.renderExtraction(
      payload.leftEye,
      background,
      matrices,
      RENDER_CONTEXT_ID,
      payload.ui,
      { clear: false },
    );
  }
  if (data && depthView && depthRenderer) {
    drawnDepthRevision = data.mesh.revision;
    if (state.depthVisuals && data.mesh.positions.length > 0) {
      const extraction = depthView.update(
        data,
        raylib.GetScreenWidth() / Math.max(1, raylib.GetScreenHeight()),
      );
      depthRenderer.renderExtraction(
        extraction,
        background,
        undefined,
        "vrc-depth-debug-local",
        undefined,
        { clear: false },
      );
    }
    state.framesRendered++;
    depthRenderedRevision = data.mesh.revision;
    const age = Date.now() - data.receivedAt;
    const h = data.header.anchorToWorld, c = data.header.viewToWorld;
    const xyz = (v: number[]) => v.map((n) => n.toFixed(2)).join(" ");
    const lv = lightVolumeCache.status();
    const rawVolumes = parseLighting(data.header.lighting)?.lightVolumes;
    const lines = [
      `Light Volumes ${lv.complete}/${lv.count} | Coverage pages ${lv.coveragePages}/${lv.coverageTotal} | Native ${lv.native}/${lv.count} | ${
        !state.depthLightVolumes ? "PROBE ONLY"
          : lv.ageMs === null || lv.ageMs > 5000 ? "WAITING FOR LIGHTING DATA"
          : lv.count === 0 ? rawVolumes?.count
            ? `UNSUPPORTED LV v${rawVolumes.version}: ${rawVolumes.count} volumes - probe fallback`
            : "NO SUPPORTED VOLUMES - probe fallback"
          : lv.ready ? "SPATIAL" : "LOADING - probe fallback"
      } | ${state.depthLightVolumeStrength.toFixed(1)}x contrast | L: compare${
        lv.unsupported ? " | NATIVE LIMIT - see status" : ""
      }`,
      `${block ? "GPU " : ""}Foreground ${
        block
          ? `${block.depthWidth}x${block.depthHeight}`
          : `${foreground!.width}x${foreground!.height}`
      }${composite ? " composite" : ""} ${
        state.depthForeground && fresh && alignment ? "ON" : "OFF"
      } | Debug mesh ${data.mesh.width}x${data.mesh.height} | ${
        age < 1500 ? "live" : "STALE - R: reassert camera pose"
      } ${age} ms | O: toggle | V: visuals`,
      `Camera world ${xyz([c[3], c[7], c[11]])} | Player world ${xyz([h[3], h[7], h[11]])}`,
      lightingDebugLine(parseLighting(data.header.lighting)),
      ...payload?.vrcDebugLines?.slice(3) ?? [],
    ];
    for (const [i, line] of lines.entries()) {
      raylib.H.DrawRectangle(10, 68 + i * 22,
        Math.min(raylib.GetScreenWidth() - 20, raylib.H.MeasureText(line, 18) + 12),
        22, { r: 12, g: 14, b: 18, a: 235 });
      raylib.H.DrawText(line, 16, 72 + i * 22, 18, { r: 160, g: 235, b: 250, a: 255 });
    }
  } else {
    raylib.H.DrawText(
      "Waiting for depth. Open the VRChat Stream camera and enable the depth exporter.",
      16,
      80,
      18,
      { r: 255, g: 210, b: 100, a: 255 },
    );
  }
  raylib.H.DrawRectangle(0, 0, raylib.GetScreenWidth(), 62, { r: 12, g: 14, b: 18, a: 255 });
  raylib.H.DrawText(
    playerControlMode
      ? "PLAYER | P: fly camera | WASD: walk | Q/E: turn | Space: jump | Shift: run | LMB: trigger | B: freeze ball | G: grab | T: reset hand aim | Home: avatar"
      : "FLY CAMERA | P: player | RMB + WASD/QE: fly | Shift: fast | O: foreground | V: visuals | F: composite | B: freeze ball | Home: avatar | R: recover",
    16,
    12,
    18,
    { r: 245, g: 245, b: 245, a: 255 },
  );
  raylib.H.DrawText(
    `${state.flySpeed.toFixed(1)} m/s | RMB + wheel: speed | Shift: 4x | ${
      flyControlled ? "Controlling VRChat camera" : "Live captured view"
    }`,
    16,
    36,
    17,
    { r: 255, g: 160, b: 220, a: 255 },
  );
  state.lastRenderMs = performance.now() - startedAt;
  drawViewToggle();
}

function drawViewToggle() {
  const x=raylib.GetScreenWidth()-220;
  raylib.H.DrawRectangle(x,33,208,26,{r:40,g:65,b:85,a:255});
  raylib.H.DrawText(driverEyeView ? "Show Stream [I]" : "Show Driver [I]",x+12,38,18,
    {r:230,g:245,b:255,a:255});
}

const vrcCameraWorld = new THREE.Matrix4();
const vrcCameraView = new THREE.Matrix4();
const vrcCameraPosition = new THREE.Vector3();
const vrcCameraQuaternion = new THREE.Quaternion();
const vrcCameraScale = new THREE.Vector3(1, 1, 1);
const vrcCameraProjection = new THREE.PerspectiveCamera();
const vrcCameraViewElements = new Float32Array(16);
const vrcCameraProjectionElements = new Float32Array(16);

/** View/projection for the calibrated VRChat camera; null when the scene has no calibration. */
function vrcCameraMatrices(
  payload: WebXRRaythreeRenderPayload,
): { projectionMatrix: Float32Array; viewMatrix: Float32Array } | null {
  const camera = payload.vrcCamera;
  if (camera == null) return null;
  vrcCameraPosition.fromArray(camera.position);
  vrcCameraQuaternion.fromArray(camera.quaternion);
  vrcCameraWorld.compose(vrcCameraPosition, vrcCameraQuaternion, vrcCameraScale);
  vrcCameraView.copy(vrcCameraWorld).invert();
  vrcCameraViewElements.set(vrcCameraView.elements);
  vrcCameraProjection.fov = camera.fovYDeg ?? state.fovYDeg;
  vrcCameraProjection.aspect = raylib.GetScreenWidth() / Math.max(1, raylib.GetScreenHeight());
  vrcCameraProjection.near = VRC_CAMERA_NEAR_METERS;
  vrcCameraProjection.far = VRC_CAMERA_FAR_METERS;
  vrcCameraProjection.updateProjectionMatrix();
  vrcCameraProjectionElements.set(vrcCameraProjection.projectionMatrix.elements);
  return { projectionMatrix: vrcCameraProjectionElements, viewMatrix: vrcCameraViewElements };
}
