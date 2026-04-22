import { LogChannel } from "@mommysgoodpuppy/logchannel";
import raylib from "../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import type { WebXRRaythreeRenderPayload } from "./webxrRaythreeScene.ts";
import { WebXRRaythreeRaylibRenderer } from "./webxrRaythreeRaylibRenderer.ts";
import { WEBXR_VARGGLES_GLSL330_FRAGMENT } from "./webxrVargglesShader.ts";

const VARGGLES_FRAGMENT_SHADER = WEBXR_VARGGLES_GLSL330_FRAGMENT;
const TRANSPARENT_BLACK = { r: 0, g: 0, b: 0, a: 0 } as raylib.Color;
const RAYLIB_NATIVE_EYE_SIZE = 2560;

const DEFAULT_WINDOW_FLAGS = raylib.ConfigFlags.FLAG_MSAA_4X_HINT |
  raylib.ConfigFlags.FLAG_WINDOW_HIDDEN;
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

  initialize(name = "WebXR Overlay") {
    if (this.windowInitialized) {
      return;
    }

    raylib.loadRaylib(getDefaultRaylibPath());
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
      `[webxr] raylib compositor ready hidden=yes context=${CONTEXT_WINDOW_WIDTH}x${CONTEXT_WINDOW_HEIGHT} eye=${RAYLIB_NATIVE_EYE_SIZE}x${RAYLIB_NATIVE_EYE_SIZE}`,
    );
    LogChannel.log(
      "webxrv2",
      `[webxr] raylib combine shader locs lookRotation=${this.lookRotationLocation} halfFov=${this.halfFovLocation} outputUvScale=${this.outputUvScaleLocation} outputUvOffset=${this.outputUvOffsetLocation}`,
    );
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

    this.renderWidth = renderEyeWidth;
    this.renderHeight = renderEyeHeight;
    this.outputEyeWidth = outputEyeWidth;
    this.outputEyeHeight = outputEyeHeight;
    this.leftEyeTarget = raylib.H.LoadRenderTexture(renderEyeWidth, renderEyeHeight);
    this.rightEyeTarget = raylib.H.LoadRenderTexture(renderEyeWidth, renderEyeHeight);
    this.outputTarget = raylib.H.LoadRenderTexture(outputEyeWidth * 2, outputEyeHeight * 2);

    for (const target of [this.leftEyeTarget, this.rightEyeTarget, this.outputTarget]) {
      if (!target || !raylib.H.IsRenderTextureValid(target)) {
        throw new Error(
          `raylib render texture initialization failed renderEye=${renderEyeWidth}x${renderEyeHeight} output=${
            outputEyeWidth * 2
          }x${outputEyeHeight * 2}`,
        );
      }
      raylib.H.SetTextureFilter(target.texture, raylib.TextureFilter.TEXTURE_FILTER_BILINEAR);
    }
  }

  renderRaythreeFrame(payload: WebXRRaythreeRenderPayload) {
    this.ensureTexture(
      RAYLIB_NATIVE_EYE_SIZE,
      RAYLIB_NATIVE_EYE_SIZE,
      RAYLIB_NATIVE_EYE_SIZE,
      RAYLIB_NATIVE_EYE_SIZE,
    );

    const leftTarget = this.leftEyeTarget;
    const rightTarget = this.rightEyeTarget;
    const outputTarget = this.outputTarget;
    const shader = this.combineShader;
    const sceneRenderer = this.sceneRenderer;
    if (!leftTarget || !rightTarget || !outputTarget || !shader || !sceneRenderer) {
      throw new Error("raylib compositor not initialized");
    }

    this.renderEye(leftTarget, () => {
      sceneRenderer.renderExtraction(
        payload.leftEye,
        payload.background,
        {
          projectionMatrix: payload.frame.leftEyeProjectionMatrix,
          viewMatrix: payload.frame.leftEyeViewMatrix,
        },
        `frame=${payload.frame.frameCount} eye=left`,
        payload.ui,
      );
    });
    this.renderEye(rightTarget, () => {
      sceneRenderer.renderExtraction(
        payload.rightEye,
        payload.background,
        {
          projectionMatrix: payload.frame.rightEyeProjectionMatrix,
          viewMatrix: payload.frame.rightEyeViewMatrix,
        },
        `frame=${payload.frame.frameCount} eye=right`,
        payload.ui,
      );
    });

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

  private renderEye(target: raylib.RenderTexture2D, draw: () => void) {
    raylib.H.BeginTextureMode(target);
    draw();
    raylib.H.EndTextureMode();
  }
}
