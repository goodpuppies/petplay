import { actorState, collectTransferables, PostMan } from "../submodules/stageforge/mod.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { wait } from "../classes/utils.ts";
import { OpenVrOverlayTexture } from "../classes/openVrOverlayTexture.ts";
import { WebXRHost } from "../classes/webxrhost.ts";
import { WebXROverlayGl } from "../classes/webxrOverlayGl.ts";
import { FpsCounter } from "../classes/fpsCounter.ts";
import { IntervalMetric, type IntervalMetricSample } from "../classes/intervalMetric.ts";
import type { RaylibOverlayFrameAckPayload } from "../classes/raylibOverlayAckPayload.ts";
import {
  type WebXRRaythreeRenderPayload,
  WebXRRaythreeSceneBridge,
} from "../classes/webxrRaythreeScene.ts";
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
  displayInstanceActor?: string | null;
  sessionMode?: SupportedSessionMode;
  alpha?: boolean;
  overlayKey?: string;
  overlayName?: string;
  overlayWidthInMeters?: number;
  overlayDistance?: number;
  overlayRenderMode?: OverlayRenderMode;
  /** `GETHMDDISPLAYFREQUENCY` from the hmd actor (OpenVR `Prop_DisplayFrequency_Float`). */
  hmdDisplayFrequencyHz?: number | null;
  /** `GETCOMPOSITORPTR` from the OpenVR actor; optional for Aardvark-style overlay display pacing. */
  vrCompositorPointer?: bigint | null;
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
  /** Full `buildPayload` (sum of raythree parts + small glue). */
  raythreeExtractMetric: new IntervalMetric(),
  raythreeSceneMatrixMetric: new IntervalMetric(),
  raythreeLeftEyeMetric: new IntervalMetric(),
  raythreeRightEyeMetric: new IntervalMetric(),
  raythreeUiMetric: new IntervalMetric(),
  /** `captureShadowFrame` + `getRaythreeSceneContext` in webxr worker. */
  raylibHostPrepMetric: new IntervalMetric(),
  /** `PostMessage` to webxrOverlay only (structured clone + queue; coalesced to latest in flight). */
  raylibPostMsgMetric: new IntervalMetric(),
  /** `webxrOverlay`: full `RENDERWEBXRRAYTHREEFRAME` handler until after `SetOverlayTexture`. */
  raylibOvrHandlerMetric: new IntervalMetric(),
  /** `WebXROverlayRaylib.renderRaythreeFrame` in overlay worker. */
  raylibOvrRenderMetric: new IntervalMetric(),
  /** `setTextureHandle` + `SetOverlayTexture` in overlay worker (excludes raylib compositor). */
  raylibOvrOpenvrMetric: new IntervalMetric(),
  raylibOvrEyeLeftMetric: new IntervalMetric(),
  raylibOvrEyeRightMetric: new IntervalMetric(),
  /** Left eye `renderExtraction` phases (see `RaylibOverlayFrameAckPayload`). */
  raylibOvrEyeLSyncMetric: new IntervalMetric(),
  raylibOvrEyeLPrepMetric: new IntervalMetric(),
  raylibOvrEyeLOpaqueMetric: new IntervalMetric(),
  raylibOvrEyeLXparentMetric: new IntervalMetric(),
  raylibOvrEyeLUiMetric: new IntervalMetric(),
  raylibOvrEyeLUiSortMetric: new IntervalMetric(),
  raylibOvrEyeLUiPanMetric: new IntervalMetric(),
  raylibOvrEyeLUiTxtMetric: new IntervalMetric(),
  raylibOvrEyeLEndMetric: new IntervalMetric(),
  raylibOvrEyeRSyncMetric: new IntervalMetric(),
  raylibOvrEyeRPrepMetric: new IntervalMetric(),
  raylibOvrEyeROpaqueMetric: new IntervalMetric(),
  raylibOvrEyeRXparentMetric: new IntervalMetric(),
  raylibOvrEyeRUiMetric: new IntervalMetric(),
  raylibOvrEyeRUiSortMetric: new IntervalMetric(),
  raylibOvrEyeRUiPanMetric: new IntervalMetric(),
  raylibOvrEyeRUiTxtMetric: new IntervalMetric(),
  raylibOvrEyeREndMetric: new IntervalMetric(),
  raylibOvrCombineMetric: new IntervalMetric(),
  /** Overlay `syncAssets` only (both eyes). */
  raylibOvrSyncMetric: new IntervalMetric(),
  /** Overlay `renderFrame` / `DrawMesh` only (both eyes). */
  raylibOvrDrawMetric: new IntervalMetric(),
  /** Sum of `assets.geometries.length` L+R; use max≫0 to spot per-frame re-upload. */
  raylibOvrBatchGeoMetric: new IntervalMetric(),
  raylibOvrBatchMatMetric: new IntervalMetric(),
  /** Uikit panel/text counts from the Raylib snapshot (same for both eyes). */
  raylibOvrUiPanelCountMetric: new IntervalMetric(),
  raylibOvrUiTextCountMetric: new IntervalMetric(),
  raylibOvrUiPanelDrawnMetric: new IntervalMetric(),
  raylibOvrUiTextDrawnMetric: new IntervalMetric(),
  /** True after `RENDERWEBXRRAYTHREEFRAME` until overlay `RAYLIBOVERLAYFRAMEACK`. */
  raylibFrameInFlight: false,
  /** Latest built payload; dropped in favor of newer until sent (no message queue buildup). */
  raylibFramePending: null as WebXRRaythreeRenderPayload | null,
  /** OpenVR HMD nominal Hz (for fps log context; from `hmd` actor). */
  nominalHmdDisplayHz: null as number | null,
  raythreeSceneBridge: new WebXRRaythreeSceneBridge(),
});

