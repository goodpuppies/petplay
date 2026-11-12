import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { withOverlayFlipY } from "../classes/overlayTextureFlip.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import { Buffer } from "node:buffer";
import { join } from "@std/path";
import { configDir, tempDir } from "../classes/appPaths.ts";
import { wait } from "../classes/utils.ts";
import { nativeBuildTarget, screenStreamerRelativePath } from "../classes/nativeBuildTarget.ts";
import {
  type CapturedFrame,
  clampCaptureFps,
  DEFAULT_CAPTURE_FPS,
  type ScreenCapturer,
} from "../classes/ScreenCapturer/scclass.ts";
import type { OpenGLManager } from "../classes/openglManager.ts";
import { getOverlayTransformAbsolute, setOverlayTransform } from "../classes/openvrTransform.ts";
import { matrixEquals } from "../classes/matrixutils.ts";
import { isLayoutVisibilityAction } from "../classes/environment/wristMenu/types.ts";
import { OpenVrRuntime } from "../classes/openVrRuntime.ts";
import { tryCreateOpenVrOverlayFramePacer } from "../classes/openVrOverlayFramePacing.ts";

const state = actorState({
  name: "display_overlay_host",
  overlayClass: null as OpenVR.IVROverlay | null,
  overlayHandle: 0n,
  cursorWorkspacePosition: null as { x: number; y: number } | null,
  cursorInputSequence: 0,
  cursorDiagnostics: null as {
    workspace: [number, number];
    framePixels: [number, number];
  } | null,
  isRunning: false,
  isStarting: false,
  lastStartError: null as string | null,
  glManager: null as OpenGLManager | null,
  screenCapturer: null as ScreenCapturer | null,
  textureStructPtr: null as Deno.PointerValue<OpenVR.Texture> | null,
  textureReady: false,
  lastWidthMeters: -1,
  lastHmd: null as OpenVR.HmdMatrix34 | null,
  lastDeviceIndex: undefined as number | undefined,
  /** IVRSystem, to sample a controller pose when a carried screen is released. */
  systemPointer: null as bigint | null,
  lastAlpha: -1,
  lastCurvature: -1,
  captureFrames: 0,
  captureFps: DEFAULT_CAPTURE_FPS,
  captureFramesPresented: 0,
  captureFrameWidth: 1,
  captureFrameHeight: 1,
  lastStartConfig: null as StartDesktopPayload | null,
  restartTimerId: null as ReturnType<typeof setTimeout> | null,
  visible: false,
  shuttingDown: false,
});

let warmCapturePromise: Promise<ScreenCapturer> | null = null;

/**
 * Capture restarts back off so a helper that dies at once (portal denied, port taken) does not
 * spin. A helper that ran for `CAPTURE_STABLE_MS` resets the delay.
 */
const CAPTURE_RESTART_MIN_MS = 1_000;
const CAPTURE_RESTART_MAX_MS = 30_000;
const CAPTURE_STABLE_MS = 60_000;
let captureRestartDelayMs = CAPTURE_RESTART_MIN_MS;
let captureStartedAt = 0;
let captureRestartTimer: ReturnType<typeof setTimeout> | null = null;

/** Actor that shows our status to the user (the webxr actor's toasts), set by SUBSCRIBESTATUS. */
let statusListener: string | null = null;
/** A restart is in flight, so the next successful capture start is a recovery worth announcing. */
let captureRecovering = false;

function postStatusToast(toast: { title: string; content?: string; tone?: string }): void {
  if (statusListener == null) return;
  try {
    PostMan.PostMessage({ target: statusListener, type: "TOAST", payload: toast });
  } catch {
    // The listener may be shutting down.
  }
}

function scheduleCaptureRestart(reason: string): void {
  if (state.shuttingDown || captureRestartTimer != null) return;
  if (!captureRecovering) {
    postStatusToast({ title: "Desktop capture lost", content: "Reconnecting…", tone: "warning" });
  }
  captureRecovering = true;
  if (performance.now() - captureStartedAt > CAPTURE_STABLE_MS) {
    captureRestartDelayMs = CAPTURE_RESTART_MIN_MS;
  }
  const delay = captureRestartDelayMs;
  captureRestartDelayMs = Math.min(CAPTURE_RESTART_MAX_MS, captureRestartDelayMs * 2);
  LogChannel.error("actor", `[displayOverlayHost] ${reason}; restarting capture in ${delay}ms`);
  captureRestartTimer = setTimeout(() => {
    captureRestartTimer = null;
    if (state.shuttingDown) return;
    ensureWarmScreenCapturer().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      state.lastStartError = message;
      scheduleCaptureRestart(`capture restart failed: ${message}`);
    });
  }, delay);
}
const openVrRuntime = new OpenVrRuntime("Display overlay host OpenVR");

const START_DESKTOP_MAX_ATTEMPTS = 4;
const START_DESKTOP_RETRY_WAIT_MS = 450;
const START_DESKTOP_DEFERRED_RETRY_MS = 2_000;

