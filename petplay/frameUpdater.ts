import { PostMan, wait } from "../submodules/stageforge/mod.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { OpenGLManager } from "../classes/openglManager.ts";

//takes an overlay handle and a frame source, updates overlay texture continuously
interface frame {
  pixels: Uint8Array,
  width: number,
  height: number
}

const state = {
  name: "updater",
  framesource: null as string | null,
  overlayHandle: null as bigint | null,
  overlayClass: null as OpenVR.IVROverlay | null,
  glManager: null as OpenGLManager | null,
  isRunning: false,
};

new PostMan(state, {
  CUSTOMINIT: (_payload: void) => {
  },
  STARTUPDATER: (payload: { overlayclass: bigint, overlayhandle: bigint, framesource: string }) => {
    state.overlayClass = new OpenVR.IVROverlay(Deno.UnsafePointer.create(payload.overlayclass));
    state.overlayHandle = payload.overlayhandle
    state.framesource = payload.framesource
    main()
  }
} as const);

async function DeskCapLoop(
  textureStructPtr: Deno.PointerValue<OpenVR.Texture>,
) { 
  while (state.isRunning) {
    if (!state.framesource) throw new Error("no framesource")
    if (!state.overlayClass) throw new Error("no overlay")
    if (!state.overlayHandle) throw new Error("no overlay")
    const frame = await PostMan.PostMessage({
      target: state.framesource,
      type: "GETFRAME",
      payload: null
    }, true) as frame | null
    if (!frame) { console.log("no frane"); await wait(1000); continue}
    createTextureFromScreenshot(frame.pixels, frame.width, frame.height);
    const error = state.overlayClass.SetOverlayTexture(state.overlayHandle, textureStructPtr);
    if (error !== OpenVR.OverlayError.VROverlayError_None) throw new Error("wtf")
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
  if (!state.framesource) throw new Error("no framesource")
  if (!state.overlayClass) throw new Error("no overlay")
  if (!state.overlayHandle) throw new Error("no overlay")

  
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


