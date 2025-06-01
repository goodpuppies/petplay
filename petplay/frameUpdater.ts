import { PostMan, actorState } from "../submodules/stageforge/mod.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { OpenGLManager } from "../classes/openglManager.ts";
import { ScreenCapturer } from "../classes/ScreenCapturer/scclass.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import { setImmediate } from "node:timers";
import { Buffer } from "node:buffer";
import { tempFile, wait } from "../classes/utils.ts";


//takes an overlay handle and a frame source, updates overlay texture continuously
interface frame {
  pixels: Uint8Array,
  width: number,
  height: number
}

const state = actorState({
  name: "updater",
  overlayHandle: null as bigint | null,
  overlayClass: null as OpenVR.IVROverlay | null,
  glManager: null as OpenGLManager | null,
  isRunning: false,
  isLoopRunning: false, // Flag to track if the loop is active
  screenCapturer: null as ScreenCapturer | null,
  currentFrame: null as frame | null,
  framesource: null as string | null,
  textureStructPtr: null as Deno.PointerValue<OpenVR.Texture> | null // Store texture pointer
});

new PostMan(state, {
  __INIT__: (_payload: void) => {
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
  TOGGLE: (payload: boolean) => {
    console.log("TOGGLE", payload)
    state.isRunning = payload
    // If toggling on and the loop isn't running, start it
    if (state.isRunning && !state.isLoopRunning) {
      startLoop();
    }
    if (!payload) {
      state.overlayClass?.HideOverlay(state.overlayHandle!)
    } else {
      state.overlayClass?.ShowOverlay(state.overlayHandle!)
    }
  }
} as const);

function INITSCREENCAP(): ScreenCapturer {
  const exePath = tempFile("./resources/screen-streamer.exe", import.meta.dirname!)
  const capturer = new ScreenCapturer({
    debug: false,
    onStats: ({ fps, avgLatency }) => {
      LogChannel.log("screencap", `Capture Stats - FPS: ${fps.toFixed(1)} | Latency: ${avgLatency.toFixed(1)}ms`);
    },
    executablePath: exePath
  });
  return capturer;
}

async function DeskCapLoop() {
  if (!state.textureStructPtr) throw new Error("Texture pointer not initialized");
  try {
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
        if (capturedFrame === null) { await wait(10); continue } // Reduced wait time
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
        if (!remoteFrame) { console.log("no frame"); await wait(100); continue } // Reduced wait time
        frame = {
          pixels: Buffer.from(remoteFrame.pixels, 'base64'),
          width: remoteFrame.width,
          height: remoteFrame.height
        };
      }

      if (!frame) { console.log("no frame"); await wait(100); continue} // Reduced wait time
      createTextureFromScreenshot(frame.pixels, frame.width, frame.height);
      const error = state.overlayClass.SetOverlayTexture(state.overlayHandle, state.textureStructPtr);
      if (error !== OpenVR.OverlayError.VROverlayError_None) {
          console.error("SetOverlayTexture Error:", error);
          // Consider stopping or handling the error more gracefully
          await wait(1000); // Wait longer on error
          continue;
      }
      // Optional: Reduce sync frequency if needed, but 100ms might be okay
      await wait(10)
      state.overlayClass.WaitFrameSync(100)
    }
  } catch (error) {
      console.error("Error in DeskCapLoop:", error);
      // Optionally set isRunning to false or handle recovery
      state.isRunning = false;
  } finally {
      console.log("DeskCapLoop exited.");
      state.isLoopRunning = false; // Ensure flag is reset when loop stops
  }
}

function createTextureFromScreenshot(pixels: Uint8Array, width: number, height: number): void {
  if (!state.glManager) { throw new Error("glManager is null"); }
  state.glManager.createTextureFromData(pixels, width, height);
}

function INITGL(name?: string) {
  state.glManager = new OpenGLManager();
  state.glManager.initialize2D(name);
  if (!state.glManager) { throw new Error("glManager is null"); }
}

// Helper function to start the loop
function startLoop() {
    if (state.isLoopRunning) {
        console.log("Loop already running.");
        return;
    }
    if (!state.isRunning) {
        console.log("Cannot start loop, isRunning is false.");
        return;
    }
    if (!state.textureStructPtr) {
        console.error("Cannot start loop, textureStructPtr is null.");
        return;
    }
    console.log("Starting DeskCapLoop...");
    state.isLoopRunning = true;
    DeskCapLoop(); // Run async, don't await here
}

function main() {
  if (!state.overlayClass) throw new Error("no overlayclass")
  if (!state.overlayHandle) throw new Error("no overlayhandle")

  if (!state.framesource) {
    //native capture mode
    state.screenCapturer = INITSCREENCAP();
  }

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
  state.textureStructPtr = textureStructPtr; // Store the pointer in state

  // Set initial running state and start the loop
  state.isRunning = true;
  startLoop();
}

globalThis.addEventListener("unload", cleanup);

async function cleanup() {
  console.log("Running cleanup...");
  state.isRunning = false; // Signal the loop to stop
  // Wait a moment for the loop to potentially finish its current iteration
  await wait(200);
  if (state.screenCapturer) {
    console.log("Disposing screen capturer...");
    await state.screenCapturer.dispose();
    state.screenCapturer = null;
  }
  if (state.glManager) {
      // Add GL cleanup if necessary
      // state.glManager.cleanup();
      state.glManager = null;
  }
  console.log("Cleanup finished.");
}

