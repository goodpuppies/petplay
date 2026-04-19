import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import { wait } from "../classes/utils.ts";
import { OpenVrOverlayTexture } from "../classes/openVrOverlayTexture.ts";
import { WebXROverlayGl } from "../classes/webxrOverlayGl.ts";
import { WebXRHost } from "../classes/webxrhost.ts";
import { FpsCounter } from "../classes/fpsCounter.ts";
import { IntervalMetric } from "../classes/intervalMetric.ts";

type StartWebXRPayload = {
  width?: number;
  height?: number;
  title?: string;
  debugWindow?: boolean;
  overlayPointer?: number | bigint | null;
  vrSystemPointer?: number | bigint | null;
  overlayKey?: string;
  overlayName?: string;
  overlayWidthInMeters?: number;
  overlayDistance?: number;
};

type OverlayConfig = {
  overlayPointer: number | bigint;
  vrSystemPointer?: number | bigint;
  overlayKey?: string;
  overlayName?: string;
  overlayWidthInMeters?: number;
  overlayDistance?: number;
  overlayMode?: "quad" | "stereo-panorama";
};

const state = actorState({
  name: "webxr",
  host: null as WebXRHost | null,
  startup: null as Promise<void> | null,
  overlay: null as OpenVrOverlayTexture | null,
  overlayGl: null as WebXROverlayGl | null,
  overlayConfig: null as OverlayConfig | null,
  overlayLoop: null as Promise<void> | null,
  overlayRunning: false,
  uploadedFrames: 0,
  waitLogCounter: 0,
  overlayFpsCounter: new FpsCounter(),
  lastOverlayFpsLogAt: 0,
  lastPerfLogAt: 0,
  uploadMetric: new IntervalMetric(),
  presentMetric: new IntervalMetric(),
  frameMetric: new IntervalMetric(),
});

new PostMan(
  state,
  {
    __INIT__: (_payload: void) => {
      PostMan.setTopic("muffin");
    },
    STARTWEBXR: (payload: StartWebXRPayload | null) => {
      if (!state.host) {
        state.host = new WebXRHost();
      }
      initializeOverlay(payload ?? null);
      if (!state.startup) {
        state.startup = state.host.start({
          width: payload?.width,
          height: payload?.height,
          title: payload?.title,
          debugWindow: payload?.debugWindow,
          vrSystemPointer: payload?.vrSystemPointer,
        }).catch((error) => {
          LogChannel.log("webxrv2", `[webxr] startup failed: ${error}`);
          state.startup = null;
          throw error;
        });
      }
      if (state.overlayGl && !state.overlayLoop) {
        state.overlayRunning = true;
        state.overlayLoop = pumpOverlayFrames().finally(() => {
          state.overlayLoop = null;
        });
      }
    },
    GETWEBXRSTATUS: (_payload: void) => {
      const hostStatus = state.host?.getStatus() ?? {
        running: false,
        frameCount: 0,
        xrFps: 0,
        inspected: false,
        lastInspection: null,
        error: null,
      };
      return {
        ...hostStatus,
        overlayFps: state.overlayFpsCounter.getFps(),
        uploadedFrames: state.uploadedFrames,
      };
    },
    STOPWEBXR: async (_payload: void) => {
      state.overlayRunning = false;
      if (state.overlayLoop) {
        await state.overlayLoop;
      }
      if (state.host) {
        await state.host.stop();
        state.startup = null;
      }
      state.overlay?.cleanup();
      state.overlay = null;
      state.overlayGl?.cleanup();
      state.overlayGl = null;
      state.overlayConfig = null;
      state.overlayFpsCounter.reset();
      state.lastOverlayFpsLogAt = 0;
      state.lastPerfLogAt = 0;
      state.uploadMetric.reset();
      state.presentMetric.reset();
      state.frameMetric.reset();
    },
  } as const,
);

globalThis.addEventListener("unload", () => {
  state.overlayRunning = false;
  state.overlay?.cleanup();
  state.overlayGl?.cleanup();
  state.overlayConfig = null;
  void state.host?.stop();
});

function initializeOverlay(payload: StartWebXRPayload | null) {
  if (!payload?.overlayPointer || state.overlayGl) {
    return;
  }

  const overlayGl = new WebXROverlayGl();
  overlayGl.initialize(payload.overlayName ?? "PetPlay WebXR Overlay");

  state.overlayGl = overlayGl;
  state.overlayConfig = {
    overlayPointer: payload.overlayPointer,
    vrSystemPointer: payload.vrSystemPointer ?? undefined,
    overlayKey: payload.overlayKey,
    overlayName: payload.overlayName,
    overlayWidthInMeters: payload.overlayWidthInMeters,
    overlayDistance: payload.overlayDistance,
    overlayMode: "stereo-panorama",
  };
}

