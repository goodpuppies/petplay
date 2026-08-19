import { LogChannel } from "@mommysgoodpuppy/logchannel";
import raylib from "../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import { getRaylibLibraryPath } from "./nativeLibraryPaths.ts";
import { areNativeAssetBatchesIdenticalForSync } from "./raythreeAssetBatchesForSync.ts";
import type { WebXRRaythreeRenderPayload } from "./webxrRaythreeScene.ts";
import { WebXRRaythreeRaylibRenderer } from "./webxrRaythreeRaylibRenderer.ts";
import { WEBXR_VARGGLES_GLSL330_FRAGMENT } from "./webxrVargglesShader.ts";
import {
  getCurrentContextId,
  getFramebufferStatus,
  getGlError,
  getGraphicsResetStatus,
  isTextureAlive,
} from "./glHealth.ts";

export type NativeOpenVrRaylibDebugFrame = {
  leftProjectionMatrix: Float32Array;
  leftViewMatrix: Float32Array;
  rightProjectionMatrix: Float32Array;
  rightViewMatrix: Float32Array;
  lookRotation: Float32Array;
  halfFovInRadians: number;
  hmdPosition: Float32Array;
  leftControllerPosition: Float32Array | null;
};

const VARGGLES_FRAGMENT_SHADER = WEBXR_VARGGLES_GLSL330_FRAGMENT;
const TRANSPARENT_BLACK = { r: 0, g: 0, b: 0, a: 0 } as raylib.Color;
/**
 * Canary stages across the render pipeline.
 *
 * Each stage paints a solid square of its own colour into whichever target is
 * bound at that point, in its own slot along the top edge. Sampling the targets
 * afterwards shows which stages' writes survived: a missing square means writes
 * issued at that stage were discarded, which localises a "draws go nowhere"
 * failure to a specific layer instead of only knowing the final texture is half
 * black.
 */
export const RENDER_CANARY_STAGES = [
  // Painted before the scene renderer clears; expected to be erased when the
  // clear works, so its presence means the clear itself is not landing.
  { id: "eyePreClear", color: { r: 255, g: 0, b: 0, a: 255 } },
  { id: "eyePostScene", color: { r: 0, g: 255, b: 0, a: 255 } },
  { id: "eyePreEnd", color: { r: 0, g: 0, b: 255, a: 255 } },
  { id: "outputPostClear", color: { r: 255, g: 255, b: 0, a: 255 } },
  { id: "outputPostLeft", color: { r: 255, g: 0, b: 255, a: 255 } },
  { id: "outputPostRight", color: { r: 0, g: 255, b: 255, a: 255 } },
] as const;

export type RenderCanaryStage = typeof RENDER_CANARY_STAGES[number]["id"];

/** Slot geometry for a canary square, in pixels, for a square target of `size`. */
function canarySlotRect(size: number, slot: number) {
  const box = Math.max(8, Math.floor(size / 24));
  const gap = Math.floor(box / 2);
  return { x: gap + slot * (box + gap), y: gap, w: box, h: box };
}

const DEBUG_LEFT_CONTROLLER_CUBE_SIZE = 0.075;
const DEBUG_LEFT_CONTROLLER_CUBE_FILL = {
  r: 255,
  g: 48,
  b: 64,
  a: 220,
} as raylib.Color;
const DEBUG_LEFT_CONTROLLER_CUBE_WIRE = {
  r: 255,
  g: 255,
  b: 255,
  a: 255,
} as raylib.Color;

/**
 * Per-eye render target (pixels) for 3D + uikit. The 3560/eye default preserves the high-resolution
 * 7120-square stacked stereo panorama. Use `--webxr-raylib-eye-size=2048` (or another smaller value)
 * to trade sharpness for fill rate and VRAM while profiling or on weaker GPUs.
 */
function getRaylibNativeEyeSize(): number {
  const arg = Deno.args
    .find((a) => a.startsWith("--webxr-raylib-eye-size="))
    ?.split("=", 2)[1]
    ?.trim();
  const n = arg != null ? Number.parseInt(arg, 10) : NaN;
  if (Number.isFinite(n) && n >= 64 && n <= 4096) {
    return n;
  }
  return 3560;
}

function getRaylibNativeEyeSizeCandidates(): number[] {
  const preferred = getRaylibNativeEyeSize();
  const candidates = [preferred, 2048, 1536, 1280, 1024, 768, 512];
  return [
    ...new Set(candidates.filter((v) => v <= preferred || v === preferred)),
  ];
}

/** No MSAA: offscreen compositor + hidden 1×1 context; `RenderTexture2D` paths don't use the window sample buffer anyway. */
const DEFAULT_WINDOW_FLAGS = raylib.ConfigFlags.FLAG_WINDOW_HIDDEN;
const CONTEXT_WINDOW_WIDTH = 1;
const CONTEXT_WINDOW_HEIGHT = 1;

function getDefaultRaylibPath(): string {
  return getRaylibLibraryPath();
}

function toRaylibMatrix(values: Float32Array): raylib.Matrix {
  return {
    m0: values[0] ?? 1,
    m4: values[4] ?? 0,
    m8: values[8] ?? 0,
    m12: values[12] ?? 0,
    m1: values[1] ?? 0,
    m5: values[5] ?? 1,
    m9: values[9] ?? 0,
    m13: values[13] ?? 0,
    m2: values[2] ?? 0,
    m6: values[6] ?? 0,
    m10: values[10] ?? 1,
    m14: values[14] ?? 0,
    m3: values[3] ?? 0,
    m7: values[7] ?? 0,
    m11: values[11] ?? 0,
    m15: values[15] ?? 1,
  };
}

