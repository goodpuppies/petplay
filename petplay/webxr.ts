import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import * as THREE from "three";
import { wait } from "../classes/utils.ts";
import { OpenVrOverlayTexture } from "../classes/openVrOverlayTexture.ts";
import { WEBXR_CRASH_ON_DROP_WARMUP_FRAMES } from "../classes/webxrCrashOnDrop.ts";
import { getCrashOnDroppedFrameMode, WebXRHost } from "../classes/webxrhost.ts";
import {
  tryCreateOpenVrOverlayFramePacer,
  type OpenVrHmdEmulationPose,
  type OpenVrOverlayFramePacer,
} from "../classes/openVrOverlayFramePacing.ts";
import { WebXROverlayGl } from "../classes/webxrOverlayGl.ts";
import { WebXROverlayRaylib, type NativeOpenVrRaylibDebugFrame } from "../classes/webxrOverlayRaylib.ts";
import { FpsCounter } from "../classes/fpsCounter.ts";
import { IntervalMetric, type IntervalMetricSample } from "../classes/intervalMetric.ts";
import type { RaylibOverlayFrameAckPayload } from "../classes/raylibOverlayAckPayload.ts";
import { WebXRRaythreeSceneBridge } from "../classes/webxrRaythreeScene.ts";
import {
  CONTROLLER_SAB_BYTE_LENGTH,
  type ControllerExternalDataTuple,
  hashControllerPoseMatrices,
  initControllerStateSab,
  readControllerStateSab,
  writeControllerStateSab,
} from "../classes/controllerStateSab.ts";
import {
  setShadowControllerPose,
  setVRCOriginFromHmdMatrix34,
} from "../classes/webxrShadowScene.ts";

