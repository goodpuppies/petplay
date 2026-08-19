import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import { Buffer } from "node:buffer";
import { join } from "@std/path";
import { wait } from "../classes/utils.ts";
import {
  clampCaptureFps,
  DEFAULT_CAPTURE_FPS,
  type ScreenCapturer,
} from "../classes/ScreenCapturer/scclass.ts";
import type { OpenGLManager } from "../classes/openglManager.ts";
import {
  getOverlayTransformAbsolute,
  setOverlayTransformAbsolute,
} from "../classes/openvrTransform.ts";
import { matrixEquals } from "../classes/matrixutils.ts";

const state = actorState({
  name: "display_instance",
  overlayClass: null as OpenVR.IVROverlay | null,
  overlayHandle: 0n,
  cursorTargetDisplayId: null as string | null,
  cursorTargetHandle: 0n,
  cursorWorkspacePosition: null as { x: number; y: number } | null,
  cursorInputSequence: 0,
  cursorDiagnostics: null as {
    targetId: string;
    workspace: [number, number];
    localUv: [number, number];
    submittedMouse: [number, number];
    configuredMouseScale: [number, number];
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
  captureFrames: 0,
  captureFps: DEFAULT_CAPTURE_FPS,
  captureFramesPresented: 0,
  captureFrameWidth: 1,
  captureFrameHeight: 1,
  lastStartConfig: null as StartDesktopPayload | null,
  overlayPointer: null as bigint | null,
  restartTimerId: null as ReturnType<typeof setTimeout> | null,
  visible: false,
  shuttingDown: false,
});

let warmCapturePromise: Promise<ScreenCapturer> | null = null;

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
};

type WorkspaceCrop = { x: number; y: number; width: number; height: number };
type SyncVirtualDisplayPayload = SyncDisplayPosePayload & {
  id: string;
  crop: WorkspaceCrop;
  name?: string;
};
type VirtualOverlay = SyncVirtualDisplayPayload & { handle: bigint };
const virtualOverlays = new Map<string, VirtualOverlay>();
const pendingVirtualDisplays = new Map<string, SyncVirtualDisplayPayload>();
const cursorOverlays = new Map<string, { handle: bigint; targetHandle: bigint }>();
const virtualOverlayRemovalTimers = new Map<string, ReturnType<typeof setTimeout>>();
const VIRTUAL_OVERLAY_REMOVAL_GRACE_MS = 250;

type SetFrameDataPayload = {
  pixels: string | number[];
  encoding?: string;
  width: number;
  height: number;
};

function setTransformSafe(transform: OpenVR.HmdMatrix34) {
  if (!state.overlayClass || !state.overlayHandle) return;
  setOverlayTransformAbsolute(state.overlayClass, state.overlayHandle, transform);
}

