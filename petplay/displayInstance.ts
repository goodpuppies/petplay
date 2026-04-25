import { PostMan, actorState } from "../submodules/stageforge/mod.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import { Buffer } from "node:buffer";
import { wait } from "../classes/utils.ts";
import { ScreenCapturer } from "../classes/ScreenCapturer/scclass.ts";
import { OpenGLManager } from "../classes/openglManager.ts";
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
  glManager: null as OpenGLManager | null,
  screenCapturer: null as ScreenCapturer | null,
  textureStructPtr: null as Deno.PointerValue<OpenVR.Texture> | null,
  lastWidthMeters: -1,
  lastHmd: null as OpenVR.HmdMatrix34 | null,
  captureFrames: 0,
});

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

new PostMan(state, {
  __INIT__: (_payload: void) => {
    PostMan.setTopic("muffin");
  },
  INITOVROVERLAY: (payload: bigint) => {
    const systemPtr = Deno.UnsafePointer.create(payload);
    state.overlayClass = new OpenVR.IVROverlay(systemPtr);
    LogChannel.log("actor", `[displayInstance] IVROverlay ready (${state.id})`);
  },
  STARTDESKTOP: (payload: StartDesktopPayload) => {
    if (!state.overlayClass) {
      throw new Error("Call INITOVROVERLAY before STARTDESKTOP");
    }
    void startDesktopOpenVrOverlay(payload);
  },
  SYNCDISPLAYPOSE: (sync: SyncDisplayPosePayload) => {
    if (!state.overlayClass || !state.overlayHandle) return;
    if (state.lastHmd && matrixEquals(state.lastHmd, sync.hmd) && state.lastWidthMeters === sync.widthMeters) {
      return;
    }
    if (state.lastWidthMeters !== sync.widthMeters) {
      const wErr = state.overlayClass.SetOverlayWidthInMeters(state.overlayHandle, sync.widthMeters);
      if (wErr !== OpenVR.OverlayError.VROverlayError_None) {
        LogChannel.log("actor", `[displayInstance] SetOverlayWidthInMeters: ${OpenVR.OverlayError[wErr]}`);
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
    const error = state.overlayClass.SetOverlayTexture(state.overlayHandle, state.textureStructPtr);
    if (error !== OpenVR.OverlayError.VROverlayError_None) {
      LogChannel.log("actor", `[displayInstance] SetOverlayTexture: ${OpenVR.OverlayError[error]}`);
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
    state.isRunning = false;
    if (state.screenCapturer) {
      await state.screenCapturer.dispose();
      state.screenCapturer = null;
    }
  },
} as const);

function initScreenCapturer(): ScreenCapturer {
  return new ScreenCapturer({
    debug: false,
    onStats: ({ fps, avgLatency }) => {
      LogChannel.log("screencap", `Display overlay — ${fps.toFixed(1)} fps, ${avgLatency.toFixed(1)} ms`);
    },
    executablePath: "./resources/screen-streamer",
  });
}

function initGl(overlayName: string) {
  state.glManager = new OpenGLManager();
  state.glManager.initialize2D(overlayName);
  if (!state.glManager) throw new Error("glManager is null");
}

function createTextureFromScreenshot(pixels: Uint8Array, width: number, height: number): void {
  if (!state.glManager) throw new Error("glManager is null");
  state.glManager.createTextureFromData(pixels, width, height);
}

async function deskCapLoop(overlay: OpenVR.IVROverlay, textureStructPtr: Deno.PointerValue<OpenVR.Texture>) {
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

function startDesktopOpenVrOverlay(config: StartDesktopPayload) {
  const overlay = state.overlayClass as OpenVR.IVROverlay;
  const overlayKey = config.overlayKey;
  const name = config.displayName;
  const widthM = config.initialWidthMeters ?? 0.5 * (16 / 9);

  state.isRunning = true;
  state.captureFrames = config.captureFrameLimit ?? 0;
  state.lastWidthMeters = -1;
  state.lastHmd = null;

  initGl(overlayKey);
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
    overlayHandle = new Deno.UnsafePointerView(findPtr).getBigUint64();
    LogChannel.log("actor", `[displayInstance] reusing existing overlay key ${overlayKey}`);
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
    const im = overlay.SetOverlayInputMethod(overlayHandle, OpenVR.OverlayInputMethod.VROverlayInputMethod_Mouse);
    if (im !== OpenVR.OverlayError.VROverlayError_None) {
      LogChannel.log("actor", `[displayInstance] SetOverlayInputMethod: ${OpenVR.OverlayError[im]}`);
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
    state.screenCapturer = initScreenCapturer();
    void deskCapLoop(overlay, textureStructPtr);
  } else {
    LogChannel.log("actor", "[displayInstance] overlay up without local capture; use SETFRAMEDATA for texture");
  }

  LogChannel.log("actor", `[displayInstance] desktop overlay started key=${overlayKey} handle=${overlayHandle}`);
}

globalThis.addEventListener("unload", async () => {
  state.isRunning = false;
  if (state.screenCapturer) {
    await state.screenCapturer.dispose();
    state.screenCapturer = null;
  }
});