function getWebxrFrameLogsEnabled(): boolean {
  const raw = Deno.args.find((a) => a.startsWith("--webxr-frame-logs"));
  if (raw == null) {
    return false;
  }
  const v = raw.split("=", 2)[1]?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

function getNativeRaylibOpenVrDebugEnabled(): boolean {
  const raw = Deno.args.find((a) => a.startsWith("--webxr-native-raylib-debug"));
  if (raw == null) {
    return false;
  }
  const v = raw.split("=", 2)[1]?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

function getNativeRaylibOpenVrDebugWithHostEnabled(): boolean {
  const raw = Deno.args.find((a) => a.startsWith("--webxr-native-raylib-debug-with-host"));
  if (raw == null) {
    return false;
  }
  const v = raw.split("=", 2)[1]?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

function getDisableHostOpenVrInputEnabled(): boolean {
  const raw = Deno.args.find((a) => a.startsWith("--webxr-disable-host-openvr-input"));
  if (raw == null) {
    return false;
  }
  const v = raw.split("=", 2)[1]?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

function getRaylibBypassRaythreeEnabled(): boolean {
  const raw = Deno.args.find((a) => a.startsWith("--webxr-raylib-bypass-raythree"));
  if (raw == null) {
    return false;
  }
  const v = raw.split("=", 2)[1]?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

function getRaylibOpenVrPacedRaythreeEnabled(): boolean {
  const raw = Deno.args.find((a) => a.startsWith("--webxr-raylib-openvr-paced-raythree"));
  if (raw == null) {
    return false;
  }
  const v = raw.split("=", 2)[1]?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

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
  nativeRaylibDebug?: boolean;
  nativeRaylibDebugWithHost?: boolean;
  disableHostOpenVrInput?: boolean;
  raylibBypassRaythree?: boolean;
  raylibOpenVrPacedRaythree?: boolean;
  /** `GETHMDDISPLAYFREQUENCY` from the hmd actor (OpenVR `Prop_DisplayFrequency_Float`). */
  hmdDisplayFrequencyHz?: number | null;
  /** `GETCOMPOSITORPTR` from the OpenVR actor; optional for Aardvark-style overlay display pacing. */
  vrCompositorPointer?: bigint | null;
  /** `GETINPUTPTR` from the OpenVR actor — OpenVR input is sampled in the **webxr** rAF (see `WebXRHost`) so poses match display timing; optional SAB still mirrors to `controllers` for laser/GC. */
  vrInputPointer?: number | bigint | null;
};

type ControllerDataPayload = ControllerExternalDataTuple;

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
  raylibOverlay: null as OpenVrOverlayTexture | null,
  raylibOverlayRaylib: null as WebXROverlayRaylib | null,
  nativeRaylibDebug: false,
  nativeRaylibDebugWithHost: false,
  nativeRaylibPacer: null as OpenVrOverlayFramePacer | null,
  nativeRaylibVrSystem: null as OpenVR.IVRSystem | null,
  nativeRaylibLeftControllerIndex: null as number | null,
  nativeRaylibRightControllerIndex: null as number | null,
  nativeRaylibDebugTraceFirstFrame: false,
  disableHostOpenVrInput: false,
  raylibBypassRaythree: false,
  raylibBypassRaythreeLogged: false,
  raylibOpenVrPacedRaythree: false,
  raylibOpenVrPacedRaythreeLogged: false,
  raylibShadowNoSourceLogged: false,
  raylibShadowNoSceneLogged: false,
  raylibOpenVrPacedLastStatusLogAt: 0,
  webGpuOverlayConfig: null as OverlayConfig | null,
  raylibOverlayConfig: null as OverlayConfig | null,
  overlayRenderMode: "raylib" as OverlayRenderMode,
  overlayLoop: null as Promise<void> | null,
  controllerLoop: null as Promise<void> | null,
  controllerRunning: false,
  controllerActor: null as string | null,
  /** Set when SAB attach succeeds before `WebXRHost.start`; frame ingest reads this. */
  controllerSharedStateSab: null as SharedArrayBuffer | null,
  /**
   * Last `writeSeq` from `readControllerStateSab` (`-1` = none yet). Only advances when
   * the SAB **writer** starves; the writer is ~1kHz so this rarely matters vs pose dupes.
   */
  lastControllerSabWriteSeq: -1,
  /** FNV hash of L/R 3×4 at previous XR rAF (for `controller-stale` pose-dup). */
  lastRafControllerPoseHash: null as number | null,
  overlayRunning: false,
  lastUploadedHostFrameCount: -1,
  uploadedFrames: 0,
  waitLogCounter: 0,
  overlayFpsCounter: new FpsCounter(),
  frameLogsEnabled: false,
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
  /** Full in-process Raylib overlay handler until after `SetOverlayTexture`. */
  raylibOvrHandlerMetric: new IntervalMetric(),
  /** `WebXROverlayRaylib.renderRaythreeFrame` in the webxr worker. */
  raylibOvrRenderMetric: new IntervalMetric(),
  /** `setTextureHandle` + `SetOverlayTexture` in the webxr worker (excludes raylib compositor). */
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
    STARTWEBXR: (payload: StartWebXRPayload | null) => {
      if (!state.host) {
        state.host = new WebXRHost();
      }
      state.controllerActor = payload?.controllerActor ?? null;
      state.overlayRenderMode = payload?.overlayRenderMode ?? "raylib";
      state.nominalHmdDisplayHz = payload?.hmdDisplayFrequencyHz ?? null;
      state.frameLogsEnabled = getWebxrFrameLogsEnabled();
      state.nativeRaylibDebug = payload?.nativeRaylibDebug ?? getNativeRaylibOpenVrDebugEnabled();
      state.nativeRaylibDebugWithHost = payload?.nativeRaylibDebugWithHost ??
        getNativeRaylibOpenVrDebugWithHostEnabled();
      state.disableHostOpenVrInput = payload?.disableHostOpenVrInput ??
        getDisableHostOpenVrInputEnabled();
      state.raylibBypassRaythree = payload?.raylibBypassRaythree ??
        getRaylibBypassRaythreeEnabled();
      state.raylibOpenVrPacedRaythree = payload?.raylibOpenVrPacedRaythree ??
        getRaylibOpenVrPacedRaythreeEnabled();
      if (!state.startup) {
        state.startup = (async () => {
          await initializeOverlay(payload ?? null);
          if (state.nativeRaylibDebug) {
            initializeNativeRaylibDebug(payload ?? null);
            LogChannel.log(
              "webxrv2",
              state.nativeRaylibDebugWithHost
                ? "[webxr] native Raylib/OpenVR debug mode (WebXRHost also running; host OpenVR pacer disabled)"
                : "[webxr] native Raylib/OpenVR debug mode (skipping WebXRHost)",
            );
            state.nativeRaylibDebugTraceFirstFrame = true;
            if (hasAnyOverlayMode() && !state.overlayLoop) {
              state.overlayRunning = true;
              await wait(0);
              state.overlayLoop = pumpOverlayFrames().finally(() => {
                state.overlayLoop = null;
              });
            }
            if (!state.nativeRaylibDebugWithHost) {
              while (state.overlayRunning) {
                await wait(16);
              }
              return;
            }
          }
          if (hasAnyOverlayMode() && !state.overlayLoop) {
            state.overlayRunning = true;
            state.overlayLoop = pumpOverlayFrames().finally(() => {
              state.overlayLoop = null;
            });
          }
          if (includesRaylibOverlay(payload?.overlayRenderMode ?? "raylib")) {
            initializeRaylibOpenVrPacer(payload ?? null, "raylib overlay");
          }
          const overlayMode = payload?.overlayRenderMode ?? "raylib";
          const crashOnDropMode = getCrashOnDroppedFrameMode();
          if (crashOnDropMode.controllerSabStale) {
            LogChannel.log(
              "webxrv2",
              "[webxr] crash-on-dropped-frame: controller-stale (same pose hash 2× rAF " +
                "with OpenVR |v|/|ω| above floor — or writeSeq stuck; not “writer slow” by itself)",
            );
          }

          let onBeforeExternalControllerApply: (() => void) | undefined;
          state.controllerSharedStateSab = null;
          const effectiveVrInputPointer = state.disableHostOpenVrInput
            ? null
            : payload?.vrInputPointer ?? null;
          const vrInputPaced = effectiveVrInputPointer != null;

          const runControllerStaleChecks = (data: ControllerDataPayload, writeSeq: number) => {
            const host = state.host;
            if (!host) return;
            const fc = host.getStatus().frameCount;
            const h = hashControllerPoseMatrices(data);
            const maxMotion = (() => {
              const v = (p: ControllerDataPayload[0]) => {
                const l = p.pose.vVelocity.v;
                const a = p.pose.vAngularVelocity.v;
                return Math.max(
                  Math.hypot(l[0]!, l[1]!, l[2]!),
                  Math.hypot(a[0]!, a[1]!, a[2]!),
                );
              };
              return Math.max(v(data[0]!), v(data[1]!));
            })();
            const STALE_MOTION_FLOOR = 0.02;
            if (crashOnDropMode.controllerSabStale && fc >= WEBXR_CRASH_ON_DROP_WARMUP_FRAMES) {
              const samePoseTwoRafs = state.lastRafControllerPoseHash != null &&
                h === state.lastRafControllerPoseHash;
              const writerStarved = writeSeq > 0 &&
                state.lastControllerSabWriteSeq >= 0 &&
                writeSeq === state.lastControllerSabWriteSeq;
              if (writerStarved) {
                throw new Error(
                  `[webxr] controller-stale: SAB writeSeq stuck at ${writeSeq} (no new sample between XR rAFs)`,
                );
              }
              if (samePoseTwoRafs && maxMotion > STALE_MOTION_FLOOR) {
                throw new Error(
                  `[webxr] controller-stale: same pose hash on two consecutive XR rAFs while ` +
                    `OpenVR |v|/|ω| max=${maxMotion.toFixed(4)} (>${STALE_MOTION_FLOOR}): ` +
                    `tracking did not advance the 3×4 between display frames`,
                );
              }
            }
            state.lastRafControllerPoseHash = h;
            state.lastControllerSabWriteSeq = writeSeq;
          };

          if (state.controllerActor) {
            const sab = new SharedArrayBuffer(CONTROLLER_SAB_BYTE_LENGTH);
            initControllerStateSab(sab);
            try {
              if (vrInputPaced) {
                await PostMan.PostMessage({
                  target: state.controllerActor,
                  type: "SETCONTROLLERSHAREDSTATE",
                  payload: { sab, webxrPacedWriter: true },
                }, true);
              } else {
                await PostMan.PostMessage({
                  target: state.controllerActor,
                  type: "SETCONTROLLERSHAREDSTATE",
                  payload: sab,
                }, true);
              }
              state.controllerSharedStateSab = sab;
              state.lastControllerSabWriteSeq = -1;
              state.lastRafControllerPoseHash = null;
              if (!vrInputPaced) {
                /**
                 * OpenVR samples run in the `controllers` actor (see `scheduleControllerSabFrame`),
                 * then webxr *reads* the SAB in this callback (legacy path).
                 */
                onBeforeExternalControllerApply = function webxrIngestControllerSabAndCheckStale() {
                  const buf = state.controllerSharedStateSab;
                  const host = state.host;
                  if (!buf || !host) return;
                  const read = readControllerStateSab(buf);
                  if (!read) return;
                  const { data, writeSeq, motion } = read;
                  const fc = host.getStatus().frameCount;
                  const h = hashControllerPoseMatrices(data);
                  const maxMotion = Math.max(
                    motion.leftLin,
                    motion.leftAng,
                    motion.rightLin,
                    motion.rightAng,
                  );
                  const STALE_MOTION_FLOOR = 0.02;
                  if (
                    crashOnDropMode.controllerSabStale && fc >= WEBXR_CRASH_ON_DROP_WARMUP_FRAMES
                  ) {
                    const samePoseTwoRafs = state.lastRafControllerPoseHash != null &&
                      h === state.lastRafControllerPoseHash;
                    const writerStarved = writeSeq > 0 &&
                      state.lastControllerSabWriteSeq >= 0 &&
                      writeSeq === state.lastControllerSabWriteSeq;
                    if (writerStarved) {
                      throw new Error(
                        `[webxr] controller-stale: SAB writeSeq stuck at ${writeSeq} (writer did not ` +
                          `run between XR rAF ticks; unlikely at ~1kHz unless actor blocked)`,
                      );
                    }
                    if (samePoseTwoRafs && maxMotion > STALE_MOTION_FLOOR) {
                      throw new Error(
                        `[webxr] controller-stale: same pose hash on two consecutive XR rAFs while ` +
                          `OpenVR |v|/|ω| max=${maxMotion.toFixed(4)} (>${STALE_MOTION_FLOOR}): ` +
                          `tracking did not advance the 3×4 between display frames; SAB still saw ~1kHz writes.`,
                      );
                    }
                  }
                  state.lastRafControllerPoseHash = h;
                  state.lastControllerSabWriteSeq = writeSeq;
                  host.setControllerData(data);
                  publishControllerSnapshot(data);
                };
              }
            } catch (error) {
              LogChannel.log(
                "webxrv2",
                `[webxr] controller SAB not available, will use postMessage polling: ${error}`,
              );
            }
          }

          const onInProcessControllerFrame: ((d: ControllerDataPayload) => void) | undefined =
            vrInputPaced
              ? (d) => {
                const buf = state.controllerSharedStateSab;
                if (buf) {
                  writeControllerStateSab(buf, d);
                  const read = readControllerStateSab(buf);
                  if (read) {
                    if (crashOnDropMode.controllerSabStale) {
                      runControllerStaleChecks(d, read.writeSeq);
                    } else {
                      state.lastRafControllerPoseHash = hashControllerPoseMatrices(d);
                      state.lastControllerSabWriteSeq = read.writeSeq;
                    }
                  }
                }
                publishControllerSnapshot(d);
              }
              : undefined;

          await state.host!.start({
            width: payload?.width,
            height: payload?.height,
            title: payload?.title,
            debugWindow: payload?.debugWindow,
            vrSystemPointer: payload?.vrSystemPointer,
            vrInputPointer: effectiveVrInputPointer,
            vrCompositorPointer: payload?.vrCompositorPointer ?? null,
            wristMenuActor: payload?.wristMenuActor,
            displayInstanceActor: payload?.displayInstanceActor,
            sessionMode: payload?.sessionMode,
            alpha: payload?.alpha,
            skipWebGpuXrDraw: overlayMode === "raylib" && !payload?.debugWindow,
            nominalHmdDisplayHz: payload?.hmdDisplayFrequencyHz ?? null,
            useOpenVrOverlayFramePacing: includesRaylibOverlay(overlayMode) && !payload?.debugWindow
              ? false
              : undefined,
            disableOpenVrHmdPose: state.raylibOpenVrPacedRaythree,
            onBeforeExternalControllerApply: vrInputPaced
              ? undefined
              : onBeforeExternalControllerApply,
            onInProcessControllerFrame: vrInputPaced ? onInProcessControllerFrame : undefined,
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
        lastLayerInfo: null,
        xrRafMaxIntervalMs: 0,
        xrRafSlowFrameCount: 0,
        vsyncDisplayFramesSkipped: 0,
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
      state.lastControllerSabWriteSeq = -1;
      state.lastRafControllerPoseHash = null;
      state.webGpuOverlay?.cleanup();
      state.webGpuOverlay = null;
      state.webGpuOverlayGl?.cleanup();
      state.webGpuOverlayGl = null;
      state.raylibOverlay?.cleanup();
      state.raylibOverlay = null;
      state.raylibOverlayRaylib?.cleanup();
      state.raylibOverlayRaylib = null;
      state.nativeRaylibPacer = null;
      state.nativeRaylibVrSystem = null;
      state.nativeRaylibLeftControllerIndex = null;
      state.nativeRaylibRightControllerIndex = null;
      state.nativeRaylibDebug = false;
      state.nativeRaylibDebugWithHost = false;
      state.nativeRaylibDebugTraceFirstFrame = false;
      state.disableHostOpenVrInput = false;
      state.raylibBypassRaythree = false;
      state.raylibBypassRaythreeLogged = false;
      state.raylibOpenVrPacedRaythree = false;
      state.raylibOpenVrPacedRaythreeLogged = false;
      state.raylibShadowNoSourceLogged = false;
      state.raylibShadowNoSceneLogged = false;
      state.raylibOpenVrPacedLastStatusLogAt = 0;
      state.webGpuOverlayConfig = null;
      state.raylibOverlayConfig = null;
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
      state.nominalHmdDisplayHz = null;
    },
  } as const,
);

globalThis.addEventListener("unload", () => {
  state.controllerRunning = false;
  state.overlayRunning = false;
  state.webGpuOverlay?.cleanup();
  state.webGpuOverlayGl?.cleanup();
  state.raylibOverlay?.cleanup();
  state.raylibOverlayRaylib?.cleanup();
  state.webGpuOverlay = null;
  state.webGpuOverlayGl = null;
  state.raylibOverlay = null;
  state.raylibOverlayRaylib = null;
  state.webGpuOverlayConfig = null;
  state.raylibOverlayConfig = null;
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
  await state.startup;

  const detachControllerSab = async () => {
    const id = state.controllerActor;
    if (!id) return;
    state.controllerSharedStateSab = null;
    try {
      await PostMan.PostMessage({
        target: id,
        type: "SETCONTROLLERSHAREDSTATE",
        payload: null,
      }, true);
    } catch {
      // Controller may already be gone.
    }
  };

  const useSabIngest = state.controllerSharedStateSab != null;

  try {
    if (useSabIngest) {
      while (state.controllerRunning) {
        await wait(500);
      }
      return;
    }

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
  } finally {
    if (useSabIngest) {
      await detachControllerSab();
    }
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
    overlayGl.initialize(
      buildOverlayName(payload.overlayName, "WebGPU") ?? "PetPlay WebXR Overlay WebGPU",
    );
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

  if (includesRaylibOverlay(overlayMode) && !state.raylibOverlayRaylib) {
    const raylibOverlay = new WebXROverlayRaylib();
    const overlayName = buildOverlayName(payload.overlayName, "Raylib") ??
      "PetPlay WebXR Overlay Raylib";
    raylibOverlay.initialize(overlayName);
    state.raylibOverlayRaylib = raylibOverlay;
    state.raylibOverlayConfig = {
      overlayPointer: payload.overlayPointer,
      overlayKey: buildOverlayKey(payload.overlayKey, "raylib"),
      overlayName,
      overlayWidthInMeters: payload.overlayWidthInMeters,
      overlayDistance: payload.overlayDistance,
      overlayMode: "stereo-panorama",
      sortOrder: 20,
      attachToHmd: true,
    };
    LogChannel.log("webxrv2", "[webxr] raylib overlay running in webxr worker hot loop");
  }
}

function initializeNativeRaylibDebug(payload: StartWebXRPayload | null) {
  initializeRaylibOpenVrPacer(payload, "native Raylib debug");
}

function initializeRaylibOpenVrPacer(payload: StartWebXRPayload | null, label: string) {
  if (!payload?.vrSystemPointer) {
    throw new Error(`${label} requires vrSystemPointer`);
  }
  if (state.nativeRaylibPacer && state.nativeRaylibVrSystem) {
    return;
  }
  LogChannel.log("webxrv2", `[webxr] ${label} init: creating IVRSystem wrapper`);
  const systemPointer = Deno.UnsafePointer.create(
    typeof payload.vrSystemPointer === "bigint"
      ? payload.vrSystemPointer
      : BigInt(payload.vrSystemPointer),
  );
  if (!systemPointer) {
    throw new Error(`invalid vrSystemPointer for ${label}`);
  }
  state.nativeRaylibVrSystem = new OpenVR.IVRSystem(systemPointer);
  LogChannel.log("webxrv2", `[webxr] ${label} init: creating OpenVR pacer`);
  state.nativeRaylibPacer = tryCreateOpenVrOverlayFramePacer(
    payload.vrSystemPointer,
    payload.vrCompositorPointer ?? null,
    true,
    false,
    "vsync",
  );
  if (!state.nativeRaylibPacer) {
    throw new Error(`failed to create OpenVR pacer for ${label}`);
  }
  LogChannel.log("webxrv2", `[webxr] ${label} init: ready`);
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

function ensureRaylibOverlayForFrame() {
  if (state.raylibOverlay || !state.raylibOverlayRaylib || !state.raylibOverlayConfig) {
    return;
  }

  const nextOverlay = new OpenVrOverlayTexture(state.raylibOverlayConfig.overlayPointer);
  nextOverlay.initialize(state.raylibOverlayRaylib.getTextureHandle(), {
    key: state.raylibOverlayConfig.overlayKey,
    name: state.raylibOverlayConfig.overlayName,
    widthInMeters: state.raylibOverlayConfig.overlayWidthInMeters,
    distance: state.raylibOverlayConfig.overlayDistance,
    mode: state.raylibOverlayConfig.overlayMode ?? "quad",
    sortOrder: state.raylibOverlayConfig.sortOrder,
    attachToHmd: state.raylibOverlayConfig.attachToHmd,
    flipVertical: false,
  });
  state.raylibOverlay = nextOverlay;
}

function recordRaylibOverlayMetrics(payload: RaylibOverlayFrameAckPayload) {
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

function logFirstOverlayUpload(
  modeLabel: string,
  width: number,
  height: number,
  outputWidth: number,
  outputHeight: number,
) {
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
  return includesRaylibOverlay(state.overlayRenderMode) ||
    includesWebGpuOverlay(state.overlayRenderMode);
}

async function uploadRaylibShadowFrame() {
  if (!state.host || !state.raylibOverlayRaylib) {
    return false;
  }

  if (state.raylibBypassRaythree) {
    if (!state.raylibBypassRaythreeLogged) {
      LogChannel.log(
        "webxrv2",
        "[webxr] raylib overlay bypassing Raythree extraction/render (native OpenVR debug frame)",
      );
      state.raylibBypassRaythreeLogged = true;
    }
    return await uploadNativeRaylibDebugFrame();
  }

  const prepStartedAt = performance.now();
  if (state.nativeRaylibPacer) {
    state.nativeRaylibPacer.paceToDisplayAndRefreshPoses();
    state.host.applyDirectOpenVrShadowPose(state.nativeRaylibPacer.getCachedHmdEmulation());
    const leftController = getNativeRaylibControllerPose(
      OpenVR.TrackedControllerRole.TrackedControllerRole_LeftHand,
    );
    state.host.applyDirectRaylibDebugLeftControllerPosition(
      leftController ? new Float32Array(leftController.position) : null,
    );
  }
  const sourceFrame = state.host.captureShadowFrame();
  if (!sourceFrame) {
    if (!state.raylibShadowNoSourceLogged) {
      const status = state.host.getStatus();
      LogChannel.log(
        "webxrv2",
        `[webxr] Raylib shadow frame unavailable: frameCount=${status.frameCount} ${
          status.lastLayerInfo ?? "no layer info"
        }`,
      );
      state.raylibShadowNoSourceLogged = true;
    }
    return false;
  }
  const sceneContext = state.host.getRaythreeSceneContext();
  if (!sceneContext) {
    if (!state.raylibShadowNoSceneLogged) {
      const status = state.host.getStatus();
      LogChannel.log(
        "webxrv2",
        `[webxr] Raythree scene context unavailable: frameCount=${status.frameCount} ${
          status.lastLayerInfo ?? "no layer info"
        }`,
      );
      state.raylibShadowNoSceneLogged = true;
    }
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

  const handlerT0 = performance.now();
  const rt = state.raylibOverlayRaylib.renderRaythreeFrame(payload);
  const renderMs = rt.totalMs;

  const openvrT0 = performance.now();
  ensureRaylibOverlayForFrame();
  if (!state.raylibOverlay) {
    throw new Error("OpenVR Raylib overlay not initialized");
  }
  state.raylibOverlay.setTextureHandle(state.raylibOverlayRaylib.getTextureHandle());
  state.raylibOverlay.present();
  const openvrMs = performance.now() - openvrT0;
  const handlerMs = performance.now() - handlerT0;

  recordRaylibOverlayMetrics({
    handlerMs,
    renderMs,
    openvrMs,
    renderLeftMs: rt.leftMs,
    renderRightMs: rt.rightMs,
    renderLeftSyncMs: rt.renderLeftSyncMs,
    renderLeftPrepMs: rt.renderLeftPrepMs,
    renderLeftOpaqueMs: rt.renderLeftOpaqueMs,
    renderLeftXparentMs: rt.renderLeftXparentMs,
    renderLeftUiMs: rt.renderLeftUiMs,
    renderLeftUiSortPrepMs: rt.renderLeftUiSortPrepMs,
    renderLeftUiPanelsMs: rt.renderLeftUiPanelsMs,
    renderLeftUiTextMs: rt.renderLeftUiTextMs,
    renderLeftEndMs: rt.renderLeftEndMs,
    renderRightSyncMs: rt.renderRightSyncMs,
    renderRightPrepMs: rt.renderRightPrepMs,
    renderRightOpaqueMs: rt.renderRightOpaqueMs,
    renderRightXparentMs: rt.renderRightXparentMs,
    renderRightUiMs: rt.renderRightUiMs,
    renderRightUiSortPrepMs: rt.renderRightUiSortPrepMs,
    renderRightUiPanelsMs: rt.renderRightUiPanelsMs,
    renderRightUiTextMs: rt.renderRightUiTextMs,
    renderRightEndMs: rt.renderRightEndMs,
    renderCombineMs: rt.combineMs,
    renderSyncMs: rt.renderSyncMs,
    renderDrawMs: rt.renderDrawMs,
    batchGeometries: rt.batchGeometries,
    batchMaterials: rt.batchMaterials,
    uiPanelCount: rt.uiPanelCount,
    uiTextCount: rt.uiTextCount,
    uiPanelDrawn: rt.uiPanelDrawn,
    uiTextDrawn: rt.uiTextDrawn,
  });
  return true;
}

function openVrLookRotationFromWorldHmd(worldFromHmd: Float32Array): Float32Array {
  const hmdFromWorld = new THREE.Matrix4()
    .fromArray(worldFromHmd as unknown as number[])
    .invert();
  return new Float32Array(
    hmdFromWorld.multiply(new THREE.Matrix4().makeScale(1, 1, -1)).elements,
  );
}

function projectionHalfFov(matrix: Float32Array): number {
  const m5 = Number(matrix[5] ?? 0);
  return Number.isFinite(m5) && m5 !== 0
    ? Math.atan(1 / m5)
    : ((112 / 2) * (Math.PI / 180));
}

function nativeDebugProjectionMatrix(): Float32Array {
  const camera = new THREE.PerspectiveCamera(112, 1, 0.05, 100);
  camera.updateProjectionMatrix();
  return new Float32Array(camera.projectionMatrix.elements);
}

function buildNativeOpenVrDebugFrame(): NativeOpenVrRaylibDebugFrame | null {
  const pacer = state.nativeRaylibPacer;
  const vr = state.nativeRaylibVrSystem;
  if (!pacer || !vr) {
    return null;
  }

  const trace = state.nativeRaylibDebugTraceFirstFrame;
  if (trace) LogChannel.log("webxrv2", "[webxr] native debug frame: pace");
  pacer.paceToDisplayAndRefreshPoses();
  if (trace) LogChannel.log("webxrv2", "[webxr] native debug frame: read hmd");
  const hmd = pacer.getCachedHmdEmulation();
  if (!hmd) {
    return null;
  }

  if (trace) LogChannel.log("webxrv2", "[webxr] native debug frame: controller index");
  const leftControllerIndex = vr.GetTrackedDeviceIndexForControllerRole(
    OpenVR.TrackedControllerRole.TrackedControllerRole_LeftHand,
  );
  state.nativeRaylibLeftControllerIndex = leftControllerIndex;
  if (trace) {
    LogChannel.log("webxrv2", `[webxr] native debug frame: controller index=${leftControllerIndex}`);
  }
  const leftController = pacer.getCachedTrackedDevicePose(leftControllerIndex);
  const worldFromHmd = new THREE.Matrix4().fromArray(hmd.matrix as unknown as number[]);
  if (trace) LogChannel.log("webxrv2", "[webxr] native debug frame: eye matrices");
  const ipdMeters = 0.064;
  const leftWorld = new THREE.Matrix4()
    .copy(worldFromHmd)
    .multiply(new THREE.Matrix4().makeTranslation(-ipdMeters * 0.5, 0, 0));
  const rightWorld = new THREE.Matrix4()
    .copy(worldFromHmd)
    .multiply(new THREE.Matrix4().makeTranslation(ipdMeters * 0.5, 0, 0));
  if (trace) LogChannel.log("webxrv2", "[webxr] native debug frame: synthetic projection");
  const leftProjection = nativeDebugProjectionMatrix();
  const rightProjection = nativeDebugProjectionMatrix();

  return {
    leftProjectionMatrix: leftProjection,
    leftViewMatrix: new Float32Array(leftWorld.invert().elements),
    rightProjectionMatrix: rightProjection,
    rightViewMatrix: new Float32Array(rightWorld.invert().elements),
    lookRotation: openVrLookRotationFromWorldHmd(hmd.matrix),
    halfFovInRadians: projectionHalfFov(leftProjection),
    hmdPosition: new Float32Array(hmd.position),
    leftControllerPosition: leftController ? new Float32Array(leftController.position) : null,
  };
}

function getNativeRaylibLeftControllerPosition(): Float32Array | null {
  const pose = getNativeRaylibControllerPose(
    OpenVR.TrackedControllerRole.TrackedControllerRole_LeftHand,
  );
  return pose ? new Float32Array(pose.position) : null;
}

function getNativeRaylibControllerPose(
  role: OpenVR.TrackedControllerRole,
): OpenVrHmdEmulationPose | null {
  const pacer = state.nativeRaylibPacer;
  const vr = state.nativeRaylibVrSystem;
  if (!pacer || !vr) {
    return null;
  }

  const isLeft = role === OpenVR.TrackedControllerRole.TrackedControllerRole_LeftHand;
  let index = isLeft ? state.nativeRaylibLeftControllerIndex : state.nativeRaylibRightControllerIndex;
  if (index == null || index === OpenVR.k_unTrackedDeviceIndexInvalid) {
    index = vr.GetTrackedDeviceIndexForControllerRole(role);
    if (isLeft) {
      state.nativeRaylibLeftControllerIndex = index;
    } else {
      state.nativeRaylibRightControllerIndex = index;
    }
  }
  if (index === OpenVR.k_unTrackedDeviceIndexInvalid) {
    return null;
  }
  return pacer.getCachedTrackedDevicePose(index);
}

async function uploadNativeRaylibDebugFrame() {
  if (!state.raylibOverlayRaylib) {
    return false;
  }
  const trace = state.nativeRaylibDebugTraceFirstFrame;
  if (trace) LogChannel.log("webxrv2", "[webxr] native debug frame: build");
  const frame = buildNativeOpenVrDebugFrame();
  if (!frame) {
    return false;
  }
  if (trace) LogChannel.log("webxrv2", "[webxr] native debug frame: raylib render");
  const t0 = performance.now();
  const rt = state.raylibOverlayRaylib.renderNativeOpenVrDebugFrame(frame);
  state.raylibOvrRenderMetric.record(rt.totalMs);
  state.raylibOvrEyeLeftMetric.record(rt.leftMs);
  state.raylibOvrEyeRightMetric.record(rt.rightMs);
  state.raylibOvrCombineMetric.record(rt.combineMs);
  const openvrT0 = performance.now();
  if (trace) LogChannel.log("webxrv2", "[webxr] native debug frame: openvr overlay ensure");
  ensureRaylibOverlayForFrame();
  if (!state.raylibOverlay) {
    throw new Error("OpenVR Raylib overlay not initialized");
  }
  if (trace) LogChannel.log("webxrv2", "[webxr] native debug frame: openvr overlay present");
  state.raylibOverlay.setTextureHandle(state.raylibOverlayRaylib.getTextureHandle());
  state.raylibOverlay.present();
  state.raylibOvrOpenvrMetric.record(performance.now() - openvrT0);
  state.raylibOvrHandlerMetric.record(performance.now() - t0);
  if (trace) {
    state.nativeRaylibDebugTraceFirstFrame = false;
    LogChannel.log("webxrv2", "[webxr] native debug frame: first frame complete");
  }
  return true;
}

async function pumpOverlayFrames() {
  const dropCrash = getCrashOnDroppedFrameMode();
  while (state.overlayRunning) {
    if (state.nativeRaylibDebug) {
      try {
        const frameStartedAt = performance.now();
        if (await uploadNativeRaylibDebugFrame()) {
          state.uploadedFrames++;
          state.overlayFpsCounter.mark();
          state.frameMetric.record(performance.now() - frameStartedAt);
          maybeLogOverlayPerf();
        } else {
          await wait(1);
        }
      } catch (error) {
        LogChannel.log("webxrv2", `[webxr] native Raylib debug frame failed: ${error}`);
        state.overlayRunning = false;
        throw error;
      }
      continue;
    }
    if (state.raylibBypassRaythree) {
      try {
        if (!state.raylibBypassRaythreeLogged) {
          LogChannel.log(
            "webxrv2",
            "[webxr] raylib overlay bypassing WebXR frame gate and Raythree (native OpenVR debug frame)",
          );
          state.raylibBypassRaythreeLogged = true;
        }
        const frameStartedAt = performance.now();
        if (await uploadNativeRaylibDebugFrame()) {
          state.uploadedFrames++;
          state.overlayFpsCounter.mark();
          state.frameMetric.record(performance.now() - frameStartedAt);
          maybeLogOverlayPerf();
        } else {
          await wait(1);
        }
      } catch (error) {
        LogChannel.log("webxrv2", `[webxr] raylib bypass frame failed: ${error}`);
        state.overlayRunning = false;
        throw error;
      }
      continue;
    }
    if (state.raylibOpenVrPacedRaythree) {
      try {
        if (!state.raylibOpenVrPacedRaythreeLogged) {
          LogChannel.log(
            "webxrv2",
            "[webxr] raylib overlay OpenVR-paced Raythree mode (latest host scene, no WebXR frame gate)",
          );
          state.raylibOpenVrPacedRaythreeLogged = true;
        }
        const frameStartedAt = performance.now();
        let rendered = await uploadRaylibShadowFrame();
        if (!rendered) {
          rendered = await uploadNativeRaylibDebugFrame();
        }
        if (rendered) {
          state.uploadedFrames++;
          state.overlayFpsCounter.mark();
          state.frameMetric.record(performance.now() - frameStartedAt);
          maybeLogOverlayPerf();
          await wait(0);
        } else {
          await wait(1);
        }
      } catch (error) {
        LogChannel.log("webxrv2", `[webxr] OpenVR-paced Raythree frame failed: ${error}`);
        state.overlayRunning = false;
        throw error;
      }
      continue;
    }
    if (!state.host || !hasAnyOverlayMode()) {
      await wait(10);
      continue;
    }

    const hostStatus = state.host.getStatus();
    if (
      dropCrash.overlay &&
      hostStatus.frameCount > WEBXR_CRASH_ON_DROP_WARMUP_FRAMES &&
      state.lastUploadedHostFrameCount >= 0
    ) {
      if (hostStatus.frameCount > state.lastUploadedHostFrameCount + 1) {
        throw new Error(
          `[webxr] overlay path missed host frame(s): lastUploadAtHostFrame=${state.lastUploadedHostFrameCount} now=${hostStatus.frameCount} (one host tick advanced without a matching overlay run)`,
        );
      }
    }
    if (hostStatus.frameCount <= state.lastUploadedHostFrameCount) {
      await wait(1);
      continue;
    }

    const canUseRaylib = includesRaylibOverlay(state.overlayRenderMode) &&
      Boolean(state.raylibOverlayRaylib);
    const canUseWebGpu = includesWebGpuOverlay(state.overlayRenderMode) &&
      Boolean(state.webGpuOverlayGl);
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
      if (state.frameLogsEnabled && now - state.lastOverlayFpsLogAt >= 1000) {
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
  if (!state.frameLogsEnabled) {
    return;
  }
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
    !sceneMx && !rayL && !rayR && !rayUi && !hostPrep &&
    !ovrH && !ovrR && !ovrO && !ovrEL && !ovrER && !ovrLSy && !ovrLPr && !ovrLOp && !ovrLXp &&
    !ovrLUi && !ovrLUiS && !ovrLUiP && !ovrLUiT && !ovrLEd && !ovrRSy && !ovrRPr && !ovrROp &&
    !ovrRXp &&
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