function createRaylibLookRotation(values: Float32Array): raylib.Matrix {
  return {
    m0: -(values[0] ?? 1),
    m4: values[4] ?? 0,
    m8: -(values[8] ?? 0),
    m12: values[12] ?? 0,
    m1: -(values[1] ?? 0),
    m5: values[5] ?? 1,
    m9: -(values[9] ?? 0),
    m13: values[13] ?? 0,
    m2: -(values[2] ?? 0),
    m6: values[6] ?? 0,
    m10: -(values[10] ?? 1),
    m14: values[14] ?? 0,
    m3: -(values[3] ?? 0),
    m7: values[7] ?? 0,
    m11: -(values[11] ?? 0),
    m15: values[15] ?? 1,
  };
}

export class WebXROverlayRaylib {
  private windowInitialized = false;
  private renderWidth = 0;
  private renderHeight = 0;
  private outputEyeWidth = 0;
  private outputEyeHeight = 0;
  private leftEyeTarget: raylib.RenderTexture2D | null = null;
  private rightEyeTarget: raylib.RenderTexture2D | null = null;
  private outputTarget: raylib.RenderTexture2D | null = null;
  private combineShader: raylib.Shader | null = null;
  private sceneRenderer: WebXRRaythreeRaylibRenderer | null = null;
  private lookRotationLocation = -1;
  private halfFovLocation = -1;
  private outputUvScaleLocation = -1;
  private outputUvOffsetLocation = -1;
  private readonly uniqueId = crypto.randomUUID().slice(0, 8);
  private resolvedEyeSize: number | null = null;
  private readonly shaderVec2Buffer = new Float32Array(2);
  private readonly halfFovBuffer = new Float32Array(1);
  private readonly enabledCanaryStages = new Set<RenderCanaryStage>();
  private eyeDiagnosticsRequested = false;
  /** Result of the last {@link requestEyeDiagnostics} sample; read over the agent REPL. */
  lastEyeDiagnostics: unknown = null;

  initialize(name = "WebXR Overlay") {
    if (this.windowInitialized) {
      return;
    }

    raylib.loadRaylib(getDefaultRaylibPath());
    raylib.SetTraceLogLevel(raylib.TraceLogLevel.LOG_WARNING);
    raylib.SetConfigFlags(DEFAULT_WINDOW_FLAGS);
    raylib.H.InitWindow(
      CONTEXT_WINDOW_WIDTH,
      CONTEXT_WINDOW_HEIGHT,
      `${name}_${this.uniqueId}`,
    );
    this.windowInitialized = true;

    this.combineShader = raylib.H.LoadShaderFromMemory(
      null,
      VARGGLES_FRAGMENT_SHADER,
    );
    if (!raylib.H.IsShaderValid(this.combineShader)) {
      throw new Error("raylib varggles shader failed to load");
    }

    this.sceneRenderer = new WebXRRaythreeRaylibRenderer();
    this.lookRotationLocation = raylib.H.GetShaderLocation(
      this.combineShader,
      "lookRotation",
    );
    this.halfFovLocation = raylib.H.GetShaderLocation(
      this.combineShader,
      "halfFOVInRadians",
    );
    this.outputUvScaleLocation = raylib.H.GetShaderLocation(
      this.combineShader,
      "outputUvScale",
    );
    this.outputUvOffsetLocation = raylib.H.GetShaderLocation(
      this.combineShader,
      "outputUvOffset",
    );

    LogChannel.log(
      "webxrv2",
      `[webxr] raylib compositor ready hidden=yes context=${CONTEXT_WINDOW_WIDTH}x${CONTEXT_WINDOW_HEIGHT} eye=${getRaylibNativeEyeSize()}x${getRaylibNativeEyeSize()} max`,
    );
    LogChannel.log(
      "webxrv2",
      `[webxr] raylib combine shader locs lookRotation=${this.lookRotationLocation} halfFov=${this.halfFovLocation} outputUvScale=${this.outputUvScaleLocation} outputUvOffset=${this.outputUvOffsetLocation}`,
    );

    const eye = getRaylibNativeEyeSize();
    this.ensureTexture(eye, eye, eye, eye);
  }

  getTextureHandle(): number {
    if (!this.outputTarget) {
      throw new Error("raylib output texture not initialized");
    }
    return this.outputTarget.texture.id;
  }

  private static isRenderTargetValid(
    target: raylib.RenderTexture2D | null,
  ): boolean {
    return target != null &&
      target.texture.id > 0 &&
      raylib.H.IsRenderTextureValid(target) &&
      raylib.H.IsTextureValid(target.texture);
  }

  /**
   * Every target this compositor draws through, not just the submitted one.
   *
   * An eye FBO can be invalidated on its own (an overlay destroy/recreate around
   * the OpenVR texture import will do it). Draws into a dead FBO still issue and
   * still time normally, so that eye silently renders nothing — which reads as a
   * black eye — until the targets are rebuilt.
   */
  areRenderTargetsValid(): boolean {
    return WebXROverlayRaylib.isRenderTargetValid(this.leftEyeTarget) &&
      WebXROverlayRaylib.isRenderTargetValid(this.rightEyeTarget) &&
      WebXROverlayRaylib.isRenderTargetValid(this.outputTarget);
  }

  isOutputTextureValid(): boolean {
    return WebXROverlayRaylib.isRenderTargetValid(this.outputTarget);
  }

  private setShaderVec2(
    shader: raylib.Shader,
    location: number,
    x: number,
    y: number,
  ) {
    if (location < 0) {
      return;
    }
    this.shaderVec2Buffer[0] = x;
    this.shaderVec2Buffer[1] = y;
    const pointer = Deno.UnsafePointer.of(this.shaderVec2Buffer);
    if (!pointer) {
      throw new Error("Failed to allocate raylib vec2 uniform buffer");
    }
    raylib.H.SetShaderValue(
      shader,
      location,
      pointer,
      raylib.ShaderUniformDataType.SHADER_UNIFORM_VEC2,
    );
  }

