import { PostMan, wait } from "../submodules/stageforge/mod.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { OpenGLManager } from "../classes/openglManager.ts";
import { ScreenCapturer } from "../classes/ScreenCapturer/scclass.ts";
import { CustomLogger } from "../classes/customlogger.ts";
import { setImmediate } from "node:timers";
import { Buffer } from "node:buffer";


//takes an overlay handle and a frame source, updates overlay texture continuously
interface frame {
  pixels: Uint8Array,
  width: number,
  height: number
}

const state = {
  name: "updater",
  overlayHandle: null as bigint | null,
  overlayClass: null as OpenVR.IVROverlay | null,
  glManager: null as OpenGLManager | null,
  isRunning: false,
  screenCapturer: null as ScreenCapturer | null,
  currentFrame: null as frame | null,
  framesource: null as string | null
};

new PostMan(state, {
  CUSTOMINIT: (_payload: void) => {
    PostMan.setTopic("muffin")
  },
  STARTUPDATER: (payload: { overlayclass: bigint, overlayhandle: bigint, framesource?: string }) => {
    state.overlayClass = new OpenVR.IVROverlay(Deno.UnsafePointer.create(payload.overlayclass));
    state.overlayHandle = payload.overlayhandle
    console.log("we have overlayhandle", state.overlayHandle)
    if (payload.framesource) state.framesource = payload.framesource
    main()
  },
  GETFRAME: (_payload: void): { pixels: string, width: number, height: number } | null => {
      if (state.currentFrame == null) { return null }
      // Convert Uint8Array pixels to base64 string for transport
      const base64Pixels = Buffer.from(state.currentFrame.pixels).toString('base64');
      return {
        pixels: base64Pixels,
        width: state.currentFrame.width,
        height: state.currentFrame.height
      }
    },
} as const);

function INITSCREENCAP(): ScreenCapturer {
  const capturer = new ScreenCapturer({
    debug: false,
    onStats: ({ fps, avgLatency }) => {
      CustomLogger.log("screencap", `Capture Stats - FPS: ${fps.toFixed(1)} | Latency: ${avgLatency.toFixed(1)}ms`);
    },
    executablePath: "../resources/screen-streamer"
  });
  return capturer;
}

async function DeskCapLoop(
  textureStructPtr: Deno.PointerValue<OpenVR.Texture>,
) { 
  while (state.isRunning) {
    if (!state.framesource && !state.screenCapturer) throw new Error("no framesource")
    if (!state.overlayClass) throw new Error("no overlay")
    if (!state.overlayHandle) throw new Error("no overlay")
    
    interface frametype {
      pixels: Uint8Array<ArrayBufferLike>,
      width: number,
      height: number
    }
    let frame: frametype | null
    if (state.screenCapturer) {
      const capturedFrame = await state.screenCapturer!.getLatestFrame();
      if (capturedFrame === null) { await wait(1000); continue }
      frame = {
        pixels: capturedFrame.data,
        width: capturedFrame.width,
        height: capturedFrame.height
      }
      state.currentFrame = frame
      await new Promise(resolve => setImmediate(resolve)); 
    } else {
      // Get the frame from remote source
      const remoteFrame = await PostMan.PostMessage({
        target: state.framesource!,
        type: "GETFRAME",
        payload: null
      }, true) as { pixels: string, width: number, height: number } | null;
      if (!remoteFrame) { console.log("no frame"); await wait(1000); continue }
      frame = {
        pixels: Buffer.from(remoteFrame.pixels, 'base64'),
        width: remoteFrame.width,
        height: remoteFrame.height
      };
    }

    if (!frame) { console.log("no frane"); await wait(1000); continue}
    createTextureFromScreenshot(frame.pixels, frame.width, frame.height);
    const error = state.overlayClass.SetOverlayTexture(state.overlayHandle, textureStructPtr);
    if (error !== OpenVR.OverlayError.VROverlayError_None) throw new Error("wtf")
    state.overlayClass.WaitFrameSync(100)
  }
}

function createTextureFromScreenshot(pixels: Uint8Array, width: number, height: number): void {
  if (!state.glManager) { throw new Error("glManager is null"); }
  state.glManager.createTextureFromScreenshot(pixels, width, height);
}

function INITGL(name?: string) {
  state.glManager = new OpenGLManager();
  state.glManager.initialize(name);
  if (!state.glManager) { throw new Error("glManager is null"); }
}

function main() {
  if (!state.overlayClass) throw new Error("no overlayclass")
  if (!state.overlayHandle) throw new Error("no overlayhandle")
  
  if (!state.framesource) { 
    //native capture mode
    state.screenCapturer = INITSCREENCAP();
  }

  state.isRunning = true;
  
  INITGL();

  const texture = state.glManager!.getTexture();
  if (!texture) { throw new Error("texture is null"); }

  const bounds = { uMin: 0, uMax: 1, vMin: 0, vMax: 1 };
  const [boundsPtr, _boudsView] = createStruct<OpenVR.TextureBounds>(bounds, OpenVR.TextureBoundsStruct)
  state.overlayClass.SetOverlayTextureBounds(state.overlayHandle, boundsPtr);

  const textureData = {
    handle: BigInt(texture[0]),
    eType: OpenVR.TextureType.TextureType_OpenGL,
    eColorSpace: OpenVR.ColorSpace.ColorSpace_Auto,
  };
  const [textureStructPtr, _textureStructView ] = createStruct<OpenVR.Texture>(textureData, OpenVR.TextureStruct)
  DeskCapLoop(textureStructPtr);
}

globalThis.addEventListener("unload", cleanup);

async function cleanup() {
  state.isRunning = false;
  if (state.screenCapturer) {
    await state.screenCapturer.dispose();
    state.screenCapturer = null;
  }
}

