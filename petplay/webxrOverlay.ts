/**
 * Second worker: receives `ExtractionResult` from `webxr` and runs
 * `WebXROverlayRaylib` (raylib) + OpenVR `present`. The Three.js / Raythree
 * graph walk lives in the webxr worker; this actor only draws from IR.
 */
import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { OpenVrOverlayTexture } from "../classes/openVrOverlayTexture.ts";
import { WebXROverlayRaylib } from "../classes/webxrOverlayRaylib.ts";
import type { WebXRRaythreeRenderPayload } from "../classes/webxrRaythreeScene.ts";

type StartWebXROverlayPayload = {
  overlayPointer: number | bigint;
  /** For `RAYLIBOVERLAYFRAMEACK` after each present (coalesced raylib path). */
  webxrActor?: string;
  overlayKey?: string;
  overlayName?: string;
  overlayWidthInMeters?: number;
  overlayDistance?: number;
  sortOrder?: number;
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
  sortOrder: null as number | null,
  uploadedFrames: 0,
  webxrActor: null as string | null,
});

new PostMan(
  state,
  {
    __INIT__: (_payload: void) => {
      PostMan.setTopic("muffin");
    },
    STARTWEBXROVERLAY: (payload: StartWebXROverlayPayload) => {
      state.webxrActor = payload.webxrActor ?? null;
      state.overlayPointer = payload.overlayPointer;
      state.overlayKey = payload.overlayKey ?? null;
      state.overlayName = payload.overlayName ?? "PetPlay WebXR Overlay";
      state.overlayWidthInMeters = payload.overlayWidthInMeters ?? null;
      state.overlayDistance = payload.overlayDistance ?? null;
      state.sortOrder = payload.sortOrder ?? null;
      if (!state.overlayRaylib) {
        state.overlayRaylib = new WebXROverlayRaylib();
        state.overlayRaylib.initialize(state.overlayName ?? "PetPlay WebXR Overlay");
      }
    },
    RENDERWEBXRRAYTHREEFRAME: (payload: WebXRRaythreeRenderPayload) => {
      if (!state.overlayRaylib || !state.overlayPointer) {
        return;
      }

      state.overlayRaylib.renderRaythreeFrame(payload);

      if (!state.overlay) {
        const overlay = new OpenVrOverlayTexture(state.overlayPointer);
        overlay.initialize(state.overlayRaylib.getTextureHandle(), {
          key: state.overlayKey ?? undefined,
          name: state.overlayName ?? undefined,
          widthInMeters: state.overlayWidthInMeters ?? undefined,
          distance: state.overlayDistance ?? undefined,
          mode: "stereo-panorama",
          sortOrder: state.sortOrder ?? undefined,
          attachToHmd: true,
          flipVertical: false,
        });
        state.overlay = overlay;
      } else {
        state.overlay.setTextureHandle(state.overlayRaylib.getTextureHandle());
      }

      state.overlay.present();
      state.uploadedFrames++;
      if (state.webxrActor) {
        PostMan.PostMessage({
          target: state.webxrActor,
          type: "RAYLIBOVERLAYFRAMEACK",
          payload: null,
        });
      }
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
  state.sortOrder = null;
  state.uploadedFrames = 0;
  state.webxrActor = null;
}
