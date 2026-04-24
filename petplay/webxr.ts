import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { wait } from "../classes/utils.ts";
import { OpenVrOverlayTexture } from "../classes/openVrOverlayTexture.ts";
import { WebXRHost } from "../classes/webxrhost.ts";
import { WebXROverlayGl } from "../classes/webxrOverlayGl.ts";
import { FpsCounter } from "../classes/fpsCounter.ts";
import { IntervalMetric } from "../classes/intervalMetric.ts";
import { WebXRRaythreeSceneBridge } from "../classes/webxrRaythreeScene.ts";
import {
  setShadowControllerPose,
  setVRCOriginFromHmdMatrix34,
} from "../classes/webxrShadowScene.ts";

type SupportedSessionMode = "immersive-vr" | "immersive-ar";
export type OverlayRenderMode = "webgpu" | "raylib" | "both";

type StartWebXRPayload = {
  width?: number;
  height?: number;
  title?: string;
  debugWindow?: boolean;
  overlayPointer?: number | bigint | null;
  vrSystemPointer?: number | bigint | null;
  controllerActor?: string | null;
  wristMenuActor?: string | null;
  sessionMode?: SupportedSessionMode;
  alpha?: boolean;
  overlayKey?: string;
  overlayName?: string;
  overlayWidthInMeters?: number;
  overlayDistance?: number;
  overlayRenderMode?: OverlayRenderMode;
};

type ControllerDataPayload = [
  ReturnType<typeof OpenVR.InputPoseActionDataStruct.read>,
  ReturnType<typeof OpenVR.InputPoseActionDataStruct.read>,
  ReturnType<typeof OpenVR.InputDigitalActionDataStruct.read>,
  ReturnType<typeof OpenVR.InputDigitalActionDataStruct.read>,
  ReturnType<typeof OpenVR.InputDigitalActionDataStruct.read>,
  ReturnType<typeof OpenVR.InputDigitalActionDataStruct.read>,
];

type OverlayConfig = {
  overlayPointer: number | bigint;
  overlayKey?: string;
  overlayName?: string;
  overlayWidthInMeters?: number;
  overlayDistance?: number;
  overlayMode?: "quad" | "stereo-panorama";
  sortOrder?: number;
  attachToHmd?: boolean;
};

