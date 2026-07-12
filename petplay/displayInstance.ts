import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import { Buffer } from "node:buffer";
import { join } from "@std/path";
import { wait } from "../classes/utils.ts";
import type { ScreenCapturer } from "../classes/ScreenCapturer/scclass.ts";
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
  isRunning: false,
  isStarting: false,
  lastStartError: null as string | null,
  glManager: null as OpenGLManager | null,
  screenCapturer: null as ScreenCapturer | null,
  textureStructPtr: null as Deno.PointerValue<OpenVR.Texture> | null,
  lastWidthMeters: -1,
  lastHmd: null as OpenVR.HmdMatrix34 | null,
  captureFrames: 0,
  lastStartConfig: null as StartDesktopPayload | null,
  overlayPointer: null as bigint | null,
  restartTimerId: null as number | null,
});

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
  /** Meters: physical width of the overlay quad (default matches WebXR 16:9 default height). */
  initialWidthMeters?: number;
  /** `true` to enable OpenVR mouse input on the overlay (desktop / interaction). */
  enableMouseInput?: boolean;
};

type SyncDisplayPosePayload = {
  hmd: OpenVR.HmdMatrix34;
  widthMeters: number;
};

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
    },
    __SHUTDOWN__: async (_payload: unknown) => {
      await stopDisplayInstance();
    },
    __HEALTH__: (_payload: unknown) => {
      return getDisplayInstanceStatus();
    },
    __SNAPSHOT__: (_payload: unknown) => {
      return {
        overlayPointer: state.overlayPointer,
        startConfig: state.lastStartConfig,
      };
    },
    __RESTORE__: (
      payload: { overlayPointer?: bigint | null; startConfig?: StartDesktopPayload | null } | null,
    ) => {
      if (payload?.overlayPointer != null) {
        PostMan.PostMessage({
          target: state.id,
          type: "INITOVROVERLAY",
          payload: payload.overlayPointer,
        });
      }
      if (payload?.startConfig) {
        setTimeout(() => {
          PostMan.PostMessage({
            target: state.id,
            type: "STARTDESKTOP",
            payload: payload.startConfig,
          });
        }, 0);
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
          `[displayInstance] STARTDESKTOP unhandled failure: ${error instanceof Error ? error.message : error}`,
        );
        scheduleDeferredStartRetry(payload);
      });
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
      if (!state.glManager) throw new Error("glManager is null");
      state.glManager.createTextureFromData(pixelsArray, framePayload.width, framePayload.height);
      const error = state.overlayClass.SetOverlayTexture(
        state.overlayHandle,
        state.textureStructPtr,
      );
      if (error !== OpenVR.OverlayError.VROverlayError_None) {
        LogChannel.log(
          "actor",
          `[displayInstance] SetOverlayTexture: ${OpenVR.OverlayError[error]}`,
        );
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
    glReady: state.glManager != null,
    screenCaptureActive: state.screenCapturer != null,
    screenCapture: state.screenCapturer?.getStatus() ?? null,
    hasTextureStruct: state.textureStructPtr != null,
    lastStartError: state.lastStartError,
  };
}

const SCREEN_STREAMER_PROCESS_NAME = "petplay-screen-streamer.exe";
let screenStreamerPath: string | null = null;

function getScreenStreamerPath(): string {
  if (screenStreamerPath) return screenStreamerPath;
  const url = new URL("../resources/screen-streamer.exe", import.meta.url);
  const bytes = Deno.readFileSync(url);
  const runtimeDir = join(Deno.cwd(), "tmp");
  Deno.mkdirSync(runtimeDir, { recursive: true });
  screenStreamerPath = join(runtimeDir, SCREEN_STREAMER_PROCESS_NAME);
  Deno.writeFileSync(screenStreamerPath, bytes);
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
      `[displayInstance] stale capture cleanup skipped: ${error instanceof Error ? error.message : error}`,
    );
  }
}

async function initScreenCapturer(): Promise<ScreenCapturer> {
  const { ScreenCapturer } = await import("../classes/ScreenCapturer/scclass.ts");
  const logStats = getWebxrFrameLogsEnabled();
  return new ScreenCapturer({
    debug: false,
    onStats: ({ fps, avgLatency }) => {
      if (!logStats) return;
      LogChannel.log(
        "screencap",
        `Display overlay — ${fps.toFixed(1)} fps, ${avgLatency.toFixed(1)} ms`,
      );
    },
    executablePath: getScreenStreamerPath(),
    onExit: (status) => {
      if (!state.isRunning) return;
      const message = `screen-streamer exited (code=${status.code}, success=${status.success})`;
      LogChannel.error("actor", `[displayInstance] ${message}; restarting capture`);
      void stopDesktopOverlay().then(() => {
        state.lastStartError = message;
        const config = state.lastStartConfig;
        if (config) {
          scheduleDeferredStartRetry(config);
        }
      });
    },
  });
}

async function initGl(overlayName: string) {
  const { OpenGLManager } = await import("../classes/openglManager.ts");
  state.glManager = new OpenGLManager();
  state.glManager.initialize2D(overlayName);
  if (!state.glManager) throw new Error("glManager is null");
}

async function stopDesktopOverlay(): Promise<void> {
  state.isRunning = false;
  state.lastStartError = null;

  if (state.screenCapturer) {
    try {
      await state.screenCapturer.dispose();
    } catch (error) {
      LogChannel.log(
        "actor",
        `[displayInstance] screenCapturer dispose failed: ${error instanceof Error ? error.message : error}`,
      );
    }
    state.screenCapturer = null;
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

  if (state.overlayClass && state.overlayHandle) {
    try {
      state.overlayClass.HideOverlay(state.overlayHandle);
    } catch {
      // Ignore shutdown races.
    }
    try {
      state.overlayClass.DestroyOverlay(state.overlayHandle);
    } catch {
      // Ignore shutdown races.
    }
  }

  state.overlayHandle = 0n;
  state.textureStructPtr = null;
  state.lastWidthMeters = -1;
  state.lastHmd = null;
}

async function stopDisplayInstance(): Promise<void> {
  clearDeferredStartRetry();
  state.lastStartConfig = null;
  await stopDesktopOverlay();
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
            `[displayInstance] STARTDESKTOP attempt ${attempt} failed, retrying: ${error instanceof Error ? error.message : error}`,
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
  state.glManager.createTextureFromData(pixels, width, height);
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
  while (state.isRunning && (continuous || frameCount < maxFrames)) {
    const frame = await capturer.getLatestFrame();
    if (!frame) {
      await wait(100);
      continue;
    }
    frameCount++;
    createTextureFromScreenshot(frame.data, frame.width, frame.height);
    const err = overlay.SetOverlayTexture(state.overlayHandle, textureStructPtr);
    if (err !== OpenVR.OverlayError.VROverlayError_None) {
      LogChannel.error("actor", `SetOverlayTexture: ${OpenVR.OverlayError[err]}`);
    }
    overlay.WaitFrameSync(100);
    await wait(continuous ? 50 : 100);
  }
  if (!continuous) {
    state.isRunning = false;
    if (state.screenCapturer) {
      await state.screenCapturer.dispose();
      state.screenCapturer = null;
    }
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
  state.lastWidthMeters = -1;
  state.lastHmd = null;

  await stopStaleScreenStreamer();
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
  const bounds = { uMin: 0, uMax: 1, vMin: 0, vMax: 1 };
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

  if (config.runScreenCapture) {
    state.screenCapturer = await initScreenCapturer();
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