function ensureOpenVrOverlayForFrame(frameWidth: number, frameHeight: number) {
  if (state.overlay || !state.overlayGl || !state.overlayConfig) {
    return;
  }

  state.overlayGl.ensureTexture(frameWidth, frameHeight);

  const overlay = new OpenVrOverlayTexture(state.overlayConfig.overlayPointer);
  overlay.initialize(state.overlayGl.getTextureHandle(), {
    key: state.overlayConfig.overlayKey,
    name: state.overlayConfig.overlayName,
    widthInMeters: state.overlayConfig.overlayWidthInMeters,
    distance: state.overlayConfig.overlayDistance,
    mode: state.overlayConfig.overlayMode ?? "quad",
  });
  state.overlay = overlay;
}

async function pumpOverlayFrames() {
  while (state.overlayRunning) {
    if (!state.host || !state.overlayGl) {
      await wait(10);
      continue;
    }

    const sourceFrame = await state.host.captureOverlayFrame();
    if (!sourceFrame) {
      state.waitLogCounter++;
      if (state.waitLogCounter % 120 === 0) {
        const status = state.host.getStatus();
        LogChannel.log(
          "webxrv2",
          `[webxr] waiting for frameCount=${status.frameCount}: ${
            status.lastLayerInfo ?? "no layer info"
          }`,
        );
      }
      await wait(1);
      continue;
    }

    try {
      const frameStartedAt = performance.now();
      state.waitLogCounter = 0;
      ensureOpenVrOverlayForFrame(sourceFrame.width, sourceFrame.height);
      if (!state.overlay) {
        throw new Error("OpenVR overlay not initialized for captured frame");
      }
      state.uploadedFrames++;
      state.overlayFpsCounter.mark();
      const now = performance.now();
      if (now - state.lastOverlayFpsLogAt >= 1000) {
        state.lastOverlayFpsLogAt = now;
        LogChannel.log("fps", `[webxr] overlay=${state.overlayFpsCounter.getFps().toFixed(1)}`);
      }
      if (state.uploadedFrames === 1) {
        LogChannel.log(
          "webxrv2",
          `[webxr] overlay upload started ${sourceFrame.width}x${sourceFrame.height} ` +
            `stride=${sourceFrame.bytesPerRow} format=${sourceFrame.format}`,
        );
      }
      const uploadStartedAt = performance.now();
      state.overlayGl.uploadMappedFrame(sourceFrame);
      state.uploadMetric.record(performance.now() - uploadStartedAt);
      if (state.uploadedFrames === 1) {
        const textureInfo = state.overlayGl.describeTexture();
        LogChannel.log(
          "webxrv2",
          `[webxr] gl texture handle=${textureInfo.handle} isTexture=${textureInfo.isTexture} ` +
            `size=${textureInfo.width}x${textureInfo.height} internalFormat=${textureInfo.internalFormat} ` +
            `glError=${textureInfo.glErrorLabel}`,
        );
      }
      const presentStartedAt = performance.now();
      state.overlay.present();
      state.presentMetric.record(performance.now() - presentStartedAt);
      state.frameMetric.record(performance.now() - frameStartedAt);
      maybeLogOverlayPerf();
    } catch (error) {
      LogChannel.log("webxrv2", `[webxr] overlay frame upload failed: ${error}`);
      state.overlayRunning = false;
      throw error;
    } finally {
      sourceFrame.destroy();
    }
  }
}

function maybeLogOverlayPerf() {
  const now = performance.now();
  if (now - state.lastPerfLogAt < 1000) {
    return;
  }

  state.lastPerfLogAt = now;
  const uploadSample = state.uploadMetric.flush();
  const presentSample = state.presentMetric.flush();
  const frameSample = state.frameMetric.flush();
  if (!uploadSample && !presentSample && !frameSample) {
    return;
  }

  const parts: string[] = [];
  if (uploadSample) {
    parts.push(
      `upload=${uploadSample.avgMs.toFixed(2)}ms avg ${uploadSample.maxMs.toFixed(2)}ms max`,
    );
  }
  if (presentSample) {
    parts.push(
      `present=${presentSample.avgMs.toFixed(2)}ms avg ${presentSample.maxMs.toFixed(2)}ms max`,
    );
  }
  if (frameSample) {
    parts.push(`frame=${frameSample.avgMs.toFixed(2)}ms avg ${frameSample.maxMs.toFixed(2)}ms max`);
  }
  LogChannel.log("perf", `[webxr] ${parts.join(" | ")}`);
}