new PostMan(
  state,
  {
    __INIT__: (_payload: void) => {
      PostMan.setTopic("muffin");
      void ensureWarmScreenCapturer().catch((error) => {
        LogChannel.error(
          "actor",
          `[displayInstance] startup screen capture failed: ${
            error instanceof Error ? error.message : error
          }`,
        );
      });
    },
    __SHUTDOWN__: async (_payload: unknown) => {
      state.shuttingDown = true;
      await stopDisplayInstance();
    },
    __HEALTH__: (_payload: unknown) => {
      return getDisplayInstanceStatus();
    },
    __SNAPSHOT__: (_payload: unknown) => {
      return {
        overlayPointer: state.overlayPointer,
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
        overlayPointer?: bigint | null;
        startConfig?: StartDesktopPayload | null;
        visible?: boolean;
      } | null,
    ) => {
      if (payload?.overlayPointer != null) {
        PostMan.PostMessage({
          target: state.id,
          type: "INITOVROVERLAY",
          payload: payload.overlayPointer,
        });
      }
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
    INITOVROVERLAY: (payload: bigint) => {
      state.overlayPointer = payload;
      const systemPtr = Deno.UnsafePointer.create(payload);
      state.overlayClass = new OpenVR.IVROverlay(systemPtr);
      LogChannel.log("actor", `[displayInstance] IVROverlay ready (${state.id})`);
    },
    STARTDESKTOP: (payload: StartDesktopPayload) => {
      if (!state.overlayClass) {
        throw new Error("Call INITOVROVERLAY before STARTDESKTOP");
      }
      state.lastStartConfig = payload;
      void startDesktopWithRetry(payload).catch((error) => {
        LogChannel.error(
          "actor",
          `[displayInstance] STARTDESKTOP unhandled failure: ${
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
      return getDisplayInstanceStatus();
    },
    WRIST_MENU_ACTION: (
      payload: { id: string; active: boolean },
    ) => {
      if (payload.id !== "layers") return getDisplayInstanceStatus();
      state.visible = payload.active;
      if (!payload.active) {
        if (state.overlayClass) {
          for (const entry of virtualOverlays.values()) {
            state.overlayClass.HideOverlay(entry.handle);
          }
        }
        return getDisplayInstanceStatus();
      }
      if (state.overlayClass && virtualOverlays.size > 0) {
        for (const entry of virtualOverlays.values()) {
          state.overlayClass.ShowOverlay(entry.handle);
        }
      } else if (state.lastStartConfig) {
        void startDesktopWithRetry(state.lastStartConfig);
      }
      return getDisplayInstanceStatus();
    },
    SYNCDISPLAYPOSE: (sync: SyncDisplayPosePayload) => {
      if (!state.overlayClass || !state.overlayHandle) return;
      if (
        state.lastHmd && matrixEquals(state.lastHmd, sync.hmd) &&
        state.lastWidthMeters === sync.widthMeters
      ) {
        return;
      }
      if (state.lastWidthMeters !== sync.widthMeters) {
        const wErr = state.overlayClass.SetOverlayWidthInMeters(
          state.overlayHandle,
          sync.widthMeters,
        );
        if (wErr !== OpenVR.OverlayError.VROverlayError_None) {
          LogChannel.log(
            "actor",
            `[displayInstance] SetOverlayWidthInMeters: ${OpenVR.OverlayError[wErr]}`,
          );
        }
        state.lastWidthMeters = sync.widthMeters;
      }
      setTransformSafe(sync.hmd);
      state.lastHmd = sync.hmd;
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
        destroyCursorOverlay(payload.id);
        if (entry.handle === state.cursorTargetHandle) {
          state.cursorTargetDisplayId = null;
          state.cursorTargetHandle = 0n;
        }
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
      state.textureReady = true;
      for (const entry of virtualOverlays.values()) {
        const error = state.overlayClass.SetOverlayTexture(entry.handle, state.textureStructPtr);
        if (error !== OpenVR.OverlayError.VROverlayError_None) {
          LogChannel.log(
            "actor",
            `[displayInstance] SetOverlayTexture(${entry.id}): ${OpenVR.OverlayError[error]}`,
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
      await stopDisplayInstance();
      return true;
    },
  } as const,
);

function getDisplayInstanceStatus() {
  return {
    running: state.isRunning,
    starting: state.isStarting,
    overlayReady: state.overlayClass != null,
    overlayHandleActive: state.overlayHandle !== 0n,
    cursorOverlayHandle: state.cursorTargetDisplayId
      ? cursorOverlays.get(state.cursorTargetDisplayId)?.handle ?? 0n
      : 0n,
    cursorOverlays: [...cursorOverlays.entries()].map(([id, cursor]) => ({
      id,
      handle: cursor.handle,
      targetHandle: cursor.targetHandle,
    })),
    cursorInputSequence: state.cursorInputSequence,
    cursor: state.cursorDiagnostics == null ? null : {
      ...state.cursorDiagnostics,
      targetHandle: state.cursorTargetHandle,
    },
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
  const resourceName = Deno.build.os === "windows" ? "screen-streamer.exe" : "screen-streamer";
  const url = new URL(`../resources/${resourceName}`, import.meta.url);
  const bytes = Deno.readFileSync(url);
  const runtimeDir = join(Deno.cwd(), "tmp");
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
      `[displayInstance] stale capture cleanup skipped: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
}

async function initScreenCapturer(fps: number): Promise<ScreenCapturer> {
  const { ScreenCapturer } = await import("../classes/ScreenCapturer/scclass.ts");
  const logStats = getWebxrFrameLogsEnabled();
  const configHome = Deno.env.get("XDG_CONFIG_HOME") ??
    join(Deno.env.get("HOME") ?? Deno.cwd(), ".config");
  const portalStateDir = join(configHome, "petplay");
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
      const message = `screen-streamer exited (code=${status.code}, success=${status.success})`;
      LogChannel.error("actor", `[displayInstance] ${message}; restarting warm capture`);
      state.lastStartError = message;
      void capturer.dispose().finally(() => ensureWarmScreenCapturer());
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
    `[displayInstance] restarting screen capture at ${fps} fps (was ${capturer.getFps()})`,
  );
  state.screenCapturer = null;
  warmCapturePromise = null;
  try {
    await capturer.dispose();
  } catch (error) {
    LogChannel.error(
      "actor",
      `[displayInstance] capture restart dispose failed: ${
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
    LogChannel.log("actor", "[displayInstance] screen capture warmed at actor startup");
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
  const baseKey = state.lastStartConfig?.overlayKey ?? "petplay.displayInstance.desktop";
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

function ensureCursorOverlay(target: VirtualOverlay): bigint {
  if (!state.overlayClass) return 0n;
  const overlay = state.overlayClass;
  const existing = cursorOverlays.get(target.id);
  if (existing) {
    if (existing.targetHandle !== target.handle) {
      attachCursorToOverlay(target.handle, existing.handle);
      existing.targetHandle = target.handle;
    }
    return existing.handle;
  }
  const baseKey = state.lastStartConfig?.overlayKey ?? "petplay.displayInstance.desktop";
  const key = `${baseKey}.cursor.${target.id}`;
  const handlePtr = P.BigUint64P<OpenVR.OverlayHandle>();
  let error = overlay.CreateOverlay(key, "PetPlay Cursor", handlePtr);
  if (error === OpenVR.OverlayError.VROverlayError_KeyInUse) {
    const stalePtr = P.BigUint64P<OpenVR.OverlayHandle>();
    const findError = overlay.FindOverlay(key, stalePtr);
    if (findError === OpenVR.OverlayError.VROverlayError_None) {
      const stale = new Deno.UnsafePointerView(stalePtr).getBigUint64();
      overlay.HideOverlay(stale);
      overlay.DestroyOverlay(stale);
      error = overlay.CreateOverlay(key, "PetPlay Cursor", handlePtr);
    }
  }
  if (error !== OpenVR.OverlayError.VROverlayError_None) {
    throw new Error(`Create cursor overlay: ${OpenVR.OverlayError[error]}`);
  }

  const handle = new Deno.UnsafePointerView(handlePtr).getBigUint64();
  const pixels = createCursorPixels();
  const rawError = overlay.SetOverlayRaw(
    handle,
    Deno.UnsafePointer.of(pixels),
    CURSOR_TEXTURE_WIDTH,
    CURSOR_TEXTURE_HEIGHT,
    4,
  );
  if (rawError !== OpenVR.OverlayError.VROverlayError_None) {
    overlay.DestroyOverlay(handle);
    throw new Error(`SetOverlayRaw(cursor): ${OpenVR.OverlayError[rawError]}`);
  }
  overlay.SetOverlayWidthInMeters(handle, 0.018);
  overlay.SetOverlayTexelAspect(handle, 1);
  const [hotspotPtr] = createStruct<OpenVR.HmdVector2>(
    { v: [0.5, 0.5] },
    OpenVR.HmdVector2Struct,
  );
  const transformError = overlay.SetOverlayTransformCursor(handle, hotspotPtr);
  if (transformError !== OpenVR.OverlayError.VROverlayError_None) {
    overlay.DestroyOverlay(handle);
    throw new Error(`SetOverlayTransformCursor: ${OpenVR.OverlayError[transformError]}`);
  }
  attachCursorToOverlay(target.handle, handle);
  cursorOverlays.set(target.id, { handle, targetHandle: target.handle });
  LogChannel.log(
    "actor",
    `[displayInstance] cursor overlay ${target.id} ready handle=${handle}`,
  );
  return handle;
}

function attachCursorToOverlay(targetHandle: bigint, cursorHandle: bigint): void {
  if (!state.overlayClass || !cursorHandle) return;
  const error = state.overlayClass.SetOverlayCursor(targetHandle, cursorHandle);
  if (error !== OpenVR.OverlayError.VROverlayError_None) {
    LogChannel.log(
      "actor",
      `[displayInstance] SetOverlayCursor: ${OpenVR.OverlayError[error]}`,
    );
  }
}

function destroyCursorOverlay(id: string): void {
  const cursor = cursorOverlays.get(id);
  if (!cursor) return;
  if (state.overlayClass) {
    state.overlayClass.SetOverlayCursor(cursor.targetHandle, 0n);
    state.overlayClass.HideOverlay(cursor.handle);
    state.overlayClass.DestroyOverlay(cursor.handle);
  }
  cursorOverlays.delete(id);
}

const cursorPosition = new Float32Array(2);

function updateCursorFromPointerControl(command: string): void {
  if (!command.startsWith("C,") || !state.overlayClass) return;
  state.cursorInputSequence++;
  const [, xText, yText] = command.split(",", 3);
  const workspaceX = Number(xText);
  const workspaceY = Number(yText);
  if (!Number.isFinite(workspaceX) || !Number.isFinite(workspaceY)) return;
  state.cursorWorkspacePosition = { x: workspaceX, y: workspaceY };
  updateCursorOverlayPose(workspaceX, workspaceY);
}

function updateCursorOverlayPose(workspaceX: number, workspaceY: number): void {
  if (!state.overlayClass) return;
  const target = [...virtualOverlays.values()].find(({ crop }) =>
    workspaceX >= crop.x && workspaceX <= crop.x + crop.width &&
    workspaceY >= crop.y && workspaceY <= crop.y + crop.height
  );
  if (!target || target.crop.width <= 0 || target.crop.height <= 0) return;

  const cursorHandle = ensureCursorOverlay(target);
  if (!cursorHandle) return;
  if (state.cursorTargetDisplayId && state.cursorTargetDisplayId !== target.id) {
    const previous = cursorOverlays.get(state.cursorTargetDisplayId);
    if (previous) {
      cursorPosition[0] = -100_000;
      cursorPosition[1] = -100_000;
      state.overlayClass.SetOverlayCursorPositionOverride(
        previous.targetHandle,
        Deno.UnsafePointer.of(cursorPosition) as Deno.PointerValue<OpenVR.HmdVector2>,
      );
    }
  }
  state.cursorTargetDisplayId = target.id;
  state.cursorTargetHandle = target.handle;
  // Reassert the per-display association in case SteamVR rebuilt the target.
  attachCursorToOverlay(target.handle, cursorHandle);

  const localX = Math.min(
    1,
    Math.max(0, (workspaceX - target.crop.x) / target.crop.width),
  );
  const localY = Math.min(
    1,
    Math.max(0, (workspaceY - target.crop.y) / target.crop.height),
  );

  const mouseWidth = Math.max(1, state.captureFrameWidth * target.crop.width);
  const mouseHeight = Math.max(1, state.captureFrameHeight * target.crop.height);
  cursorPosition[0] = localX * mouseWidth;
  // SteamVR's cursor transform spans a square whose physical side is the
  // overlay width, irrespective of the target texture aspect. Fit the cursor's
  // vertical range into the centered visible monitor height. For 1920x1080
  // this is a 9/16 multiplier around the midpoint.
  const heightOverWidth = mouseHeight / mouseWidth;
  const cursorY = 0.5 + (0.5 - localY) * heightOverWidth;
  cursorPosition[1] = cursorY * mouseHeight;
  const pointer = Deno.UnsafePointer.of(cursorPosition) as Deno.PointerValue<OpenVR.HmdVector2>;
  const error = state.overlayClass.SetOverlayCursorPositionOverride(
    target.handle,
    pointer,
  );
  if (error !== OpenVR.OverlayError.VROverlayError_None) {
    LogChannel.log(
      "actor",
      `[displayInstance] SetOverlayCursorPositionOverride: ${OpenVR.OverlayError[error]}`,
    );
    return;
  }
  state.cursorDiagnostics = {
    targetId: target.id,
    workspace: [workspaceX, workspaceY],
    localUv: [localX, localY],
    submittedMouse: [cursorPosition[0], cursorPosition[1]],
    configuredMouseScale: [mouseWidth, mouseHeight],
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
      `[displayInstance] virtual overlay ${sync.id} handle=${handle} crop=${
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
        `[displayInstance] virtual overlay ${sync.id} crop updated=${JSON.stringify(sync.crop)}`,
      );
    }
  }
  overlay.SetOverlayWidthInMeters(entry.handle, sync.widthMeters);
  // TextureBounds already establishes the visible crop geometry in SteamVR.
  // Keep square texels; changing this stretches the monitor vertically.
  const aspectError = overlay.SetOverlayTexelAspect(entry.handle, 1);
  if (aspectError !== OpenVR.OverlayError.VROverlayError_None) {
    LogChannel.log(
      "actor",
      `[displayInstance] SetOverlayTexelAspect(${entry.id}): ${OpenVR.OverlayError[aspectError]}`,
    );
  }
  setVirtualOverlayMouseScale(entry);
  setOverlayTransformAbsolute(overlay, entry.handle, sync.hmd);
  const [boundsPtr] = createStruct<OpenVR.TextureBounds>(
    textureBoundsForCrop(sync.crop),
    OpenVR.TextureBoundsStruct,
  );
  overlay.SetOverlayTextureBounds(entry.handle, boundsPtr);
  if (state.textureReady && state.textureStructPtr) {
    overlay.SetOverlayTexture(entry.handle, state.textureStructPtr);
  }
  if (state.visible) overlay.ShowOverlay(entry.handle);
  if (state.cursorTargetDisplayId === entry.id && state.cursorWorkspacePosition) {
    updateCursorOverlayPose(
      state.cursorWorkspacePosition.x,
      state.cursorWorkspacePosition.y,
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
      `[displayInstance] SetOverlayMouseScale(${entry.id}): ${OpenVR.OverlayError[error]}`,
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
    for (const cursor of cursorOverlays.values()) handles.add(cursor.handle);
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
        `[displayInstance] gl cleanup failed: ${error instanceof Error ? error.message : error}`,
      );
    }
    state.glManager = null;
  }

  virtualOverlays.clear();
  cursorOverlays.clear();

  state.overlayHandle = 0n;
  state.cursorTargetDisplayId = null;
  state.cursorTargetHandle = 0n;
  state.cursorWorkspacePosition = null;
  state.cursorDiagnostics = null;
  state.cursorInputSequence = 0;
  state.textureStructPtr = null;
  state.lastWidthMeters = -1;
  state.lastHmd = null;
  state.visible = false;
}

async function stopDisplayInstance(): Promise<void> {
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
    LogChannel.log("actor", "[displayInstance] STARTDESKTOP ignored (already starting)");
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
            `[displayInstance] STARTDESKTOP attempt ${attempt} failed, retrying: ${
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
      `[displayInstance] STARTDESKTOP failed: ${error instanceof Error ? error.message : error}`,
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
  LogChannel.log("actor", "[displayInstance] scheduled deferred STARTDESKTOP retry");
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
  const capturer = state.screenCapturer;
  let lastFrame: Awaited<ReturnType<typeof capturer.getLatestFrame>> = null;
  let nextPresentAt = 0;
  while (state.isRunning && (continuous || frameCount < maxFrames)) {
    const frame = await capturer.getNextFrame(lastFrame, 1_000);
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
        `[displayInstance] skipped invalid capture frame ${frame.width}x${frame.height} (${frame.data.byteLength} bytes)`,
      );
      continue;
    }
    frameCount++;
    updateCaptureDimensions(frame.width, frame.height);
    createTextureFromScreenshot(frame.data, frame.width, frame.height);
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
  LogChannel.log("actor", `[displayInstance] screen capture loop ended (frames: ${frameCount})`);
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
    LogChannel.log("actor", `[displayInstance] replaced stale overlay key ${overlayKey}`);
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
  const [boundsPtr, _] = createStruct<OpenVR.TextureBounds>(bounds, OpenVR.TextureBoundsStruct);
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
        `[displayInstance] SetOverlayInputMethod: ${OpenVR.OverlayError[im]}`,
      );
    }
  }

  state.visible = true;
  overlay.ShowOverlay(overlayHandle);

  const texture = state.glManager!.getTexture();
  if (!texture) throw new Error("texture is null");
  const textureData: OpenVR.Texture = {
    handle: BigInt(texture[0]) as unknown as Deno.PointerValue<unknown>,
    eType: OpenVR.TextureType.TextureType_OpenGL,
    eColorSpace: OpenVR.ColorSpace.ColorSpace_Auto,
  };
  const [textureStructPtr] = createStruct<OpenVR.Texture>(textureData, OpenVR.TextureStruct);
  state.textureStructPtr = textureStructPtr;

  const primarySync = pendingVirtualDisplays.get("display-1") ?? {
    id: "display-1",
    name,
    hmd: idTransform,
    widthMeters: widthM,
    crop: { x: 0, y: 0, width: 1, height: 1 },
  };
  syncVirtualDisplay(primarySync);
  for (const sync of pendingVirtualDisplays.values()) syncVirtualDisplay(sync);

  if (config.runScreenCapture) {
    await ensureWarmScreenCapturer();
    void deskCapLoop(overlay, textureStructPtr).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      LogChannel.error("actor", `[displayInstance] screen capture loop failed: ${message}`);
      void stopDesktopOverlay().then(() => {
        state.lastStartError = message;
        scheduleDeferredStartRetry(config);
      });
    });
  } else {
    LogChannel.log(
      "actor",
      "[displayInstance] overlay up without local capture; use SETFRAMEDATA for texture",
    );
  }

  LogChannel.log(
    "actor",
    `[displayInstance] desktop overlay started key=${overlayKey} handle=${overlayHandle}`,
  );
}

globalThis.addEventListener("unload", async () => {
  state.isRunning = false;
  if (state.screenCapturer) {
    await state.screenCapturer.dispose();
    state.screenCapturer = null;
  }
});