new PostMan(
  state,
  {
    __INIT__: (_payload: void) => {
      PostMan.setTopic("muffin");
    },
    RAYLIBOVERLAYFRAMEACK: (payload: RaylibOverlayFrameAckPayload | void | null) => {
      if (payload) {
        state.raylibOvrHandlerMetric.record(payload.handlerMs);
        state.raylibOvrRenderMetric.record(payload.renderMs);
        state.raylibOvrOpenvrMetric.record(payload.openvrMs);
        state.raylibOvrEyeLeftMetric.record(payload.renderLeftMs);
        state.raylibOvrEyeRightMetric.record(payload.renderRightMs);
        state.raylibOvrEyeLSyncMetric.record(payload.renderLeftSyncMs);
        state.raylibOvrEyeLPrepMetric.record(payload.renderLeftPrepMs);
        state.raylibOvrEyeLOpaqueMetric.record(payload.renderLeftOpaqueMs);
        state.raylibOvrEyeLXparentMetric.record(payload.renderLeftXparentMs);
        state.raylibOvrEyeLUiMetric.record(payload.renderLeftUiMs);
        state.raylibOvrEyeLUiSortMetric.record(payload.renderLeftUiSortPrepMs);
        state.raylibOvrEyeLUiPanMetric.record(payload.renderLeftUiPanelsMs);
        state.raylibOvrEyeLUiTxtMetric.record(payload.renderLeftUiTextMs);
        state.raylibOvrEyeLEndMetric.record(payload.renderLeftEndMs);
        state.raylibOvrEyeRSyncMetric.record(payload.renderRightSyncMs);
        state.raylibOvrEyeRPrepMetric.record(payload.renderRightPrepMs);
        state.raylibOvrEyeROpaqueMetric.record(payload.renderRightOpaqueMs);
        state.raylibOvrEyeRXparentMetric.record(payload.renderRightXparentMs);
        state.raylibOvrEyeRUiMetric.record(payload.renderRightUiMs);
        state.raylibOvrEyeRUiSortMetric.record(payload.renderRightUiSortPrepMs);
        state.raylibOvrEyeRUiPanMetric.record(payload.renderRightUiPanelsMs);
        state.raylibOvrEyeRUiTxtMetric.record(payload.renderRightUiTextMs);
        state.raylibOvrEyeREndMetric.record(payload.renderRightEndMs);
        state.raylibOvrCombineMetric.record(payload.renderCombineMs);
        state.raylibOvrSyncMetric.record(payload.renderSyncMs);
        state.raylibOvrDrawMetric.record(payload.renderDrawMs);
        state.raylibOvrBatchGeoMetric.record(payload.batchGeometries);
        state.raylibOvrBatchMatMetric.record(payload.batchMaterials);
        state.raylibOvrUiPanelCountMetric.record(payload.uiPanelCount);
        state.raylibOvrUiTextCountMetric.record(payload.uiTextCount);
        state.raylibOvrUiPanelDrawnMetric.record(payload.uiPanelDrawn);
        state.raylibOvrUiTextDrawnMetric.record(payload.uiTextDrawn);
      }
      state.raylibFrameInFlight = false;
      tryFlushPendingRaylibFrame();
    },
    STARTWEBXR: (payload: StartWebXRPayload | null) => {
      if (!state.host) {
        state.host = new WebXRHost();
      }
      state.controllerActor = payload?.controllerActor ?? null;
      state.overlayRenderMode = payload?.overlayRenderMode ?? "raylib";
      state.nominalHmdDisplayHz = payload?.hmdDisplayFrequencyHz ?? null;
      if (!state.startup) {
        state.startup = (async () => {
          await initializeOverlay(payload ?? null);
          if (hasAnyOverlayMode() && !state.overlayLoop) {
            state.overlayRunning = true;
            state.overlayLoop = pumpOverlayFrames().finally(() => {
              state.overlayLoop = null;
            });
          }
          const overlayMode = payload?.overlayRenderMode ?? "raylib";
          await state.host!.start({
            width: payload?.width,
            height: payload?.height,
            title: payload?.title,
            debugWindow: payload?.debugWindow,
            vrSystemPointer: payload?.vrSystemPointer,
            vrCompositorPointer: payload?.vrCompositorPointer ?? null,
            wristMenuActor: payload?.wristMenuActor,
            displayInstanceActor: payload?.displayInstanceActor,
            sessionMode: payload?.sessionMode,
            alpha: payload?.alpha,
            skipWebGpuXrDraw: overlayMode === "raylib" && !payload?.debugWindow,
            nominalHmdDisplayHz: payload?.hmdDisplayFrequencyHz ?? null,
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
        nominalHmdDisplayHz: state.nominalHmdDisplayHz,
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
      state.raythreeExtractMetric.reset();
      state.raythreeSceneMatrixMetric.reset();
      state.raythreeLeftEyeMetric.reset();
      state.raythreeRightEyeMetric.reset();
      state.raythreeUiMetric.reset();
      state.raylibHostPrepMetric.reset();
      state.raylibPostMsgMetric.reset();
      state.raylibOvrHandlerMetric.reset();
      state.raylibOvrRenderMetric.reset();
      state.raylibOvrOpenvrMetric.reset();
      state.raylibOvrEyeLeftMetric.reset();
      state.raylibOvrEyeRightMetric.reset();
      state.raylibOvrEyeLSyncMetric.reset();
      state.raylibOvrEyeLPrepMetric.reset();
      state.raylibOvrEyeLOpaqueMetric.reset();
      state.raylibOvrEyeLXparentMetric.reset();
      state.raylibOvrEyeLUiMetric.reset();
      state.raylibOvrEyeLUiSortMetric.reset();
      state.raylibOvrEyeLUiPanMetric.reset();
      state.raylibOvrEyeLUiTxtMetric.reset();
      state.raylibOvrEyeLEndMetric.reset();
      state.raylibOvrEyeRSyncMetric.reset();
      state.raylibOvrEyeRPrepMetric.reset();
      state.raylibOvrEyeROpaqueMetric.reset();
      state.raylibOvrEyeRXparentMetric.reset();
      state.raylibOvrEyeRUiMetric.reset();
      state.raylibOvrEyeRUiSortMetric.reset();
      state.raylibOvrEyeRUiPanMetric.reset();
      state.raylibOvrEyeRUiTxtMetric.reset();
      state.raylibOvrEyeREndMetric.reset();
      state.raylibOvrCombineMetric.reset();
      state.raylibOvrSyncMetric.reset();
      state.raylibOvrDrawMetric.reset();
      state.raylibOvrBatchGeoMetric.reset();
      state.raylibOvrBatchMatMetric.reset();
      state.raylibOvrUiPanelCountMetric.reset();
      state.raylibOvrUiTextCountMetric.reset();
      state.raylibOvrUiPanelDrawnMetric.reset();
      state.raylibOvrUiTextDrawnMetric.reset();
      state.raylibFrameInFlight = false;
      state.raylibFramePending = null;
      state.nominalHmdDisplayHz = null;
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
        webxrActor: state.id,
        overlayKey: state.raylibOverlayConfig.overlayKey,
        overlayName: state.raylibOverlayConfig.overlayName,
        overlayWidthInMeters: state.raylibOverlayConfig.overlayWidthInMeters,
        overlayDistance: state.raylibOverlayConfig.overlayDistance,
        sortOrder: state.raylibOverlayConfig.sortOrder,
      },
    });
  }
}

/**
 * At most one `RENDERWEBXRRAYTHREEFRAME` in the Stageforge queue; newer frames
 * replace `raylibFramePending` until the overlay acks.
 */
function tryFlushPendingRaylibFrame(): void {
  if (state.raylibFrameInFlight) {
    return;
  }
  if (!state.overlayActor || !state.raylibFramePending) {
    return;
  }
  const toSend = state.raylibFramePending;
  state.raylibFramePending = null;
  state.raylibFrameInFlight = true;
  const postStartedAt = performance.now();
  PostMan.PostMessage({
    target: state.overlayActor,
    type: "RENDERWEBXRRAYTHREEFRAME",
    payload: toSend,
    transfer: collectTransferables(toSend),
  });
  state.raylibPostMsgMetric.record(performance.now() - postStartedAt);
  state.presentMetric.record(0);
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

  const prepStartedAt = performance.now();
  const sourceFrame = state.host.captureShadowFrame();
  if (!sourceFrame) {
    return false;
  }
  const sceneContext = state.host.getRaythreeSceneContext();
  if (!sceneContext) {
    return false;
  }
  state.raylibHostPrepMetric.record(performance.now() - prepStartedAt);

  if (state.uploadedFrames === 1) {
    logFirstOverlayUpload(
      buildRaylibModeLabel(),
      sourceFrame.eyeWidth,
      sourceFrame.eyeHeight,
      sourceFrame.outputWidth,
      sourceFrame.outputHeight,
    );
  }

  // Timings: Raythree extract must stay in this worker (see webxrRaythreeScene.ts).
  // `PostMessage` to webxrOverlay is coalesced: at most one in flight; latest payload wins
  // (see `tryFlushPendingRaylibFrame` + `RAYLIBOVERLAYFRAMEACK`).
  const extractStartedAt = performance.now();
  const raythreeProbes = {
    sceneMatrix: state.raythreeSceneMatrixMetric,
    leftEye: state.raythreeLeftEyeMetric,
    rightEye: state.raythreeRightEyeMetric,
    ui: state.raythreeUiMetric,
  };
  const payload = state.raythreeSceneBridge.buildPayload(
    sceneContext,
    sourceFrame,
    undefined,
    raythreeProbes,
  );
  state.raythreeExtractMetric.record(performance.now() - extractStartedAt);
  state.raylibFramePending = payload;
  tryFlushPendingRaylibFrame();
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
        const nom = state.nominalHmdDisplayHz;
        const tail = nom != null && Number.isFinite(nom)
          ? ` (OpenVR ${nom.toFixed(0)} Hz nominal)`
          : "";
        LogChannel.log(
          "fps",
          `[webxr] overlay=${state.overlayFpsCounter.getFps().toFixed(1)}${tail}`,
        );
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

function fmtPerfInterval(
  label: string,
  sample: IntervalMetricSample | null,
): string | null {
  if (!sample) {
    return null;
  }
  return `${label}=${sample.avgMs.toFixed(2)}ms avg ${sample.maxMs.toFixed(2)}ms max`;
}

/** Same as {@link fmtPerfInterval} but for non-ms counters recorded via `IntervalMetric`. */
function fmtPerfCount(
  label: string,
  sample: IntervalMetricSample | null,
): string | null {
  if (!sample) {
    return null;
  }
  return `${label}=${sample.avgMs.toFixed(1)} avg ${sample.maxMs.toFixed(0)} max`;
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
  const raythreeSample = state.raythreeExtractMetric.flush();
  const sceneMx = state.raythreeSceneMatrixMetric.flush();
  const rayL = state.raythreeLeftEyeMetric.flush();
  const rayR = state.raythreeRightEyeMetric.flush();
  const rayUi = state.raythreeUiMetric.flush();
  const hostPrep = state.raylibHostPrepMetric.flush();
  const postMsg = state.raylibPostMsgMetric.flush();
  const ovrH = state.raylibOvrHandlerMetric.flush();
  const ovrR = state.raylibOvrRenderMetric.flush();
  const ovrO = state.raylibOvrOpenvrMetric.flush();
  const ovrEL = state.raylibOvrEyeLeftMetric.flush();
  const ovrER = state.raylibOvrEyeRightMetric.flush();
  const ovrLSy = state.raylibOvrEyeLSyncMetric.flush();
  const ovrLPr = state.raylibOvrEyeLPrepMetric.flush();
  const ovrLOp = state.raylibOvrEyeLOpaqueMetric.flush();
  const ovrLXp = state.raylibOvrEyeLXparentMetric.flush();
  const ovrLUi = state.raylibOvrEyeLUiMetric.flush();
  const ovrLUiS = state.raylibOvrEyeLUiSortMetric.flush();
  const ovrLUiP = state.raylibOvrEyeLUiPanMetric.flush();
  const ovrLUiT = state.raylibOvrEyeLUiTxtMetric.flush();
  const ovrLEd = state.raylibOvrEyeLEndMetric.flush();
  const ovrRSy = state.raylibOvrEyeRSyncMetric.flush();
  const ovrRPr = state.raylibOvrEyeRPrepMetric.flush();
  const ovrROp = state.raylibOvrEyeROpaqueMetric.flush();
  const ovrRXp = state.raylibOvrEyeRXparentMetric.flush();
  const ovrRUi = state.raylibOvrEyeRUiMetric.flush();
  const ovrRUiS = state.raylibOvrEyeRUiSortMetric.flush();
  const ovrRUiP = state.raylibOvrEyeRUiPanMetric.flush();
  const ovrRUiT = state.raylibOvrEyeRUiTxtMetric.flush();
  const ovrREd = state.raylibOvrEyeREndMetric.flush();
  const ovrCb = state.raylibOvrCombineMetric.flush();
  const ovrSy = state.raylibOvrSyncMetric.flush();
  const ovrDr = state.raylibOvrDrawMetric.flush();
  const ovrBG = state.raylibOvrBatchGeoMetric.flush();
  const ovrBM = state.raylibOvrBatchMatMetric.flush();
  const ovrUIPC = state.raylibOvrUiPanelCountMetric.flush();
  const ovrUITC = state.raylibOvrUiTextCountMetric.flush();
  const ovrUIPD = state.raylibOvrUiPanelDrawnMetric.flush();
  const ovrUITD = state.raylibOvrUiTextDrawnMetric.flush();
  if (
    !uploadSample && !presentSample && !frameSample && !raythreeSample &&
    !sceneMx && !rayL && !rayR && !rayUi && !hostPrep && !postMsg &&
    !ovrH && !ovrR && !ovrO && !ovrEL && !ovrER && !ovrLSy && !ovrLPr && !ovrLOp && !ovrLXp &&
    !ovrLUi && !ovrLUiS && !ovrLUiP && !ovrLUiT && !ovrLEd && !ovrRSy && !ovrRPr && !ovrROp && !ovrRXp &&
    !ovrRUi && !ovrRUiS && !ovrRUiP && !ovrRUiT && !ovrREd &&
    !ovrCb && !ovrSy && !ovrDr && !ovrBG && !ovrBM && !ovrUIPC && !ovrUITC && !ovrUIPD && !ovrUITD
  ) {
    return;
  }

  const parts: string[] = [];
  for (
    const line of [
      fmtPerfInterval("host-prep", hostPrep),
      fmtPerfInterval("raythree-total", raythreeSample),
      fmtPerfInterval("rt-sceneMx", sceneMx),
      fmtPerfInterval("rt-left", rayL),
      fmtPerfInterval("rt-right", rayR),
      fmtPerfInterval("rt-ui", rayUi),
      fmtPerfInterval("overlay-post", postMsg),
      fmtPerfInterval("rl-ovr-handler", ovrH),
      fmtPerfInterval("rl-ovr-render", ovrR),
      fmtPerfInterval("rl-ovr-eyeL", ovrEL),
      fmtPerfInterval("rl-ovrL-sy", ovrLSy),
      fmtPerfInterval("rl-ovrL-pr", ovrLPr),
      fmtPerfInterval("rl-ovrL-opq", ovrLOp),
      fmtPerfInterval("rl-ovrL-xp", ovrLXp),
      fmtPerfInterval("rl-ovrL-ui", ovrLUi),
      fmtPerfInterval("rl-ovrL-uiS", ovrLUiS),
      fmtPerfInterval("rl-ovrL-uiP", ovrLUiP),
      fmtPerfInterval("rl-ovrL-uiT", ovrLUiT),
      fmtPerfInterval("rl-ovrL-end", ovrLEd),
      fmtPerfInterval("rl-ovr-eyeR", ovrER),
      fmtPerfInterval("rl-ovrR-sy", ovrRSy),
      fmtPerfInterval("rl-ovrR-pr", ovrRPr),
      fmtPerfInterval("rl-ovrR-opq", ovrROp),
      fmtPerfInterval("rl-ovrR-xp", ovrRXp),
      fmtPerfInterval("rl-ovrR-ui", ovrRUi),
      fmtPerfInterval("rl-ovrR-uiS", ovrRUiS),
      fmtPerfInterval("rl-ovrR-uiP", ovrRUiP),
      fmtPerfInterval("rl-ovrR-uiT", ovrRUiT),
      fmtPerfInterval("rl-ovrR-end", ovrREd),
      fmtPerfInterval("rl-ovr-sync", ovrSy),
      fmtPerfInterval("rl-ovr-draw", ovrDr),
      fmtPerfCount("rl-ovr-geoBatch", ovrBG),
      fmtPerfCount("rl-ovr-matBatch", ovrBM),
      fmtPerfCount("rl-ovr-ui#pan", ovrUIPC),
      fmtPerfCount("rl-ovr-ui#txt", ovrUITC),
      fmtPerfCount("rl-ovr-ui#panDr", ovrUIPD),
      fmtPerfCount("rl-ovr-ui#txtDr", ovrUITD),
      fmtPerfInterval("rl-ovr-combine", ovrCb),
      fmtPerfInterval("rl-ovr-settex", ovrO),
      fmtPerfInterval("upload", uploadSample),
      fmtPerfInterval("present", presentSample),
      fmtPerfInterval("frame", frameSample),
    ]
  ) {
    if (line) {
      parts.push(line);
    }
  }
  LogChannel.log("perf", `[webxr] ${parts.join(" | ")}`);
}