  private tryEnsureTexture(
    renderEyeWidth: number,
    renderEyeHeight: number,
    outputEyeWidth: number,
    outputEyeHeight: number,
  ): boolean {
    this.renderWidth = renderEyeWidth;
    this.renderHeight = renderEyeHeight;
    this.outputEyeWidth = outputEyeWidth;
    this.outputEyeHeight = outputEyeHeight;
    this.leftEyeTarget = raylib.H.LoadRenderTexture(
      renderEyeWidth,
      renderEyeHeight,
    );
    this.rightEyeTarget = raylib.H.LoadRenderTexture(
      renderEyeWidth,
      renderEyeHeight,
    );
    this.outputTarget = raylib.H.LoadRenderTexture(
      outputEyeWidth * 2,
      outputEyeHeight * 2,
    );

    // Log the ids this context owns so they can be lined up against the other
    // GL context's [gltrace] create/delete stream.
    console.log(
      `[gltrace] raylib targets left fbo=${
        (this.leftEyeTarget as unknown as { id?: number })?.id
      } tex=${this.leftEyeTarget?.texture.id} | right fbo=${
        (this.rightEyeTarget as unknown as { id?: number })?.id
      } tex=${this.rightEyeTarget?.texture.id} | output fbo=${
        (this.outputTarget as unknown as { id?: number })?.id
      } tex=${this.outputTarget?.texture.id} pid=${Deno.pid}`,
    );
    for (
      const target of [
        this.leftEyeTarget,
        this.rightEyeTarget,
        this.outputTarget,
      ]
    ) {
      if (!target || !raylib.H.IsRenderTextureValid(target)) {
        this.unloadTargets();
        return false;
      }
      raylib.H.SetTextureFilter(
        target.texture,
        raylib.TextureFilter.TEXTURE_FILTER_BILINEAR,
      );
    }
    return true;
  }

  ensureTexture(
    renderEyeWidth: number,
    renderEyeHeight: number,
    outputEyeWidth: number,
    outputEyeHeight: number,
  ) {
    if (
      this.outputTarget !== null &&
      this.renderWidth === renderEyeWidth &&
      this.renderHeight === renderEyeHeight &&
      this.outputEyeWidth === outputEyeWidth &&
      this.outputEyeHeight === outputEyeHeight
    ) {
      // Matching sizes are not enough: the targets must still be live. Skipping
      // this check let an invalidated eye FBO survive here forever, so that eye
      // rendered nothing until the process restarted.
      if (this.areRenderTargetsValid()) {
        return;
      }
      LogChannel.log(
        "webxrv2",
        "[webxr] raylib render targets invalidated; rebuilding eye and output FBOs",
      );
    }

    if (this.outputTarget !== null) {
      this.unloadTargets();
    }

    for (const eye of getRaylibNativeEyeSizeCandidates()) {
      if (this.tryEnsureTexture(eye, eye, eye, eye)) {
        if (this.resolvedEyeSize !== eye) {
          this.resolvedEyeSize = eye;
          LogChannel.log(
            "webxrv2",
            `[webxr] raylib render target eye=${eye}x${eye} output=${eye * 2}x${eye * 2}`,
          );
        }
        return;
      }
    }

    throw new Error(
      `raylib render texture initialization failed renderEye=${renderEyeWidth}x${renderEyeHeight} output=${
        outputEyeWidth * 2
      }x${outputEyeHeight * 2}`,
    );
  }