function getWebxrFrameLogsEnabled(): boolean {
  const raw = Deno.args.find((a) => a.startsWith("--webxr-frame-logs"));
  if (raw == null) {
    return false;
  }
  const v = raw.split("=", 2)[1]?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

type StartDesktopPayload = {
  /** Unique OpenVR overlay key. */
  overlayKey: string;
  /** Short label in the dashboard. */
  displayName: string;
  /** Drive desktop / screen texture into the overlay. */
  runScreenCapture: boolean;
  /**
   * When capture is on: 0 = stream until STOP; otherwise N frames then stop capture (overlay stays).
   */
  captureFrameLimit?: number;
  /** Maximum unique desktop frames uploaded to OpenGL/OpenVR each second. */
  captureFps?: number;
  /** Meters: physical width of the overlay quad (default matches WebXR 16:9 default height). */
  initialWidthMeters?: number;
  /** `true` to enable OpenVR mouse input on the overlay (desktop / interaction). */
  enableMouseInput?: boolean;
};

type SyncDisplayPosePayload = {
  hmd: OpenVR.HmdMatrix34;
  widthMeters: number;
  /** Overlay alpha, 0..1; absent means opaque. */
  opacity?: number;
  /** `SetOverlayCurvature`, 0..1; absent means flat. */
  curvature?: number;
  /** When set, `hmd` is relative to this tracked device (a controller carrying the window). */
  deviceIndex?: number;
  /** An absolute `hmd` is in raw tracking (webxr's anchored playspace frame), not Standing. */
  rawUniverse?: boolean;
};

type WorkspaceCrop = { x: number; y: number; width: number; height: number };
type SyncVirtualDisplayPayload = SyncDisplayPosePayload & {
  id: string;
  crop: WorkspaceCrop;
  name?: string;
};
type VirtualOverlay = SyncVirtualDisplayPayload & {
  handle: bigint;
  appliedAlpha?: number;
  appliedCurvature?: number;
  carry?: CarryState;
};

/**
 * A screen attached to a controller (`deviceIndex`) while its window is carried. On release
 * (FOLLOWRELEASE) it is frozen at once at the controller's current pose, and controller-relative
 * syncs still in flight are ignored until the worker's landed absolute pose arrives: otherwise
 * the compositor carries it on with the hand for the few ms that answer takes, then snaps back.
 */
type CarryState = {
  device?: number;
  relative?: OpenVR.HmdMatrix34;
  frozenAt?: number;
};
const CARRY_FREEZE_MAX_MS = 1000;
const mainCarry: CarryState = {};

/** Whether to apply a sync's transform; tracks what the overlay is attached to. */
function acceptCarriedTransform(carry: CarryState, sync: SyncDisplayPosePayload): boolean {
  if (carry.frozenAt != null) {
    const expired = performance.now() - carry.frozenAt > CARRY_FREEZE_MAX_MS;
    if (sync.deviceIndex != null && !expired) return false;
    carry.frozenAt = undefined;
  }
  carry.device = sync.deviceIndex;
  carry.relative = sync.deviceIndex == null ? undefined : sync.hmd;
  return true;
}

let releasePacer: ReturnType<typeof tryCreateOpenVrOverlayFramePacer> = null;

function freezeCarried(deviceIndex: number): void {
  const overlay = state.overlayClass;
  if (!overlay || state.systemPointer == null) return;
  releasePacer ??= tryCreateOpenVrOverlayFramePacer(
    state.systemPointer,
    null,
    true,
    false,
    "fast",
    "display-host-release",
  );
  if (!releasePacer) return;
  releasePacer.paceToDisplayAndRefreshPoses();
  const pose = releasePacer.getCachedTrackedDevicePose(deviceIndex);
  if (!pose) return;
  const freeze = (carry: CarryState, handle: bigint) => {
    if (carry.device !== deviceIndex || !carry.relative || !handle) return;
    setOverlayTransform(overlay, handle, composeDevicePose(pose.matrix, carry.relative));
    carry.device = undefined;
    carry.relative = undefined;
    carry.frozenAt = performance.now();
  };
  freeze(mainCarry, state.overlayHandle);
  for (const entry of virtualOverlays.values()) {
    if (entry.handle !== state.overlayHandle) freeze(entry.carry ??= {}, entry.handle);
  }
}

function syncUniverse(rawUniverse?: boolean): OpenVR.TrackingUniverseOrigin {
  return rawUniverse
    ? OpenVR.TrackingUniverseOrigin.TrackingUniverseRawAndUncalibrated
    : OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding;
}

/** Device pose (column-major 4×4) × device-relative 3×4 → absolute 3×4. */
function composeDevicePose(
  device: ArrayLike<number>,
  relative: OpenVR.HmdMatrix34,
): OpenVR.HmdMatrix34 {
  const r = relative.m;
  const m = [0, 1, 2].map((row) =>
    [0, 1, 2, 3].map((col) =>
      device[row] * r[0][col] + device[4 + row] * r[1][col] + device[8 + row] * r[2][col] +
      (col === 3 ? device[12 + row] : 0)
    )
  );
  return { m } as OpenVR.HmdMatrix34;
}
const virtualOverlays = new Map<string, VirtualOverlay>();
const pendingVirtualDisplays = new Map<string, SyncVirtualDisplayPayload>();
const virtualOverlayRemovalTimers = new Map<string, ReturnType<typeof setTimeout>>();
const VIRTUAL_OVERLAY_REMOVAL_GRACE_MS = 250;

type SetFrameDataPayload = {
  pixels: string | number[];
  encoding?: string;
  width: number;
  height: number;
};

function setTransformSafe(
  transform: OpenVR.HmdMatrix34,
  deviceIndex?: number,
  rawUniverse?: boolean,
) {
  if (!state.overlayClass || !state.overlayHandle) return;
  setOverlayTransform(
    state.overlayClass,
    state.overlayHandle,
    transform,
    deviceIndex,
    syncUniverse(rawUniverse),
  );
}

new PostMan(
  state,
  {
    __INIT__: (_payload: void) => {
      PostMan.setTopic("muffin");
      initializeDisplayOverlayOpenVr();
      void ensureWarmScreenCapturer().catch((error) => {
        LogChannel.error(
          "actor",
          `[displayOverlayHost] startup screen capture failed: ${
            error instanceof Error ? error.message : error
          }`,
        );
      });
    },
    __SHUTDOWN__: async (_payload: unknown) => {
      state.shuttingDown = true;
      if (captureRestartTimer != null) clearTimeout(captureRestartTimer);
      captureRestartTimer = null;
      await stopDisplayOverlayHost();
      releaseDisplayOverlayOpenVr();
    },
    __HEALTH__: (_payload: unknown) => {
      return getDisplayOverlayHostStatus();
    },
    __SNAPSHOT__: (_payload: unknown) => {
      return {
        startConfig: state.lastStartConfig,
        visible: state.visible,
      };
    },
    INPUTCONTROL: (payload: string) => {
      if (payload.startsWith("C,")) {
        updateCursorFromPointerControl(payload);
        return;
      }
      void state.screenCapturer?.sendControl(payload);
    },
    __RESTORE__: (
      payload: {
        startConfig?: StartDesktopPayload | null;
        visible?: boolean;
      } | null,
    ) => {
      if (payload?.startConfig) {
        state.lastStartConfig = payload.startConfig;
        state.visible = payload.visible ?? false;
        if (state.visible) {
          setTimeout(() => {
            PostMan.PostMessage({
              target: state.id,
              type: "STARTDESKTOP",
              payload: payload.startConfig,
            });
          }, 0);
        }
      }
      return true;
    },
    SUBSCRIBESTATUS: (payload: string) => {
      statusListener = payload;
    },
    STARTDESKTOP: (payload: StartDesktopPayload) => {
      if (!state.overlayClass) {
        throw new Error("Display overlay host OpenVR runtime is not initialized");
      }
      state.lastStartConfig = payload;
      void startDesktopWithRetry(payload).catch((error) => {
        LogChannel.error(
          "actor",
          `[displayOverlayHost] STARTDESKTOP unhandled failure: ${
            error instanceof Error ? error.message : error
          }`,
        );
        scheduleDeferredStartRetry(payload);
      });
    },
    CONFIGUREDESKTOP: (payload: StartDesktopPayload) => {
      state.lastStartConfig = payload;
      // The capturer is warmed at actor startup, before this config arrives, so
      // the helper is running at the default rate. Without this the configured
      // fps only moved the present-side gate and could never exceed it.
      void applyCaptureFps(clampCaptureFps(payload.captureFps));
      return getDisplayOverlayHostStatus();
    },
    WRIST_MENU_ACTION: (
      payload: { id: string; active: boolean },
    ) => {
      if (!isLayoutVisibilityAction(payload.id)) return getDisplayOverlayHostStatus();
      state.visible = payload.active;
      if (!payload.active) {
        if (state.overlayClass) {
          for (const entry of virtualOverlays.values()) {
            state.overlayClass.HideOverlay(entry.handle);
          }
        }
        return getDisplayOverlayHostStatus();
      }
      if (state.overlayClass && virtualOverlays.size > 0) {
        for (const entry of virtualOverlays.values()) {
          state.overlayClass.ShowOverlay(entry.handle);
        }
      } else if (state.lastStartConfig) {
        void startDesktopWithRetry(state.lastStartConfig);
      }
      return getDisplayOverlayHostStatus();
    },
    SYNCDISPLAYPOSE: (sync: SyncDisplayPosePayload) => {
      if (!state.overlayClass || !state.overlayHandle) return;
      const alpha = sync.opacity ?? 1;
      const curvature = sync.curvature ?? 0;
      if (
        state.lastHmd && matrixEquals(state.lastHmd, sync.hmd) &&
        state.lastDeviceIndex === sync.deviceIndex &&
        state.lastWidthMeters === sync.widthMeters &&
        state.lastAlpha === alpha &&
        state.lastCurvature === curvature
      ) {
        return;
      }
      if (state.lastAlpha !== alpha) {
        setOverlayAlphaLogged(state.overlayHandle, alpha, "display");
        state.lastAlpha = alpha;
      }
      if (state.lastCurvature !== curvature) {
        setOverlayCurvatureLogged(state.overlayHandle, curvature, "display");
        state.lastCurvature = curvature;
      }
      if (state.lastWidthMeters !== sync.widthMeters) {
        const wErr = state.overlayClass.SetOverlayWidthInMeters(
          state.overlayHandle,
          sync.widthMeters,
        );
        if (wErr !== OpenVR.OverlayError.VROverlayError_None) {
          LogChannel.log(
            "actor",
            `[displayOverlayHost] SetOverlayWidthInMeters: ${OpenVR.OverlayError[wErr]}`,
          );
        }
        state.lastWidthMeters = sync.widthMeters;
      }
      if (acceptCarriedTransform(mainCarry, sync)) {
        setTransformSafe(sync.hmd, sync.deviceIndex, sync.rawUniverse);
      }
      state.lastHmd = sync.hmd;
      state.lastDeviceIndex = sync.deviceIndex;
    },
    SYNCVIRTUALDISPLAY: (sync: SyncVirtualDisplayPayload) => {
      const removalTimer = virtualOverlayRemovalTimers.get(sync.id);
      if (removalTimer != null) {
        clearTimeout(removalTimer);
        virtualOverlayRemovalTimers.delete(sync.id);
      }
      pendingVirtualDisplays.set(sync.id, sync);
      if (!state.isRunning || !state.overlayClass || !state.textureStructPtr) return;
      syncVirtualDisplay(sync);
    },
    FOLLOWRELEASE: (payload: { deviceIndex: number }) => {
      freezeCarried(payload.deviceIndex);
    },
    REMOVEVIRTUALDISPLAY: (payload: { id: string }) => {
      pendingVirtualDisplays.delete(payload.id);
      const previousTimer = virtualOverlayRemovalTimers.get(payload.id);
      if (previousTimer != null) clearTimeout(previousTimer);
      // React development/StrictMode can replay an effect cleanup immediately before
      // mounting the same display again. Give the replacement SYNC a chance to cancel
      // removal so that transient UI reconciliation cannot destroy a live OpenVR handle.
      const timer = setTimeout(() => {
        virtualOverlayRemovalTimers.delete(payload.id);
        if (pendingVirtualDisplays.has(payload.id)) return;
        const entry = virtualOverlays.get(payload.id);
        if (!entry || !state.overlayClass) return;
        state.overlayClass.HideOverlay(entry.handle);
        state.overlayClass.DestroyOverlay(entry.handle);
        virtualOverlays.delete(payload.id);
        if (entry.handle === state.overlayHandle) state.overlayHandle = 0n;
      }, VIRTUAL_OVERLAY_REMOVAL_GRACE_MS);
      virtualOverlayRemovalTimers.set(payload.id, timer);
    },
    SETFRAMEDATA: (framePayload: SetFrameDataPayload) => {
      if (!state.isRunning) return;
      if (!state.textureStructPtr) throw new Error("no texture struct");
      if (!state.overlayClass) throw new Error("no overlay");
      if (!framePayload.pixels) throw new Error("pixels undefined");

      let pixelsArray: Uint8Array;
      if (framePayload.encoding === "base64") {
        const buffer = Buffer.from(framePayload.pixels as string, "base64");
        pixelsArray = new Uint8Array(
          buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        );
      } else {
        pixelsArray = new Uint8Array(framePayload.pixels as number[]);
      }
      if (!isUploadableBgraFrame(pixelsArray, framePayload.width, framePayload.height)) {
        throw new Error(
          `invalid frame ${framePayload.width}x${framePayload.height} (${pixelsArray.byteLength} bytes)`,
        );
      }
      if (!state.glManager) throw new Error("glManager is null");
      updateCaptureDimensions(framePayload.width, framePayload.height);
      state.glManager.createTextureFromData(pixelsArray, framePayload.width, framePayload.height);
      drawCursorIntoFrame();
      state.textureReady = true;
      for (const entry of virtualOverlays.values()) {
        const error = state.overlayClass.SetOverlayTexture(entry.handle, state.textureStructPtr);
        if (error !== OpenVR.OverlayError.VROverlayError_None) {
          LogChannel.log(
            "actor",
            `[displayOverlayHost] SetOverlayTexture(${entry.id}): ${OpenVR.OverlayError[error]}`,
          );
        }
      }
    },
    GETOVERLAYLOCATION: () => {
      if (!state.overlayClass || !state.overlayHandle) return;
      return getOverlayTransformAbsolute(state.overlayClass, state.overlayHandle);
    },
    SETOVERLAYLOCATION: (payload: OpenVR.HmdMatrix34) => {
      setTransformSafe(payload);
    },
    STOP: async () => {
      await stopDisplayOverlayHost();
      return true;
    },
  } as const,
);

function initializeDisplayOverlayOpenVr(): void {
  const pointers = openVrRuntime.initialize({
    overlay: "required",
    system: "optional",
    identity: {
      appKey: "petplay.display-overlay-host",
      name: "PetPlay Display Overlay Host",
    },
  });
  if (!pointers.overlay) throw new Error("Display overlay host IVROverlay unavailable");
  state.overlayClass = new OpenVR.IVROverlay(pointers.overlay);
  state.systemPointer = pointers.system == null
    ? null
    : BigInt(Deno.UnsafePointer.value(pointers.system as Deno.PointerObject));
  LogChannel.log("actor", `[displayOverlayHost] process-local IVROverlay ready (${state.id})`);
}

function releaseDisplayOverlayOpenVr(): void {
  state.overlayClass = null;
  state.systemPointer = null;
  releasePacer = null;
  if (Deno.build.os === "linux") {
    openVrRuntime.deferReleaseToProcessExit();
  } else {
    openVrRuntime.shutdown();
  }
}

function getDisplayOverlayHostStatus() {
  return {
    running: state.isRunning,
    starting: state.isStarting,
    overlayReady: state.overlayClass != null,
    overlayHandleActive: state.overlayHandle !== 0n,
    cursorInputSequence: state.cursorInputSequence,
    cursor: state.cursorDiagnostics,
    virtualOverlays: [...virtualOverlays.values()].map((entry) => ({
      id: entry.id,
      handle: entry.handle,
      crop: entry.crop,
      name: entry.name ?? null,
    })),
    glReady: state.glManager != null,
    screenCaptureActive: state.screenCapturer != null,
    captureFps: state.captureFps,
    captureFramesPresented: state.captureFramesPresented,
    visible: state.visible,
    screenCapture: state.screenCapturer?.getStatus() ?? null,
    hasTextureStruct: state.textureStructPtr != null,
    textureReady: state.textureReady,
    lastStartError: state.lastStartError,
  };
}

const SCREEN_STREAMER_PROCESS_NAME = Deno.build.os === "windows"
  ? "petplay-screen-streamer.exe"
  : "petplay-screen-streamer";
let screenStreamerPath: string | null = null;

function getScreenStreamerPath(): string {
  if (screenStreamerPath) return screenStreamerPath;
  const override = Deno.env.get("PETPLAY_SCREEN_STREAMER");
  if (override) {
    screenStreamerPath = override;
    return override;
  }
  const url = new URL(`../${screenStreamerRelativePath(nativeBuildTarget())}`, import.meta.url);
  let bytes: Uint8Array;
  try {
    bytes = Deno.readFileSync(url);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    throw new Error(
      "screen-streamer is missing. Run deno task build:native, or set PETPLAY_SCREEN_STREAMER.",
    );
  }
  const runtimeDir = tempDir();
  Deno.mkdirSync(runtimeDir, { recursive: true });
  screenStreamerPath = join(runtimeDir, SCREEN_STREAMER_PROCESS_NAME);
  Deno.writeFileSync(screenStreamerPath, bytes);
  if (Deno.build.os !== "windows") Deno.chmodSync(screenStreamerPath, 0o755);
  return screenStreamerPath;
}

/**
 * A forced app exit can orphan the Rust capture helper on Windows. Use a stable
 * executable name so the next display start can reliably remove only PetPlay's
 * stale helper before opening its replacement.
 */
async function stopStaleScreenStreamer(): Promise<void> {
  if (Deno.build.os !== "windows") return;
  try {
    await new Deno.Command("taskkill", {
      args: ["/F", "/IM", SCREEN_STREAMER_PROCESS_NAME],
      stdout: "null",
      stderr: "null",
    }).output();
  } catch (error) {
    LogChannel.log(
      "actor",
      `[displayOverlayHost] stale capture cleanup skipped: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
}

async function initScreenCapturer(fps: number): Promise<ScreenCapturer> {
  const { ScreenCapturer } = await import("../classes/ScreenCapturer/scclass.ts");
  const logStats = getWebxrFrameLogsEnabled();
  const portalStateDir = configDir();
  const capturer = new ScreenCapturer({
    debug: Deno.build.os !== "windows",
    fps,
    onStats: ({ fps, avgLatency }) => {
      if (!logStats) return;
      LogChannel.log(
        "screencap",
        `Display overlay — ${fps.toFixed(1)} fps, ${avgLatency.toFixed(1)} ms`,
      );
    },
    executablePath: getScreenStreamerPath(),
    captureTokenPath: join(portalStateDir, "screencast-restore-token"),
    onExit: (status) => {
      state.screenCapturer = null;
      warmCapturePromise = null;
      if (state.shuttingDown) return;
      const reason = capturer.getLastError();
      const message = `screen-streamer exited (code=${status.code}, success=${status.success})` +
        (reason ? `: ${reason}` : "");
      state.lastStartError = message;
      if (!capturer.hasReceivedFrame()) {
        // It never captured: the portal refused, was cancelled or found no source. Restarting
        // would open a new picker dialog every few seconds (and KDE ends a pending one when the
        // next request arrives), so wait for the user to open the desktop again instead.
        LogChannel.error("actor", `[displayOverlayHost] ${message}; not restarting capture`);
        postStatusToast({
          title: "Desktop capture unavailable",
          content: reason ??
            "The screen-sharing request did not complete. Open the desktop to retry.",
          tone: "warning",
        });
        void capturer.dispose();
        return;
      }
      void capturer.dispose().finally(() => scheduleCaptureRestart(message));
    },
  });
  await capturer.start();
  return capturer;
}

/**
 * Re-launch the capture helper when the requested rate changes. `--fps` is a
 * process argument, so an already-running helper cannot be re-rated in place.
 */
async function applyCaptureFps(fps: number): Promise<void> {
  if (state.captureFps === fps && state.screenCapturer?.getFps() === fps) return;
  state.captureFps = fps;
  const capturer = state.screenCapturer;
  if (capturer == null || capturer.getFps() === fps) return;
  LogChannel.log(
    "actor",
    `[displayOverlayHost] restarting screen capture at ${fps} fps (was ${capturer.getFps()})`,
  );
  state.screenCapturer = null;
  warmCapturePromise = null;
  try {
    await capturer.dispose();
  } catch (error) {
    LogChannel.error(
      "actor",
      `[displayOverlayHost] capture restart dispose failed: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
  await ensureWarmScreenCapturer();
}

async function ensureWarmScreenCapturer(): Promise<ScreenCapturer> {
  if (state.screenCapturer) return state.screenCapturer;
  if (warmCapturePromise) return await warmCapturePromise;
  warmCapturePromise = (async () => {
    await stopStaleScreenStreamer();
    const capturer = await initScreenCapturer(state.captureFps);
    state.screenCapturer = capturer;
    captureStartedAt = performance.now();
    if (captureRecovering) {
      captureRecovering = false;
      postStatusToast({ title: "Desktop capture reconnected" });
    }
    LogChannel.log("actor", "[displayOverlayHost] screen capture warmed at actor startup");
    return capturer;
  })();
  try {
    return await warmCapturePromise;
  } finally {
    warmCapturePromise = null;
  }
}

async function initGl(overlayName: string) {
  const { OpenGLManager } = await import("../classes/openglManager.ts");
  state.glManager = new OpenGLManager();
  state.glManager.initialize2D(overlayName);
  if (!state.glManager) throw new Error("glManager is null");
  state.glManager.setCursorSprite(
    createCursorPixels(),
    CURSOR_TEXTURE_WIDTH,
    CURSOR_TEXTURE_HEIGHT,
  );
}

function textureBoundsForCrop(crop: WorkspaceCrop): OpenVR.TextureBounds {
  const x = Math.max(0, Math.min(1, crop.x));
  const y = Math.max(0, Math.min(1, crop.y));
  const width = Math.max(0, Math.min(1 - x, crop.width));
  const height = Math.max(0, Math.min(1 - y, crop.height));
  return { uMin: x, uMax: x + width, vMin: y + height, vMax: y };
}

function createVirtualOverlayHandle(sync: SyncVirtualDisplayPayload): bigint {
  const overlay = state.overlayClass!;
  const baseKey = state.lastStartConfig?.overlayKey ?? "petplay.displayOverlayHost.desktop";
  const key = `${baseKey}.${sync.id}`;
  const createHandlePtr = P.BigUint64P<OpenVR.OverlayHandle>();
  let err = overlay.CreateOverlay(key, sync.name ?? sync.id, createHandlePtr);
  if (err === OpenVR.OverlayError.VROverlayError_KeyInUse) {
    const findPtr = P.BigUint64P<OpenVR.OverlayHandle>();
    const findError = overlay.FindOverlay(key, findPtr);
    if (findError !== OpenVR.OverlayError.VROverlayError_None) {
      throw new Error(`FindOverlay(${key}): ${OpenVR.OverlayError[findError]}`);
    }
    const stale = new Deno.UnsafePointerView(findPtr).getBigUint64();
    overlay.HideOverlay(stale);
    overlay.DestroyOverlay(stale);
    err = overlay.CreateOverlay(key, sync.name ?? sync.id, createHandlePtr);
  }
  if (err !== OpenVR.OverlayError.VROverlayError_None) {
    throw new Error(`CreateOverlay(${key}): ${OpenVR.OverlayError[err]}`);
  }
  return new Deno.UnsafePointerView(createHandlePtr).getBigUint64();
}

const CURSOR_TEXTURE_WIDTH = 32;
const CURSOR_TEXTURE_HEIGHT = 32;
/** Half-extent of the composited cursor, in capture-frame pixels. */
const CURSOR_DRAW_SIZE_PX = 12;

function createCursorPixels(): Uint8Array {
  const pixels = new Uint8Array(CURSOR_TEXTURE_WIDTH * CURSOR_TEXTURE_HEIGHT * 4);
  for (let y = 0; y < CURSOR_TEXTURE_HEIGHT; y++) {
    for (let x = 0; x < CURSOR_TEXTURE_WIDTH; x++) {
      const distance = Math.hypot(x + 0.5 - 16, y + 0.5 - 16);
      if (distance > 10) continue;
      const offset = (y * CURSOR_TEXTURE_WIDTH + x) * 4;
      const channel = distance >= 7.5 ? 12 : 245;
      pixels[offset] = channel;
      pixels[offset + 1] = channel;
      pixels[offset + 2] = channel;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

/**
 * Position comes from PetPlay's own desktop input path (the `C,x,y` control
 * emitted alongside the uinput stream), not from the system cursor, so it
 * tracks the VR ray exactly rather than the smoothed compositor cursor.
 */
function updateCursorFromPointerControl(command: string): void {
  if (!command.startsWith("C,")) return;
  state.cursorInputSequence++;
  const [, xText, yText] = command.split(",", 3);
  const workspaceX = Number(xText);
  const workspaceY = Number(yText);
  if (!Number.isFinite(workspaceX) || !Number.isFinite(workspaceY)) return;
  state.cursorWorkspacePosition = { x: workspaceX, y: workspaceY };
  // Repaint immediately rather than waiting for the next desktop frame, so the
  // cursor stays responsive even when the capture stream is slow or stalled.
  if (state.textureReady) {
    drawCursorIntoFrame();
    submitTextureToOverlays();
  }
}

/** Re-hand the (now updated) texture to every virtual display overlay. */
function submitTextureToOverlays(): void {
  if (!state.overlayClass || !state.textureStructPtr) return;
  for (const entry of virtualOverlays.values()) {
    state.overlayClass.SetOverlayTexture(entry.handle, state.textureStructPtr);
  }
}

/**
 * Blend our cursor into the shared desktop texture, the way Desktop+ does it
 * (DrawMouseToOverlayTex). Because every virtual display samples this one
 * texture through its own crop, the cursor automatically shows up on whichever
 * display contains it, with no per-overlay bookkeeping.
 */
function drawCursorIntoFrame(): void {
  const position = state.cursorWorkspacePosition;
  if (!position || !state.glManager) return;
  if (state.captureFrameWidth <= 0 || state.captureFrameHeight <= 0) return;
  const framePixelX = position.x * state.captureFrameWidth;
  const framePixelY = position.y * state.captureFrameHeight;
  state.glManager.compositeCursor(framePixelX, framePixelY, CURSOR_DRAW_SIZE_PX);
  state.cursorDiagnostics = {
    workspace: [position.x, position.y],
    framePixels: [framePixelX, framePixelY],
  };
}

function syncVirtualDisplay(sync: SyncVirtualDisplayPayload): void {
  const overlay = state.overlayClass!;
  let entry = virtualOverlays.get(sync.id);
  if (!entry) {
    const handle = sync.id === "display-1" && state.overlayHandle !== 0n
      ? state.overlayHandle
      : createVirtualOverlayHandle(sync);
    entry = { ...sync, handle };
    virtualOverlays.set(sync.id, entry);
    console.log(
      `[displayOverlayHost] virtual overlay ${sync.id} handle=${handle} crop=${
        JSON.stringify(sync.crop)
      }`,
    );
    overlay.SetOverlayInputMethod(
      handle,
      OpenVR.OverlayInputMethod.VROverlayInputMethod_Mouse,
    );
  } else {
    const cropChanged = JSON.stringify(entry.crop) !== JSON.stringify(sync.crop);
    Object.assign(entry, sync);
    if (cropChanged) {
      console.log(
        `[displayOverlayHost] virtual overlay ${sync.id} crop updated=${JSON.stringify(sync.crop)}`,
      );
    }
  }
  overlay.SetOverlayWidthInMeters(entry.handle, sync.widthMeters);
  const alpha = sync.opacity ?? 1;
  if (entry.appliedAlpha !== alpha) {
    setOverlayAlphaLogged(entry.handle, alpha, entry.id);
    entry.appliedAlpha = alpha;
  }
  const curvature = sync.curvature ?? 0;
  if (entry.appliedCurvature !== curvature) {
    setOverlayCurvatureLogged(entry.handle, curvature, entry.id);
    entry.appliedCurvature = curvature;
  }
  // TextureBounds already establishes the visible crop geometry in SteamVR.
  // Keep square texels; changing this stretches the monitor vertically.
  const aspectError = overlay.SetOverlayTexelAspect(entry.handle, 1);
  if (aspectError !== OpenVR.OverlayError.VROverlayError_None) {
    LogChannel.log(
      "actor",
      `[displayOverlayHost] SetOverlayTexelAspect(${entry.id}): ${
        OpenVR.OverlayError[aspectError]
      }`,
    );
  }
  setVirtualOverlayMouseScale(entry);
  const carry = entry.handle === state.overlayHandle ? mainCarry : (entry.carry ??= {});
  if (acceptCarriedTransform(carry, sync)) {
    setOverlayTransform(
      overlay,
      entry.handle,
      sync.hmd,
      sync.deviceIndex,
      syncUniverse(sync.rawUniverse),
    );
  }
  const [boundsPtr] = createStruct<OpenVR.TextureBounds>(
    withOverlayFlipY(textureBoundsForCrop(sync.crop)),
    OpenVR.TextureBoundsStruct,
  );
  overlay.SetOverlayTextureBounds(entry.handle, boundsPtr);
  if (state.textureReady && state.textureStructPtr) {
    overlay.SetOverlayTexture(entry.handle, state.textureStructPtr);
  }
  if (state.visible) overlay.ShowOverlay(entry.handle);
}

function setOverlayAlphaLogged(handle: bigint, alpha: number, label: string): void {
  const err = state.overlayClass?.SetOverlayAlpha(handle, alpha);
  if (err != null && err !== OpenVR.OverlayError.VROverlayError_None) {
    LogChannel.log(
      "actor",
      `[displayOverlayHost] SetOverlayAlpha(${label}): ${OpenVR.OverlayError[err]}`,
    );
  }
}

function setOverlayCurvatureLogged(handle: bigint, curvature: number, label: string): void {
  const err = state.overlayClass?.SetOverlayCurvature(handle, curvature);
  if (err != null && err !== OpenVR.OverlayError.VROverlayError_None) {
    LogChannel.log(
      "actor",
      `[displayOverlayHost] SetOverlayCurvature(${label}): ${OpenVR.OverlayError[err]}`,
    );
  }
}

function setVirtualOverlayMouseScale(entry: VirtualOverlay): void {
  if (!state.overlayClass) return;
  const [mouseScalePtr] = createStruct<OpenVR.HmdVector2>(
    {
      v: [
        Math.max(1, state.captureFrameWidth * entry.crop.width),
        Math.max(1, state.captureFrameHeight * entry.crop.height),
      ],
    },
    OpenVR.HmdVector2Struct,
  );
  const error = state.overlayClass.SetOverlayMouseScale(entry.handle, mouseScalePtr);
  if (error !== OpenVR.OverlayError.VROverlayError_None) {
    LogChannel.log(
      "actor",
      `[displayOverlayHost] SetOverlayMouseScale(${entry.id}): ${OpenVR.OverlayError[error]}`,
    );
  }
}

function updateCaptureDimensions(width: number, height: number): void {
  if (width === state.captureFrameWidth && height === state.captureFrameHeight) return;
  state.captureFrameWidth = width;
  state.captureFrameHeight = height;
  for (const entry of virtualOverlays.values()) setVirtualOverlayMouseScale(entry);
}

async function stopDesktopOverlay(): Promise<void> {
  state.isRunning = false;
  state.lastStartError = null;
  state.textureReady = false;

  for (const timer of virtualOverlayRemovalTimers.values()) clearTimeout(timer);
  virtualOverlayRemovalTimers.clear();

  // SteamVR imports the submitted OpenGL texture asynchronously. Detach and
  // destroy every overlay before deleting the GL texture; deleting it first
  // can leave vrcompositor importing a stale RADV image.
  if (state.overlayClass) {
    const handles = new Set([...virtualOverlays.values()].map((entry) => entry.handle));
    if (state.overlayHandle) handles.add(state.overlayHandle);
    for (const handle of handles) {
      try {
        state.overlayClass.HideOverlay(handle);
      } catch {
        // Ignore shutdown races.
      }
      try {
        state.overlayClass.ClearOverlayTexture(handle);
      } catch {
        // Ignore shutdown races.
      }
    }
    // Give the compositor a frame boundary to release imported GL images
    // before their owning context and texture names disappear.
    try {
      state.overlayClass.WaitFrameSync(100);
    } catch {
      // SteamVR may already be stopping.
    }
    for (const handle of handles) {
      try {
        state.overlayClass.DestroyOverlay(handle);
      } catch {
        // Ignore shutdown races.
      }
    }
  }

  if (state.glManager) {
    try {
      state.glManager.cleanup();
    } catch (error) {
      LogChannel.log(
        "actor",
        `[displayOverlayHost] gl cleanup failed: ${error instanceof Error ? error.message : error}`,
      );
    }
    state.glManager = null;
  }

  virtualOverlays.clear();

  state.overlayHandle = 0n;
  state.cursorWorkspacePosition = null;
  state.cursorDiagnostics = null;
  state.cursorInputSequence = 0;
  state.textureStructPtr = null;
  state.lastWidthMeters = -1;
  state.lastHmd = null;
  state.lastAlpha = -1;
  state.lastCurvature = -1;
  state.visible = false;
}

async function stopDisplayOverlayHost(): Promise<void> {
  clearDeferredStartRetry();
  state.lastStartConfig = null;
  await stopDesktopOverlay();
  if (state.screenCapturer) {
    await state.screenCapturer.dispose();
    state.screenCapturer = null;
  }
}

async function startDesktopWithRetry(config: StartDesktopPayload): Promise<void> {
  if (state.isStarting) {
    LogChannel.log("actor", "[displayOverlayHost] STARTDESKTOP ignored (already starting)");
    return;
  }
  state.isStarting = true;

  try {
    if (state.isRunning || state.glManager || state.overlayHandle) {
      await stopDesktopOverlay();
      await wait(120);
    }

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= START_DESKTOP_MAX_ATTEMPTS; attempt++) {
      try {
        await startDesktopOpenVrOverlay(config);
        clearDeferredStartRetry();
        return;
      } catch (error) {
        lastError = error;
        await stopDesktopOverlay();
        if (attempt < START_DESKTOP_MAX_ATTEMPTS) {
          LogChannel.log(
            "actor",
            `[displayOverlayHost] STARTDESKTOP attempt ${attempt} failed, retrying: ${
              error instanceof Error ? error.message : error
            }`,
          );
          await wait(START_DESKTOP_RETRY_WAIT_MS * attempt);
          continue;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  } catch (error) {
    state.lastStartError = error instanceof Error ? error.message : String(error);
    LogChannel.error(
      "actor",
      `[displayOverlayHost] STARTDESKTOP failed: ${error instanceof Error ? error.message : error}`,
    );
    scheduleDeferredStartRetry(config);
  } finally {
    state.isStarting = false;
  }
}

function clearDeferredStartRetry(): void {
  if (state.restartTimerId != null) {
    clearTimeout(state.restartTimerId);
    state.restartTimerId = null;
  }
}

function scheduleDeferredStartRetry(config: StartDesktopPayload): void {
  if (state.restartTimerId != null || state.isRunning || state.isStarting) {
    return;
  }
  state.restartTimerId = setTimeout(() => {
    state.restartTimerId = null;
    if (!state.overlayClass) {
      return;
    }
    const retryConfig = state.lastStartConfig ?? config;
    void startDesktopWithRetry(retryConfig);
  }, START_DESKTOP_DEFERRED_RETRY_MS);
  LogChannel.log("actor", "[displayOverlayHost] scheduled deferred STARTDESKTOP retry");
}

function createTextureFromScreenshot(pixels: Uint8Array, width: number, height: number): void {
  if (!state.glManager) throw new Error("glManager is null");
  state.glManager.createTextureFromBgraScreenshot(pixels, width, height);
}

function isUploadableBgraFrame(pixels: Uint8Array, width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    pixels.byteLength >= width * height * 4;
}

async function deskCapLoop(
  overlay: OpenVR.IVROverlay,
  textureStructPtr: Deno.PointerValue<OpenVR.Texture>,
) {
  if (!state.screenCapturer) return;
  const maxFrames = state.captureFrames;
  const continuous = maxFrames === 0;
  let frameCount = 0;
  let lastFrame: CapturedFrame | null = null;
  let nextPresentAt = 0;
  while (state.isRunning && (continuous || frameCount < maxFrames)) {
    // Follow the current helper: a lost stream is replaced by scheduleCaptureRestart, and a
    // helper that never captured is not replaced until the user opens the desktop again.
    const capturer = state.screenCapturer;
    if (!capturer) {
      await wait(250);
      continue;
    }
    const frame: CapturedFrame | null = await capturer.getNextFrame(lastFrame, 1_000).catch(() =>
      null
    );
    if (!frame) {
      continue;
    }
    const now = performance.now();
    if (now < nextPresentAt) {
      await wait(Math.max(1, nextPresentAt - now));
      continue;
    }
    lastFrame = frame;
    if (!isUploadableBgraFrame(frame.data, frame.width, frame.height)) {
      LogChannel.error(
        "actor",
        `[displayOverlayHost] skipped invalid capture frame ${frame.width}x${frame.height} (${frame.data.byteLength} bytes)`,
      );
      continue;
    }
    frameCount++;
    updateCaptureDimensions(frame.width, frame.height);
    createTextureFromScreenshot(frame.data, frame.width, frame.height);
    drawCursorIntoFrame();
    state.textureReady = true;
    for (const entry of virtualOverlays.values()) {
      const err = overlay.SetOverlayTexture(entry.handle, textureStructPtr);
      if (err !== OpenVR.OverlayError.VROverlayError_None) {
        LogChannel.error(
          "actor",
          `SetOverlayTexture(${entry.id}): ${OpenVR.OverlayError[err]}`,
        );
      }
    }
    state.captureFramesPresented++;
    nextPresentAt = performance.now() + 1000 / state.captureFps;
  }
  if (!continuous) {
    state.isRunning = false;
  }
  LogChannel.log("actor", `[displayOverlayHost] screen capture loop ended (frames: ${frameCount})`);
}

async function startDesktopOpenVrOverlay(config: StartDesktopPayload) {
  const overlay = state.overlayClass as OpenVR.IVROverlay;
  const overlayKey = config.overlayKey;
  const name = config.displayName;
  const widthM = config.initialWidthMeters ?? 0.5 * (16 / 9);

  state.isRunning = true;
  state.captureFrames = config.captureFrameLimit ?? 0;
  state.captureFps = clampCaptureFps(config.captureFps);
  state.captureFramesPresented = 0;
  state.textureReady = false;
  state.lastWidthMeters = -1;
  state.lastHmd = null;
  state.lastAlpha = -1;
  state.lastCurvature = -1;

  await initGl(overlayKey);
  const createHandlePtr = P.BigUint64P<OpenVR.OverlayHandle>();
  let err = overlay.CreateOverlay(overlayKey, name, createHandlePtr);
  let overlayHandle: bigint;
  if (err === OpenVR.OverlayError.VROverlayError_None) {
    overlayHandle = new Deno.UnsafePointerView(createHandlePtr).getBigUint64();
  } else if (err === OpenVR.OverlayError.VROverlayError_KeyInUse) {
    const findPtr = P.BigUint64P<OpenVR.OverlayHandle>();
    const fErr = overlay.FindOverlay(overlayKey, findPtr);
    if (fErr !== OpenVR.OverlayError.VROverlayError_None) {
      throw new Error(`FindOverlay(${overlayKey}): ${OpenVR.OverlayError[fErr]}`);
    }
    const staleHandle = new Deno.UnsafePointerView(findPtr).getBigUint64();
    try {
      overlay.HideOverlay(staleHandle);
    } catch {
      // A stale overlay may already be hidden or detached.
    }
    const destroyErr = overlay.DestroyOverlay(staleHandle);
    if (destroyErr !== OpenVR.OverlayError.VROverlayError_None) {
      throw new Error(`Destroy stale overlay (${overlayKey}): ${OpenVR.OverlayError[destroyErr]}`);
    }
    err = overlay.CreateOverlay(overlayKey, name, createHandlePtr);
    if (err !== OpenVR.OverlayError.VROverlayError_None) {
      throw new Error(`RecreateOverlay: ${OpenVR.OverlayError[err]}`);
    }
    overlayHandle = new Deno.UnsafePointerView(createHandlePtr).getBigUint64();
    LogChannel.log("actor", `[displayOverlayHost] replaced stale overlay key ${overlayKey}`);
  } else {
    throw new Error(`CreateOverlay: ${OpenVR.OverlayError[err]}`);
  }
  state.overlayHandle = overlayHandle;

  overlay.SetOverlayWidthInMeters(overlayHandle, widthM);
  // Windows.Graphics.Capture is top-down. Flip sampling in OpenVR instead of
  // copying/flipping the entire desktop frame on the CPU before every upload.
  const bounds = config.runScreenCapture
    ? { uMin: 0, uMax: 1, vMin: 1, vMax: 0 }
    : { uMin: 0, uMax: 1, vMin: 0, vMax: 1 };
  const [boundsPtr, _] = createStruct<OpenVR.TextureBounds>(
    withOverlayFlipY(bounds),
    OpenVR.TextureBoundsStruct,
  );
  overlay.SetOverlayTextureBounds(overlayHandle, boundsPtr);

  const idTransform: OpenVR.HmdMatrix34 = {
    m: [
      [1, 0, 0, 0],
      [0, 1, 0, 1],
      [0, 0, 1, -2.5],
    ],
  };
  setTransformSafe(idTransform);

  if (config.enableMouseInput !== false) {
    const im = overlay.SetOverlayInputMethod(
      overlayHandle,
      OpenVR.OverlayInputMethod.VROverlayInputMethod_Mouse,
    );
    if (im !== OpenVR.OverlayError.VROverlayError_None) {
      LogChannel.log(
        "actor",
        `[displayOverlayHost] SetOverlayInputMethod: ${OpenVR.OverlayError[im]}`,
      );
    }
  }

  // The primary handle stays hidden until the scene syncs `display-1` onto it.
  // Showing it here put an uncropped copy of the whole capture in front of the
  // user whenever the layout's displays had other ids (one per monitor).
  state.visible = true;

  const texture = state.glManager!.getTexture();
  if (!texture) throw new Error("texture is null");
  const textureData: OpenVR.Texture = {
    handle: BigInt(texture[0]) as unknown as Deno.PointerValue<unknown>,
    eType: OpenVR.TextureType.TextureType_OpenGL,
    eColorSpace: OpenVR.ColorSpace.ColorSpace_Auto,
  };
  const [textureStructPtr] = createStruct<OpenVR.Texture>(textureData, OpenVR.TextureStruct);
  state.textureStructPtr = textureStructPtr;

  for (const sync of pendingVirtualDisplays.values()) syncVirtualDisplay(sync);

  if (config.runScreenCapture) {
    await ensureWarmScreenCapturer();
    void deskCapLoop(overlay, textureStructPtr).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      LogChannel.error("actor", `[displayOverlayHost] screen capture loop failed: ${message}`);
      void stopDesktopOverlay().then(() => {
        state.lastStartError = message;
        scheduleDeferredStartRetry(config);
      });
    });
  } else {
    LogChannel.log(
      "actor",
      "[displayOverlayHost] overlay up without local capture; use SETFRAMEDATA for texture",
    );
  }

  LogChannel.log(
    "actor",
    `[displayOverlayHost] desktop overlay started key=${overlayKey} handle=${overlayHandle}`,
  );
}

globalThis.addEventListener("unload", async () => {
  state.isRunning = false;
  if (state.screenCapturer) {
    await state.screenCapturer.dispose();
    state.screenCapturer = null;
  }
});
