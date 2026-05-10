import { LogChannel } from "@mommysgoodpuppy/logchannel";
import raylib from "../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import { areNativeAssetBatchesIdenticalForSync } from "./raythreeAssetBatchesForSync.ts";
import type { WebXRRaythreeRenderPayload } from "./webxrRaythreeScene.ts";
import { WebXRRaythreeRaylibRenderer } from "./webxrRaythreeRaylibRenderer.ts";
import { WEBXR_VARGGLES_GLSL330_FRAGMENT } from "./webxrVargglesShader.ts";

const VARGGLES_FRAGMENT_SHADER = WEBXR_VARGGLES_GLSL330_FRAGMENT;
const TRANSPARENT_BLACK = { r: 0, g: 0, b: 0, a: 0 } as raylib.Color;

/**
 * Per-eye render target (pixels) for 3D + uikit. Default is native 2560/eye. UI cost is dominated by
 * per-panel DrawMesh + uniform updates in the Raylib uikit path, not this resolution alone. Use
 * `--webxr-raylib-eye-size=1280` (or another size) to trade overlay sharpness for fill rate while
 * profiling or on weaker GPUs.
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
  return [...new Set(candidates.filter((v) => v <= preferred || v === preferred))];
}

/** No MSAA: offscreen compositor + hidden 1×1 context; `RenderTexture2D` paths don't use the window sample buffer anyway. */
const DEFAULT_WINDOW_FLAGS = raylib.ConfigFlags.FLAG_WINDOW_HIDDEN;
const CONTEXT_WINDOW_WIDTH = 1;
const CONTEXT_WINDOW_HEIGHT = 1;

function getDefaultRaylibPath(): string {
  const url = new URL("../resources/raylib.dll", import.meta.url);
  return Deno.build.os === "windows"
    ? decodeURIComponent(url.pathname.replace(/^\/+/, ""))
    : decodeURIComponent(url.pathname);
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
  return toRaylibMatrix(
    new Float32Array([
      -(values[0] ?? 1),
      -(values[1] ?? 0),
      -(values[2] ?? 0),
      -(values[3] ?? 0),
      values[4] ?? 0,
      values[5] ?? 1,
      values[6] ?? 0,
      values[7] ?? 0,
      -(values[8] ?? 0),
      -(values[9] ?? 0),
      -(values[10] ?? 1),
      -(values[11] ?? 0),
      values[12] ?? 0,
      values[13] ?? 0,
      values[14] ?? 0,
      values[15] ?? 1,
    ]),
  );
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

  initialize(name = "WebXR Overlay") {
    if (this.windowInitialized) {
      return;
    }

    raylib.loadRaylib(getDefaultRaylibPath());
    raylib.SetTraceLogLevel(raylib.TraceLogLevel.LOG_WARNING);
    raylib.SetConfigFlags(DEFAULT_WINDOW_FLAGS);
    raylib.H.InitWindow(CONTEXT_WINDOW_WIDTH, CONTEXT_WINDOW_HEIGHT, `${name}_${this.uniqueId}`);
    this.windowInitialized = true;

    this.combineShader = raylib.H.LoadShaderFromMemory(
      null,
      VARGGLES_FRAGMENT_SHADER,
    );
    if (!raylib.H.IsShaderValid(this.combineShader)) {
      throw new Error("raylib varggles shader failed to load");
    }

    this.sceneRenderer = new WebXRRaythreeRaylibRenderer();
    this.lookRotationLocation = raylib.H.GetShaderLocation(this.combineShader, "lookRotation");
    this.halfFovLocation = raylib.H.GetShaderLocation(this.combineShader, "halfFOVInRadians");
    this.outputUvScaleLocation = raylib.H.GetShaderLocation(this.combineShader, "outputUvScale");
    this.outputUvOffsetLocation = raylib.H.GetShaderLocation(this.combineShader, "outputUvOffset");

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

  private setShaderVec2(shader: raylib.Shader, location: number, x: number, y: number) {
    if (location < 0) {
      return;
    }
    const buffer = new Float32Array([x, y]);
    const pointer = Deno.UnsafePointer.of(buffer);
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
    this.leftEyeTarget = raylib.H.LoadRenderTexture(renderEyeWidth, renderEyeHeight);
    this.rightEyeTarget = raylib.H.LoadRenderTexture(renderEyeWidth, renderEyeHeight);
    this.outputTarget = raylib.H.LoadRenderTexture(outputEyeWidth * 2, outputEyeHeight * 2);

    for (const target of [this.leftEyeTarget, this.rightEyeTarget, this.outputTarget]) {
      if (!target || !raylib.H.IsRenderTextureValid(target)) {
        this.unloadTargets();
        return false;
      }
      raylib.H.SetTextureFilter(target.texture, raylib.TextureFilter.TEXTURE_FILTER_BILINEAR);
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
      return;
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
    this.ensureTexture(eye, eye, eye, eye);

    const leftTarget = this.leftEyeTarget;
    const rightTarget = this.rightEyeTarget;
    const outputTarget = this.outputTarget;
    const shader = this.combineShader;
    const sceneRenderer = this.sceneRenderer;
    if (!leftTarget || !rightTarget || !outputTarget || !shader || !sceneRenderer) {
      throw new Error("raylib compositor not initialized");
    }

    const skipRightAssetSync = areNativeAssetBatchesIdenticalForSync(
      payload.leftEye.assets,
      payload.rightEye.assets,
    );

    const tLeft0 = performance.now();
    const leftB = this.renderEye(leftTarget, () =>
      sceneRenderer.renderExtraction(
        payload.leftEye,
        payload.background,
        {
          projectionMatrix: payload.frame.leftEyeProjectionMatrix,
          viewMatrix: payload.frame.leftEyeViewMatrix,
        },
        `frame=${payload.frame.frameCount} eye=left`,
        payload.ui,
      ));
    const leftMs = performance.now() - tLeft0;

    const tRight0 = performance.now();
    const rightB = this.renderEye(rightTarget, () =>
      sceneRenderer.renderExtraction(
        payload.rightEye,
        payload.background,
        {
          projectionMatrix: payload.frame.rightEyeProjectionMatrix,
          viewMatrix: payload.frame.rightEyeViewMatrix,
        },
        `frame=${payload.frame.frameCount} eye=right`,
        payload.ui,
        { skipAssetSync: skipRightAssetSync },
      ));
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
    const halfFovBuffer = new Float32Array([payload.frame.halfFovInRadians]);
    const halfFovPointer = Deno.UnsafePointer.of(halfFovBuffer);
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

  cleanup() {
    this.unloadTargets();
    this.sceneRenderer?.dispose();
    this.sceneRenderer = null;
    if (this.combineShader) {
      raylib.H.UnloadShader(this.combineShader);
      this.combineShader = null;
    }
    if (this.windowInitialized) {
      raylib.CloseWindow();
      this.windowInitialized = false;
    }
    raylib.unloadRaylib();
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

  private renderEye<T>(target: raylib.RenderTexture2D, draw: () => T): T {
    raylib.H.BeginTextureMode(target);
    const out = draw();
    raylib.H.EndTextureMode();
    return out;
  }
}
