import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { OpenVrOverlayTexture } from "../classes/openVrOverlayTexture.ts";
import { WebXROverlayRaylib } from "../classes/webxrOverlayRaylib.ts";
import type { WebXRShadowFrame } from "../classes/webxrhost.ts";

type StartWebXROverlayPayload = {
  overlayPointer: number | bigint;
  overlayKey?: string;
  overlayName?: string;
  overlayWidthInMeters?: number;
  overlayDistance?: number;
};

const state = actorState({
  name: "webxrOverlay",
  overlay: null as OpenVrOverlayTexture | null,
  overlayRaylib: null as WebXROverlayRaylib | null,
  overlayPointer: null as number | bigint | null,
  overlayKey: null as string | null,
  overlayName: null as string | null,
  overlayWidthInMeters: null as number | null,
  overlayDistance: null as number | null,
  uploadedFrames: 0,
});

new PostMan(
  state,
  {
    __INIT__: (_payload: void) => {
      PostMan.setTopic("muffin");
    },
    STARTWEBXROVERLAY: (payload: StartWebXROverlayPayload) => {
      state.overlayPointer = payload.overlayPointer;
      state.overlayKey = payload.overlayKey ?? null;
      state.overlayName = payload.overlayName ?? "PetPlay WebXR Overlay";
      state.overlayWidthInMeters = payload.overlayWidthInMeters ?? null;
      state.overlayDistance = payload.overlayDistance ?? null;
      if (!state.overlayRaylib) {
        state.overlayRaylib = new WebXROverlayRaylib();
        state.overlayRaylib.initialize(state.overlayName ?? "PetPlay WebXR Overlay");
      }
    },
    RENDERWEBXRSHADOWFRAME: (frame: WebXRShadowFrame) => {
      if (!state.overlayRaylib || !state.overlayPointer) {
        return;
      }

      state.overlayRaylib.renderShadowFrame(frame);

      if (!state.overlay) {
        const overlay = new OpenVrOverlayTexture(state.overlayPointer);
        overlay.initialize(state.overlayRaylib.getTextureHandle(), {
          key: state.overlayKey ?? undefined,
          name: state.overlayName ?? undefined,
          widthInMeters: state.overlayWidthInMeters ?? undefined,
          distance: state.overlayDistance ?? undefined,
          mode: "stereo-panorama",
          attachToHmd: true,
          flipVertical: false,
        });
        state.overlay = overlay;
      } else {
        state.overlay.setTextureHandle(state.overlayRaylib.getTextureHandle());
      }

      state.overlay.present();
      state.uploadedFrames++;
    },
    STOPWEBXROVERLAY: (_payload: void) => {
      cleanupOverlay();
    },
  } as const,
);

globalThis.addEventListener("unload", () => {
  cleanupOverlay();
});

function cleanupOverlay() {
  state.overlay?.cleanup();
  state.overlay = null;
  state.overlayRaylib?.cleanup();
  state.overlayRaylib = null;
  state.overlayPointer = null;
  state.overlayKey = null;
  state.overlayName = null;
  state.overlayWidthInMeters = null;
  state.overlayDistance = null;
  state.uploadedFrames = 0;
}