  /** @returns wall ms breakdown; `left+right+combine` may slightly exceed `total` (timer overhead). */
  renderRaythreeFrame(
    payload: WebXRRaythreeRenderPayload,
  ): {
    totalMs: number;
    leftMs: number;
    rightMs: number;
    combineMs: number;
    renderSyncMs: number;
    renderDrawMs: number;
    batchGeometries: number;
    batchMaterials: number;
    renderLeftSyncMs: number;
    renderLeftPrepMs: number;
    renderLeftOpaqueMs: number;
    renderLeftXparentMs: number;
    renderLeftUiMs: number;
    renderLeftUiSortPrepMs: number;
    renderLeftUiPanelsMs: number;
    renderLeftUiTextMs: number;
    renderLeftEndMs: number;
    renderRightSyncMs: number;
    renderRightPrepMs: number;
    renderRightOpaqueMs: number;
    renderRightXparentMs: number;
    renderRightUiMs: number;
    renderRightUiSortPrepMs: number;
    renderRightUiPanelsMs: number;
    renderRightUiTextMs: number;
    renderRightEndMs: number;
    uiPanelCount: number;
    uiTextCount: number;
    uiPanelDrawn: number;
    uiTextDrawn: number;
  } {
    const eye = this.resolvedEyeSize ?? getRaylibNativeEyeSize();
    const renderT0 = performance.now();
    this.checkGlHealth();
    this.rebuildRenderTargetsIfRequested();
    this.ensureTexture(eye, eye, eye, eye);

    const leftTarget = this.leftEyeTarget;
    const rightTarget = this.rightEyeTarget;
    const outputTarget = this.outputTarget;
    const shader = this.combineShader;
    const sceneRenderer = this.sceneRenderer;
    if (
      !leftTarget || !rightTarget || !outputTarget || !shader || !sceneRenderer
    ) {
      throw new Error("raylib compositor not initialized");
    }

    const skipRightAssetSync = areNativeAssetBatchesIdenticalForSync(
      payload.leftEye.assets,
      payload.rightEye.assets,
    );

    const tLeft0 = performance.now();
    const leftB = this.renderEye(leftTarget, () => {
      const result = sceneRenderer.renderExtraction(
        payload.leftEye,
        payload.background,
        {
          projectionMatrix: payload.frame.leftEyeProjectionMatrix,
          viewMatrix: payload.frame.leftEyeViewMatrix,
        },
        `frame=${payload.frame.frameCount} eye=left`,
        payload.ui,
      );
      this.markCanary("eyePostScene", Math.min(leftTarget.texture.width, leftTarget.texture.height));
      this.drawDebugLeftControllerCube(
        payload.frame,
        payload.frame.leftEyeProjectionMatrix,
        payload.frame.leftEyeViewMatrix,
      );
      return result;
    });
    const leftMs = performance.now() - tLeft0;

    const tRight0 = performance.now();
    const rightB = this.renderEye(rightTarget, () => {
      const result = sceneRenderer.renderExtraction(
        payload.rightEye,
        payload.background,
        {
          projectionMatrix: payload.frame.rightEyeProjectionMatrix,
          viewMatrix: payload.frame.rightEyeViewMatrix,
        },
        `frame=${payload.frame.frameCount} eye=right`,
        payload.ui,
        { skipAssetSync: skipRightAssetSync },
      );
      this.markCanary(
        "eyePostScene",
        Math.min(rightTarget.texture.width, rightTarget.texture.height),
      );
      this.drawDebugLeftControllerCube(
        payload.frame,
        payload.frame.rightEyeProjectionMatrix,
        payload.frame.rightEyeViewMatrix,
      );
      return result;
    });
    const rightMs = performance.now() - tRight0;

    const renderSyncMs = leftB.syncMs + rightB.syncMs;
    const renderDrawMs = leftB.frameMs + rightB.frameMs;
    const batchGeometries = leftB.batchGeometries + rightB.batchGeometries;
    const batchMaterials = leftB.batchMaterials + rightB.batchMaterials;

    const tCombine0 = performance.now();
    raylib.H.SetShaderValueMatrix(
      shader,
      this.lookRotationLocation,
      createRaylibLookRotation(payload.frame.lookRotation),
    );
    this.halfFovBuffer[0] = payload.frame.halfFovInRadians;
    const halfFovPointer = Deno.UnsafePointer.of(this.halfFovBuffer);
    if (!halfFovPointer) {
      throw new Error("Failed to allocate raylib half-FOV uniform buffer");
    }
    raylib.H.SetShaderValue(
      shader,
      this.halfFovLocation,
      halfFovPointer,
      raylib.ShaderUniformDataType.SHADER_UNIFORM_FLOAT,
    );
    raylib.H.BeginTextureMode(outputTarget);
    raylib.H.ClearBackground(TRANSPARENT_BLACK);
    const outputSize = Math.min(outputTarget.texture.width, outputTarget.texture.height);
    // Drawn outside shader mode so the panorama shader cannot rewrite it.
    this.markCanary("outputPostClear", outputSize);
    raylib.H.BeginBlendMode(raylib.BlendMode.BLEND_ALPHA);
    raylib.H.BeginShaderMode(shader);
    this.setShaderVec2(shader, this.outputUvScaleLocation, 1, 0.5);
    this.setShaderVec2(shader, this.outputUvOffsetLocation, 0, 0);
    raylib.H.DrawTexturePro(
      leftTarget.texture,
      {
        x: 0,
        y: 0,
        width: leftTarget.texture.width,
        height: -leftTarget.texture.height,
      },
      {
        x: 0,
        y: 0,
        width: outputTarget.texture.width,
        height: outputTarget.texture.height * 0.5,
      },
      { x: 0, y: 0 },
      0,
      raylib.WHITE,
    );
    raylib.H.EndShaderMode();
    this.markCanary("outputPostLeft", outputSize);
    raylib.H.BeginShaderMode(shader);
    this.setShaderVec2(shader, this.outputUvScaleLocation, 1, 0.5);
    this.setShaderVec2(shader, this.outputUvOffsetLocation, 0, 0.5);
    raylib.H.DrawTexturePro(
      rightTarget.texture,
      {
        x: 0,
        y: 0,
        width: rightTarget.texture.width,
        height: -rightTarget.texture.height,
      },
      {
        x: 0,
        y: outputTarget.texture.height * 0.5,
        width: outputTarget.texture.width,
        height: outputTarget.texture.height * 0.5,
      },
      { x: 0, y: 0 },
      0,
      raylib.WHITE,
    );
    raylib.H.EndShaderMode();
    this.markCanary("outputPostRight", outputSize);
    raylib.H.EndBlendMode();
    raylib.H.EndTextureMode();
    const combineMs = performance.now() - tCombine0;
    this.captureEyeDiagnosticsIfRequested(payload.frame);
    const totalMs = performance.now() - renderT0;
    return {
      totalMs,
      leftMs,
      rightMs,
      combineMs,
      renderSyncMs,
      renderDrawMs,
      batchGeometries,
      batchMaterials,
      renderLeftSyncMs: leftB.syncMs,
      renderLeftPrepMs: leftB.prepMs,
      renderLeftOpaqueMs: leftB.opaqueMs,
      renderLeftXparentMs: leftB.xparentMs,
      renderLeftUiMs: leftB.uiMs,
      renderLeftUiSortPrepMs: leftB.uiSortPrepMs,
      renderLeftUiPanelsMs: leftB.uiPanelsMs,
      renderLeftUiTextMs: leftB.uiTextMs,
      renderLeftEndMs: leftB.endMs,
      renderRightSyncMs: rightB.syncMs,
      renderRightPrepMs: rightB.prepMs,
      renderRightOpaqueMs: rightB.opaqueMs,
      renderRightXparentMs: rightB.xparentMs,
      renderRightUiMs: rightB.uiMs,
      renderRightUiSortPrepMs: rightB.uiSortPrepMs,
      renderRightUiPanelsMs: rightB.uiPanelsMs,
      renderRightUiTextMs: rightB.uiTextMs,
      renderRightEndMs: rightB.endMs,
      uiPanelCount: leftB.uiPanelCount,
      uiTextCount: leftB.uiTextCount,
      uiPanelDrawn: leftB.uiPanelDrawn,
      uiTextDrawn: leftB.uiTextDrawn,
    };
  }