const state = actorState({
  name: "webxr",
  host: null as WebXRHost | null,
  startup: null as Promise<void> | null,
  webGpuOverlay: null as OpenVrOverlayTexture | null,
  webGpuOverlayGl: null as WebXROverlayGl | null,
  webGpuOverlayConfig: null as OverlayConfig | null,
  raylibOverlayConfig: null as OverlayConfig | null,
  overlayRenderMode: "raylib" as OverlayRenderMode,
  overlayActor: null as string | null,
  overlayLoop: null as Promise<void> | null,
  controllerLoop: null as Promise<void> | null,
  controllerRunning: false,
  controllerActor: null as string | null,
  overlayRunning: false,
  lastUploadedHostFrameCount: -1,
  uploadedFrames: 0,
  waitLogCounter: 0,
  overlayFpsCounter: new FpsCounter(),
  lastOverlayFpsLogAt: 0,
  lastPerfLogAt: 0,
  uploadMetric: new IntervalMetric(),
  presentMetric: new IntervalMetric(),
  frameMetric: new IntervalMetric(),
  raythreeSceneBridge: new WebXRRaythreeSceneBridge(),
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
      state.controllerActor = payload?.controllerActor ?? null;
      state.overlayRenderMode = payload?.overlayRenderMode ?? "raylib";
      if (!state.startup) {
        state.startup = (async () => {
          await initializeOverlay(payload ?? null);
          if (hasAnyOverlayMode() && !state.overlayLoop) {
            state.overlayRunning = true;
            state.overlayLoop = pumpOverlayFrames().finally(() => {
              state.overlayLoop = null;
            });
          }
          await state.host!.start({
            width: payload?.width,
            height: payload?.height,
            title: payload?.title,
            debugWindow: payload?.debugWindow,
            vrSystemPointer: payload?.vrSystemPointer,
            wristMenuActor: payload?.wristMenuActor,
            sessionMode: payload?.sessionMode,
            alpha: payload?.alpha,
          });
        })().catch((error) => {
          LogChannel.log("webxrv2", `[webxr] startup failed: ${error}`);
          state.startup = null;
          throw error;
        });
      }
      if (state.controllerActor && !state.controllerLoop) {
        state.controllerRunning = true;
        state.controllerLoop = pumpControllerFrames().finally(() => {
          state.controllerLoop = null;
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
    ORIGINUPDATE: (payload: OpenVR.HmdMatrix34 | null) => {
      if (!payload) return;
      setVRCOriginFromHmdMatrix34(
        payload.m as [
          [number, number, number, number],
          [number, number, number, number],
          [number, number, number, number],
        ],
      );
    },
    STOPWEBXR: async (_payload: void) => {
      state.controllerRunning = false;
      if (state.controllerLoop) {
        await state.controllerLoop;
      }
      state.overlayRunning = false;
      if (state.overlayLoop) {
        await state.overlayLoop;
      }
      if (state.host) {
        state.host.setControllerData(null);
        await state.host.stop();
        state.startup = null;
      }
      state.webGpuOverlay?.cleanup();
      state.webGpuOverlay = null;
      state.webGpuOverlayGl?.cleanup();
      state.webGpuOverlayGl = null;
      state.webGpuOverlayConfig = null;
      state.raylibOverlayConfig = null;
      if (state.overlayActor) {
        PostMan.PostMessage({
          target: state.overlayActor,
          type: "STOPWEBXROVERLAY",
          payload: null,
        });
        state.overlayActor = null;
      }
      state.controllerActor = null;
      state.lastUploadedHostFrameCount = -1;
      state.uploadedFrames = 0;
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
  state.controllerRunning = false;
  state.overlayRunning = false;
  state.webGpuOverlay?.cleanup();
  state.webGpuOverlayGl?.cleanup();
  state.webGpuOverlay = null;
  state.webGpuOverlayGl = null;
  state.webGpuOverlayConfig = null;
  state.raylibOverlayConfig = null;
  if (state.overlayActor) {
    PostMan.PostMessage({
      target: state.overlayActor,
      type: "STOPWEBXROVERLAY",
      payload: null,
    });
    state.overlayActor = null;
  }
  void state.host?.stop();
});

function publishControllerSnapshot(data: ControllerDataPayload | null) {
  if (!data) {
    setShadowControllerPose("left", null, false);
    setShadowControllerPose("right", null, false);
    return;
  }
  const leftPose = data[0];
  const rightPose = data[1];
  const leftTrigger = data[2];
  const rightTrigger = data[3];

  setShadowControllerPose(
    "left",
    leftPose?.pose?.bPoseIsValid
      ? (leftPose.pose.mDeviceToAbsoluteTracking.m as [
        [number, number, number, number],
        [number, number, number, number],
        [number, number, number, number],
      ])
      : null,
    Boolean(leftTrigger?.bState),
  );
  setShadowControllerPose(
    "right",
    rightPose?.pose?.bPoseIsValid
      ? (rightPose.pose.mDeviceToAbsoluteTracking.m as [
        [number, number, number, number],
        [number, number, number, number],
        [number, number, number, number],
      ])
      : null,
    Boolean(rightTrigger?.bState),
  );
}

async function pumpControllerFrames() {
  while (state.controllerRunning) {
    if (!state.host || !state.controllerActor) {
      await wait(10);
      continue;
    }

    try {
      const controllerData = await PostMan.PostMessage({
        target: state.controllerActor,
        type: "GETCONTROLLERDATA",
        payload: null,
      }, true) as ControllerDataPayload;
      state.host.setControllerData(controllerData);
      publishControllerSnapshot(controllerData);
    } catch (error) {
      state.host.setControllerData(null);
      publishControllerSnapshot(null);
      LogChannel.log("webxrv2", `[webxr] controller poll failed: ${error}`);
      await wait(50);
      continue;
    }

    await wait(8);
  }
}

function includesRaylibOverlay(mode: OverlayRenderMode): boolean {
  return mode === "raylib" || mode === "both";
}

function includesWebGpuOverlay(mode: OverlayRenderMode): boolean {
  return mode === "webgpu" || mode === "both";
}

function buildOverlayKey(baseKey: string | undefined, suffix: string): string | undefined {
  return baseKey ? `${baseKey}.${suffix}` : undefined;
}

function buildOverlayName(baseName: string | undefined, suffix: string): string | undefined {
  return baseName ? `${baseName} ${suffix}` : undefined;
}

async function initializeOverlay(payload: StartWebXRPayload | null) {
  if (!payload?.overlayPointer) {
    return;
  }

  const overlayMode = payload.overlayRenderMode ?? "raylib";

  if (includesWebGpuOverlay(overlayMode) && !state.webGpuOverlayGl) {
    const overlayGl = new WebXROverlayGl();
    overlayGl.initialize(buildOverlayName(payload.overlayName, "WebGPU") ?? "PetPlay WebXR Overlay WebGPU");
    state.webGpuOverlayGl = overlayGl;
    state.webGpuOverlayConfig = {
      overlayPointer: payload.overlayPointer,
      overlayKey: buildOverlayKey(payload.overlayKey, "webgpu"),
      overlayName: buildOverlayName(payload.overlayName, "WebGPU"),
      overlayWidthInMeters: payload.overlayWidthInMeters,
      overlayDistance: payload.overlayDistance,
      overlayMode: "stereo-panorama",
      sortOrder: 10,
      attachToHmd: true,
    };
  }

  if (includesRaylibOverlay(overlayMode) && !state.overlayActor) {
    state.overlayActor = await PostMan.create("./webxrOverlay.ts", import.meta.url);
    LogChannel.log("webxrv2", `[webxr] overlay actor ready id=${state.overlayActor}`);
    state.raylibOverlayConfig = {
      overlayPointer: payload.overlayPointer,
      overlayKey: buildOverlayKey(payload.overlayKey, "raylib"),
      overlayName: buildOverlayName(payload.overlayName, "Raylib"),
      overlayWidthInMeters: payload.overlayWidthInMeters,
      overlayDistance: payload.overlayDistance,
      overlayMode: "stereo-panorama",
      sortOrder: 20,
      attachToHmd: true,
    };
    PostMan.PostMessage({
      target: state.overlayActor,
      type: "STARTWEBXROVERLAY",
      payload: {
        overlayPointer: payload.overlayPointer,
        overlayKey: state.raylibOverlayConfig.overlayKey,
        overlayName: state.raylibOverlayConfig.overlayName,
        overlayWidthInMeters: state.raylibOverlayConfig.overlayWidthInMeters,
        overlayDistance: state.raylibOverlayConfig.overlayDistance,
        sortOrder: state.raylibOverlayConfig.sortOrder,
      },
    });
  }
}

function ensureWebGpuOverlayForFrame(eyeWidth: number, eyeHeight: number) {
  if (state.webGpuOverlay || !state.webGpuOverlayGl || !state.webGpuOverlayConfig) {
    return;
  }

  state.webGpuOverlayGl.ensureTexture(eyeWidth, eyeHeight);
  const nextOverlay = new OpenVrOverlayTexture(state.webGpuOverlayConfig.overlayPointer);
  nextOverlay.initialize(state.webGpuOverlayGl.getTextureHandle(), {
    key: state.webGpuOverlayConfig.overlayKey,
    name: state.webGpuOverlayConfig.overlayName,
    widthInMeters: state.webGpuOverlayConfig.overlayWidthInMeters,
    distance: state.webGpuOverlayConfig.overlayDistance,
    mode: state.webGpuOverlayConfig.overlayMode ?? "quad",
    sortOrder: state.webGpuOverlayConfig.sortOrder,
    attachToHmd: state.webGpuOverlayConfig.attachToHmd,
  });
  state.webGpuOverlay = nextOverlay;
}

function buildRaylibModeLabel(): string {
  if (state.overlayRenderMode === "both") {
    return "raylib-ghost+webgpu-scene";
  }
  return "raylib-ghost";
}

function buildWebGpuModeLabel(): string {
  if (state.overlayRenderMode === "both") {
    return "webgpu-scene+raylib-ghost";
  }
  return "webgpu-scene";
}

function logFirstOverlayUpload(modeLabel: string, width: number, height: number, outputWidth: number, outputHeight: number) {
  LogChannel.log(
    "webxrv2",
    `[webxr] overlay upload started eye=${width}x${height} output=${outputWidth}x${outputHeight} mode=${modeLabel}`,
  );
}

async function uploadWebGpuSceneFrame() {
  if (!state.host || !state.webGpuOverlayGl) {
    return false;
  }

  const overlayFrame = await state.host.captureOverlayFrame();
  if (!overlayFrame) {
    return false;
  }

  try {
    ensureWebGpuOverlayForFrame(overlayFrame.left.width, overlayFrame.left.height);
    if (!state.webGpuOverlay) {
      throw new Error("OpenVR WebGPU overlay not initialized");
    }

    if (state.uploadedFrames === 1) {
      logFirstOverlayUpload(
        buildWebGpuModeLabel(),
        overlayFrame.left.width,
        overlayFrame.left.height,
        overlayFrame.outputWidth,
        overlayFrame.outputHeight,
      );
    }

    const uploadStartedAt = performance.now();
    state.webGpuOverlayGl.uploadStereoFrame(overlayFrame);
    state.uploadMetric.record(performance.now() - uploadStartedAt);

    const presentStartedAt = performance.now();
    state.webGpuOverlay.present();
    state.presentMetric.record(performance.now() - presentStartedAt);
    return true;
  } finally {
    overlayFrame.destroy();
  }
}

function hasAnyOverlayMode(): boolean {
  return includesRaylibOverlay(state.overlayRenderMode) || includesWebGpuOverlay(state.overlayRenderMode);
}

async function uploadRaylibShadowFrame() {
  if (!state.host || !state.overlayActor) {
    return false;
  }

  const sourceFrame = state.host.captureShadowFrame();
  if (!sourceFrame) {
    return false;
  }
  const sceneContext = state.host.getRaythreeSceneContext();
  if (!sceneContext) {
    return false;
  }

  if (state.uploadedFrames === 1) {
    logFirstOverlayUpload(
      buildRaylibModeLabel(),
      sourceFrame.eyeWidth,
      sourceFrame.eyeHeight,
      sourceFrame.outputWidth,
      sourceFrame.outputHeight,
    );
  }

  const uploadStartedAt = performance.now();
  PostMan.PostMessage({
    target: state.overlayActor,
    type: "RENDERWEBXRRAYTHREEFRAME",
    payload: state.raythreeSceneBridge.buildPayload(sceneContext, sourceFrame),
  });
  state.uploadMetric.record(performance.now() - uploadStartedAt);
  state.presentMetric.record(0);
  return true;
}

async function pumpOverlayFrames() {
  while (state.overlayRunning) {
    if (!state.host || !hasAnyOverlayMode()) {
      await wait(10);
      continue;
    }

    const hostStatus = state.host.getStatus();
    if (hostStatus.frameCount <= state.lastUploadedHostFrameCount) {
      await wait(1);
      continue;
    }

    const canUseRaylib = includesRaylibOverlay(state.overlayRenderMode) && Boolean(state.overlayActor);
    const canUseWebGpu = includesWebGpuOverlay(state.overlayRenderMode) && Boolean(state.webGpuOverlayGl);
    if (!canUseRaylib && !canUseWebGpu) {
      await wait(10);
      continue;
    }

    if (hostStatus.frameCount <= 0) {
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
      state.waitLogCounter = 0;
      const frameStartedAt = performance.now();
      state.uploadedFrames++;
      state.lastUploadedHostFrameCount = hostStatus.frameCount;
      state.overlayFpsCounter.mark();
      const now = performance.now();
      if (now - state.lastOverlayFpsLogAt >= 1000) {
        state.lastOverlayFpsLogAt = now;
        LogChannel.log("fps", `[webxr] overlay=${state.overlayFpsCounter.getFps().toFixed(1)}`);
      }
      let renderedAny = false;
      if (canUseWebGpu) {
        renderedAny = await uploadWebGpuSceneFrame() || renderedAny;
      }
      if (canUseRaylib) {
        renderedAny = await uploadRaylibShadowFrame() || renderedAny;
      }
      if (!renderedAny) {
        state.uploadedFrames--;
        await wait(1);
        continue;
      }
      state.frameMetric.record(performance.now() - frameStartedAt);

      maybeLogOverlayPerf();
    } catch (error) {
      LogChannel.log("webxrv2", `[webxr] overlay frame upload failed: ${error}`);
      state.overlayRunning = false;
      throw error;
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