  renderNativeOpenVrDebugFrame(frame: NativeOpenVrRaylibDebugFrame): {
    totalMs: number;
    leftMs: number;
    rightMs: number;
    combineMs: number;
  } {
    const eye = this.resolvedEyeSize ?? getRaylibNativeEyeSize();
    const renderT0 = performance.now();
    this.checkGlHealth();
    this.rebuildRenderTargetsIfRequested();
    this.ensureTexture(eye, eye, eye, eye);

    const leftTarget = this.leftEyeTarget;
    const rightTarget = this.rightEyeTarget;
    const outputTarget = this.outputTarget;
    const shader = this.combineShader;
    if (!leftTarget || !rightTarget || !outputTarget || !shader) {
      throw new Error("raylib compositor not initialized");
    }

    const tLeft0 = performance.now();
    this.renderEye(leftTarget, () =>
      this.drawNativeOpenVrDebugEye(
        frame.leftProjectionMatrix,
        frame.leftViewMatrix,
        frame,
      ));
    const leftMs = performance.now() - tLeft0;

    const tRight0 = performance.now();
    this.renderEye(rightTarget, () =>
      this.drawNativeOpenVrDebugEye(
        frame.rightProjectionMatrix,
        frame.rightViewMatrix,
        frame,
      ));
    const rightMs = performance.now() - tRight0;

    const tCombine0 = performance.now();
    raylib.H.SetShaderValueMatrix(
      shader,
      this.lookRotationLocation,
      createRaylibLookRotation(frame.lookRotation),
    );
    this.halfFovBuffer[0] = frame.halfFovInRadians;
    const halfFovPointer = Deno.UnsafePointer.of(this.halfFovBuffer);
    if (!halfFovPointer) {
      throw new Error("Failed to allocate raylib half-FOV uniform buffer");
    }
    raylib.H.SetShaderValue(
      shader,
      this.halfFovLocation,
      halfFovPointer,
      raylib.ShaderUniformDataType.SHADER_UNIFORM_FLOAT,
    );
    raylib.H.BeginTextureMode(outputTarget);
    raylib.H.ClearBackground(TRANSPARENT_BLACK);
    const outputSize = Math.min(outputTarget.texture.width, outputTarget.texture.height);
    // Drawn outside shader mode so the panorama shader cannot rewrite it.
    this.markCanary("outputPostClear", outputSize);
    raylib.H.BeginBlendMode(raylib.BlendMode.BLEND_ALPHA);
    raylib.H.BeginShaderMode(shader);
    this.setShaderVec2(shader, this.outputUvScaleLocation, 1, 0.5);
    this.setShaderVec2(shader, this.outputUvOffsetLocation, 0, 0);
    raylib.H.DrawTexturePro(
      leftTarget.texture,
      {
        x: 0,
        y: 0,
        width: leftTarget.texture.width,
        height: -leftTarget.texture.height,
      },
      {
        x: 0,
        y: 0,
        width: outputTarget.texture.width,
        height: outputTarget.texture.height * 0.5,
      },
      { x: 0, y: 0 },
      0,
      raylib.WHITE,
    );
    raylib.H.EndShaderMode();
    this.markCanary("outputPostLeft", outputSize);
    raylib.H.BeginShaderMode(shader);
    this.setShaderVec2(shader, this.outputUvScaleLocation, 1, 0.5);
    this.setShaderVec2(shader, this.outputUvOffsetLocation, 0, 0.5);
    raylib.H.DrawTexturePro(
      rightTarget.texture,
      {
        x: 0,
        y: 0,
        width: rightTarget.texture.width,
        height: -rightTarget.texture.height,
      },
      {
        x: 0,
        y: outputTarget.texture.height * 0.5,
        width: outputTarget.texture.width,
        height: outputTarget.texture.height * 0.5,
      },
      { x: 0, y: 0 },
      0,
      raylib.WHITE,
    );
    raylib.H.EndShaderMode();
    raylib.H.EndBlendMode();
    raylib.H.EndTextureMode();
    const combineMs = performance.now() - tCombine0;

    return {
      totalMs: performance.now() - renderT0,
      leftMs,
      rightMs,
      combineMs,
    };
  }

  cleanup() {
    LogChannel.log(
      "webxrv2",
      "[webxr] raylib cleanup: unloading render targets",
    );
    this.unloadTargets();
    LogChannel.log(
      "webxrv2",
      "[webxr] raylib cleanup: disposing scene renderer",
    );
    this.sceneRenderer?.dispose();
    this.sceneRenderer = null;
    LogChannel.log(
      "webxrv2",
      "[webxr] raylib cleanup: unloading combine shader",
    );
    if (this.combineShader) {
      raylib.H.UnloadShader(this.combineShader);
      this.combineShader = null;
    }
    if (this.windowInitialized) {
      LogChannel.log(
        "webxrv2",
        "[webxr] raylib cleanup: closing window/context",
      );
      raylib.CloseWindow();
      this.windowInitialized = false;
    }
    // Keep the DynamicLibrary resource alive until the actor cooperatively
    // closes. Deno then releases it after the worker's JS/module graph is gone;
    // closing it here leaves generated foreign-function wrappers live and can
    // access-violate on the next event-loop turn after a complex render graph.
    LogChannel.log(
      "webxrv2",
      "[webxr] raylib cleanup: native resources complete",
    );
    this.renderWidth = 0;
    this.renderHeight = 0;
    this.outputEyeWidth = 0;
    this.outputEyeHeight = 0;
  }

  private unloadTargets() {
    if (this.leftEyeTarget) {
      raylib.H.UnloadRenderTexture(this.leftEyeTarget);
      this.leftEyeTarget = null;
    }
    if (this.rightEyeTarget) {
      raylib.H.UnloadRenderTexture(this.rightEyeTarget);
      this.rightEyeTarget = null;
    }
    if (this.outputTarget) {
      raylib.H.UnloadRenderTexture(this.outputTarget);
      this.outputTarget = null;
    }
  }

  private renderTargetRebuildRequested = false;
  private glHealthFrameCounter = 0;
  private expectedContextId: string | null = null;
  private selfHealCount = 0;
  private lastGlHealth: unknown = null;
  private selfHealEnabled = true;

  /**
   * Ask the render loop to drop and rebuild the render targets on its next pass.
   *
   * `IsRenderTextureValid` reports a dead eye FBO as valid, so the automatic
   * path in `ensureTexture` cannot see this failure; this is the manual escape
   * hatch. Rebuilding from a REPL call directly would corrupt raylib's batch
   * state, so the work is deferred into the loop.
   */
  requestRenderTargetRebuild(): string {
    this.renderTargetRebuildRequested = true;
    return "rebuild queued";
  }

  private rebuildRenderTargetsIfRequested(): void {
    if (!this.renderTargetRebuildRequested) return;
    this.renderTargetRebuildRequested = false;
    LogChannel.log("webxrv2", "[webxr] rebuilding raylib render targets on request");
    this.unloadTargets();
    const eye = this.resolvedEyeSize ?? getRaylibNativeEyeSize();
    this.ensureTexture(eye, eye, eye, eye);
  }

  /**
   * Ask the driver whether the render targets are still usable, and rebuild them
   * when they are not.
   *
   * A dead eye framebuffer keeps accepting draw calls and keeps reporting valid
   * through raylib, so the only trustworthy signal is the driver's own status.
   * Recreating the targets is a verified repair for that state.
   */
  private static readonly GL_HEALTH_INTERVAL_FRAMES = 60;

  setSelfHealEnabled(enabled: boolean): boolean {
    this.selfHealEnabled = enabled;
    return this.selfHealEnabled;
  }

  getGlHealth() {
    return {
      selfHealEnabled: this.selfHealEnabled,
      selfHealCount: this.selfHealCount,
      lastGlHealth: this.lastGlHealth,
    };
  }

  /** Sample driver-side health; returns true when a rebuild was scheduled. */
  private checkGlHealth(force = false): boolean {
    this.glHealthFrameCounter++;
    if (
      !force &&
      this.glHealthFrameCounter % WebXROverlayRaylib.GL_HEALTH_INTERVAL_FRAMES !== 0
    ) return false;

    const reset = getGraphicsResetStatus();
    // Capture the context this compositor's objects were created in, then watch
    // for it changing underneath us.
    const contextId = getCurrentContextId();
    this.expectedContextId ??= contextId;
    const contextSwapped = contextId != null && this.expectedContextId != null &&
      contextId !== this.expectedContextId;
    const targets: Array<[string, raylib.RenderTexture2D | null]> = [
      ["left", this.leftEyeTarget],
      ["right", this.rightEyeTarget],
      ["output", this.outputTarget],
    ];
    const statuses: Record<string, string> = {};
    let broken: string | null = null;
    for (const [label, target] of targets) {
      if (target == null) continue;
      const id = (target as unknown as { id?: number }).id ?? null;
      const textureId = target.texture.id;
      // The attachment is checked first: a deleted colour texture leaves the
      // framebuffer reporting COMPLETE while silently discarding every draw.
      const textureAlive = isTextureAlive(textureId);
      if (textureAlive === false) {
        broken ??= `${label} colour texture ${textureId} has been deleted`;
        console.log(
          `[gltrace] DETECTED raylib ${label} texture id=${textureId} deleted by someone else pid=${Deno.pid}`,
        );
      }
      if (id == null) continue;
      const status = getFramebufferStatus(id);
      if (status == null) continue;
      statuses[label] = `fbo=${id} tex=${textureId}${
        textureAlive === false ? " TEXTURE-DELETED" : ""
      } ${status.name}`;
      if (!status.complete) broken ??= `${label} framebuffer ${status.name}`;
    }
    const contextReset = reset != null && reset.code !== 0;
    if (contextReset) broken ??= `graphics context reset: ${reset!.name}`;

    if (contextSwapped) {
      broken ??=
        `GL context changed on this thread: expected ${this.expectedContextId}, now ${contextId}`;
      console.log(
        `[gltrace] CONTEXT SWAPPED expected=${this.expectedContextId} now=${contextId} pid=${Deno.pid}`,
      );
    }
    this.lastGlHealth = {
      at: new Date().toISOString(),
      glContext: contextId,
      expectedGlContext: this.expectedContextId,
      contextSwapped,
      graphicsResetStatus: reset?.name ?? "unavailable",
      glError: getGlError()?.name ?? "unavailable",
      framebuffers: statuses,
      healthy: broken == null,
    };
    if (broken == null || !this.selfHealEnabled) return false;

    this.selfHealCount++;
    LogChannel.error(
      "webxrv2",
      `[webxr] GL health check failed (${broken}); rebuilding render targets (self-heal #${this.selfHealCount}) — ${
        JSON.stringify(this.lastGlHealth)
      }`,
    );
    this.renderTargetRebuildRequested = true;
    return true;
  }

  /** Enable/disable canary stages live over the agent REPL. */
  setCanaryStages(stages: readonly string[]): RenderCanaryStage[] {
    this.enabledCanaryStages.clear();
    const known = new Set(RENDER_CANARY_STAGES.map((stage) => stage.id as string));
    for (const stage of stages) {
      if (known.has(stage)) this.enabledCanaryStages.add(stage as RenderCanaryStage);
    }
    return this.getCanaryStages();
  }

  getCanaryStages(): RenderCanaryStage[] {
    return RENDER_CANARY_STAGES
      .map((stage) => stage.id)
      .filter((id) => this.enabledCanaryStages.has(id)) as RenderCanaryStage[];
  }

  /** All stage ids and colours, so a caller knows what to look for. */
  describeCanaryStages() {
    return RENDER_CANARY_STAGES.map((stage, slot) => ({
      id: stage.id,
      slot,
      colour: `${stage.color.r},${stage.color.g},${stage.color.b},${stage.color.a}`,
      enabled: this.enabledCanaryStages.has(stage.id),
    }));
  }

  /**
   * Paint this stage's marker into the currently bound target.
   *
   * Must be called between Begin/EndTextureMode for the target being probed.
   */
  private markCanary(stage: RenderCanaryStage, targetSize: number): void {
    if (!this.enabledCanaryStages.has(stage)) return;
    const slot = RENDER_CANARY_STAGES.findIndex((entry) => entry.id === stage);
    if (slot < 0) return;
    const rect = canarySlotRect(targetSize, slot);
    raylib.H.DrawRectangle(
      rect.x,
      rect.y,
      rect.w,
      rect.h,
      RENDER_CANARY_STAGES[slot]!.color as unknown as raylib.Color,
    );
  }

  /** Read back which canary squares actually survived in `target`. */
  private readCanaries(
    target: raylib.RenderTexture2D | null,
    label: string,
  ): Record<string, unknown> {
    if (target == null) return { label, error: "null target" };
    try {
      const image = raylib.H.LoadImageFromTexture(target.texture);
      const width = image.width;
      const height = image.height;
      const raw = image.data as unknown;
      const pointer = typeof raw === "bigint" ? Deno.UnsafePointer.create(raw) : raw;
      if (pointer == null) return { label, error: "null image data" };
      const view = new Deno.UnsafePointerView(pointer as Deno.PointerObject);
      const size = Math.min(width, height);
      const results: Record<string, string> = {};
      for (let slot = 0; slot < RENDER_CANARY_STAGES.length; slot++) {
        const stage = RENDER_CANARY_STAGES[slot]!;
        const rect = canarySlotRect(size, slot);
        const x = Math.min(width - 1, rect.x + (rect.w >> 1));
        // Row 0 is the bottom in GL storage, so mirror the slot's y to read the
        // same texels the draw wrote.
        const y = Math.min(height - 1, height - 1 - (rect.y + (rect.h >> 1)));
        const offset = (y * width + x) * 4;
        const actual = `${view.getUint8(offset)},${view.getUint8(offset + 1)},${
          view.getUint8(offset + 2)
        },${view.getUint8(offset + 3)}`;
        const expected = `${stage.color.r},${stage.color.g},${stage.color.b},${stage.color.a}`;
        const enabled = this.enabledCanaryStages.has(stage.id);
        results[stage.id] = `${enabled ? "" : "(off) "}got ${actual}${
          enabled ? (actual === expected ? "  SURVIVED" : `  MISSING (want ${expected})`) : ""
        }`;
      }
      raylib.H.UnloadImage(image);
      return { label, width, height, canaries: results };
    } catch (error) {
      return { label, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Drop the render targets so the next `ensureTexture` rebuilds them.
   *
   * Used to recover from a compositor-invalidated FBO instead of shutting the
   * overlay down for the rest of the session.
   */
  invalidateRenderTargets(): void {
    this.unloadTargets();
  }

  /**
   * Ask for a one-shot pixel sample of both eye targets and the combined output.
   *
   * The sample is taken inside the render loop rather than from a REPL call, so
   * it never issues a readback while the GPU is mid-write to the same target —
   * doing that from outside segfaults the process.
   */
  requestEyeDiagnostics(): void {
    this.eyeDiagnosticsRequested = true;
  }

  private sampleRenderTarget(
    target: raylib.RenderTexture2D | null,
    label: string,
  ): Record<string, unknown> {
    if (target == null) return { label, error: "null target" };
    // Capture liveness before the readback: an invalidated FBO still accepts
    // draws and still times normally, so this is the field that separates
    // "rendered nothing" from "rendered into a dead target".
    const validity = {
      textureId: target.texture.id,
      fboId: (target as unknown as { id?: number }).id ?? null,
      renderTextureValid: raylib.H.IsRenderTextureValid(target),
      textureValid: raylib.H.IsTextureValid(target.texture),
      texWidth: target.texture.width,
      texHeight: target.texture.height,
      texFormat: target.texture.format,
      texMipmaps: target.texture.mipmaps,
    };
    try {
      const image = raylib.H.LoadImageFromTexture(target.texture);
      const width = image.width;
      const height = image.height;
      const raw = image.data as unknown;
      const pointer = typeof raw === "bigint" ? Deno.UnsafePointer.create(raw) : raw;
      if (pointer == null) return { label, error: "null image data", width, height };
      const view = new Deno.UnsafePointerView(pointer as Deno.PointerObject);
      const histogram = new Map<string, number>();
      let maxAlpha = 0;
      let opaque = 0;
      let coloured = 0;
      let sampled = 0;
      const step = 29;
      for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
          const offset = (y * width + x) * 4;
          // Bytes are R,G,B,A; getUint32 is little-endian on x86, so read them
          // individually rather than unpacking a word and inverting the channels.
          const r = view.getUint8(offset);
          const g = view.getUint8(offset + 1);
          const b = view.getUint8(offset + 2);
          const a = view.getUint8(offset + 3);
          if (a > maxAlpha) maxAlpha = a;
          if (a === 255) opaque++;
          if (r !== 0 || g !== 0 || b !== 0) coloured++;
          const key = `${r},${g},${b},${a}`;
          histogram.set(key, (histogram.get(key) ?? 0) + 1);
          sampled++;
        }
      }
      raylib.H.UnloadImage(image);
      const top = [...histogram.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([rgba, count]) => `${rgba} = ${((100 * count) / sampled).toFixed(1)}%`);
      return {
        label,
        ...validity,
        width,
        height,
        sampled,
        maxAlpha,
        pctFullyOpaque: +((100 * opaque) / sampled).toFixed(2),
        pctColoured: +((100 * coloured) / sampled).toFixed(2),
        distinctColours: histogram.size,
        topColours: top,
      };
    } catch (error) {
      return {
        label,
        ...validity,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private captureEyeDiagnosticsIfRequested(
    frame?: { lookRotation: Float32Array; halfFovInRadians: number },
  ): void {
    if (!this.eyeDiagnosticsRequested) return;
    this.eyeDiagnosticsRequested = false;
    const look = frame ? Array.from(frame.lookRotation) : null;
    this.lastEyeDiagnostics = {
      at: new Date().toISOString(),
      // A degenerate lookRotation or half-FOV makes the panorama shader sample a
      // single texel, which fills a whole eye with one flat colour.
      uniforms: frame
        ? {
          halfFovInRadians: frame.halfFovInRadians,
          halfFovFinite: Number.isFinite(frame.halfFovInRadians),
          lookRotation: look!.map((v) => +v.toFixed(4)),
          lookRotationAllZero: look!.every((v) => v === 0),
          lookRotationHasNaN: look!.some((v) => !Number.isFinite(v)),
        }
        : null,
      allRenderTargetsValid: this.areRenderTargetsValid(),
      enabledCanaryStages: this.getCanaryStages(),
      left: this.sampleRenderTarget(this.leftEyeTarget, "leftEyeTarget"),
      right: this.sampleRenderTarget(this.rightEyeTarget, "rightEyeTarget"),
      output: this.sampleRenderTarget(this.outputTarget, "outputTarget"),
      canariesLeft: this.readCanaries(this.leftEyeTarget, "leftEyeTarget"),
      canariesRight: this.readCanaries(this.rightEyeTarget, "rightEyeTarget"),
      canariesOutput: this.readCanaries(this.outputTarget, "outputTarget"),
    };
  }

  private renderEye<T>(target: raylib.RenderTexture2D, draw: () => T): T {
    raylib.H.BeginTextureMode(target);
    const eyeSize = Math.min(target.texture.width, target.texture.height);
    this.markCanary("eyePreClear", eyeSize);
    const out = draw();
    this.markCanary("eyePreEnd", eyeSize);
    raylib.H.EndTextureMode();
    return out;
  }

  private drawNativeOpenVrDebugEye(
    projectionMatrix: Float32Array,
    viewMatrix: Float32Array,
    frame: NativeOpenVrRaylibDebugFrame,
  ) {
    raylib.H.ClearBackground(TRANSPARENT_BLACK);
    raylib.H.BeginMode3D({
      position: { x: 0, y: 0, z: 0 },
      target: { x: 0, y: 0, z: -1 },
      up: { x: 0, y: 1, z: 0 },
      fovy: 60,
      projection: raylib.CameraProjection.CAMERA_PERSPECTIVE,
    });
    raylib.H.rlSetMatrixProjection(toRaylibMatrix(projectionMatrix));
    raylib.H.rlSetMatrixModelview(toRaylibMatrix(viewMatrix));
    raylib.H.BeginBlendMode(raylib.BlendMode.BLEND_ALPHA);
    raylib.H.DrawGrid(20, 0.25);
    const h = frame.hmdPosition;
    raylib.H.DrawCubeV(
      {
        x: Number(h[0] ?? 0),
        y: Number(h[1] ?? 0),
        z: Number(h[2] ?? 0) - 0.35,
      },
      { x: 0.05, y: 0.05, z: 0.05 },
      { r: 60, g: 180, b: 255, a: 200 },
    );
    const p = frame.leftControllerPosition;
    if (p) {
      const position = {
        x: Number(p[0] ?? 0),
        y: Number(p[1] ?? 0),
        z: Number(p[2] ?? 0),
      };
      raylib.H.DrawCubeV(
        position,
        {
          x: DEBUG_LEFT_CONTROLLER_CUBE_SIZE,
          y: DEBUG_LEFT_CONTROLLER_CUBE_SIZE,
          z: DEBUG_LEFT_CONTROLLER_CUBE_SIZE,
        },
        DEBUG_LEFT_CONTROLLER_CUBE_FILL,
      );
      raylib.H.DrawCubeWiresV(
        position,
        {
          x: DEBUG_LEFT_CONTROLLER_CUBE_SIZE * 1.08,
          y: DEBUG_LEFT_CONTROLLER_CUBE_SIZE * 1.08,
          z: DEBUG_LEFT_CONTROLLER_CUBE_SIZE * 1.08,
        },
        DEBUG_LEFT_CONTROLLER_CUBE_WIRE,
      );
    }
    raylib.H.EndBlendMode();
    raylib.H.EndMode3D();
  }

  private drawDebugLeftControllerCube(
    frame: WebXRRaythreeRenderPayload["frame"],
    projectionMatrix: Float32Array,
    viewMatrix: Float32Array,
  ) {
    const p = frame.raylibDebugLeftControllerPosition;
    if (!p) {
      return;
    }
    const position = {
      x: Number(p[0] ?? 0),
      y: Number(p[1] ?? 0),
      z: Number(p[2] ?? 0),
    };
    raylib.H.BeginMode3D({
      position: { x: 0, y: 0, z: 0 },
      target: { x: 0, y: 0, z: -1 },
      up: { x: 0, y: 1, z: 0 },
      fovy: 60,
      projection: raylib.CameraProjection.CAMERA_PERSPECTIVE,
    });
    raylib.H.rlSetMatrixProjection(toRaylibMatrix(projectionMatrix));
    raylib.H.rlSetMatrixModelview(toRaylibMatrix(viewMatrix));
    raylib.H.BeginBlendMode(raylib.BlendMode.BLEND_ALPHA);
    raylib.H.DrawCubeV(
      position,
      {
        x: DEBUG_LEFT_CONTROLLER_CUBE_SIZE,
        y: DEBUG_LEFT_CONTROLLER_CUBE_SIZE,
        z: DEBUG_LEFT_CONTROLLER_CUBE_SIZE,
      },
      DEBUG_LEFT_CONTROLLER_CUBE_FILL,
    );
    raylib.H.DrawCubeWiresV(
      position,
      {
        x: DEBUG_LEFT_CONTROLLER_CUBE_SIZE * 1.08,
        y: DEBUG_LEFT_CONTROLLER_CUBE_SIZE * 1.08,
        z: DEBUG_LEFT_CONTROLLER_CUBE_SIZE * 1.08,
      },
      DEBUG_LEFT_CONTROLLER_CUBE_WIRE,
    );
    raylib.H.EndBlendMode();
    raylib.H.EndMode3D();
  }
}
