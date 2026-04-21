import { LogChannel } from "@mommysgoodpuppy/logchannel";
import raylib from "../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import type { WebXRShadowFrame } from "./webxrhost.ts";
import { WEBXR_VARGGLES_GLSL330_FRAGMENT } from "./webxrVargglesShader.ts";
import { getWebXRShadowSceneSnapshot } from "./webxrShadowScene.ts";

const VARGGLES_FRAGMENT_SHADER = WEBXR_VARGGLES_GLSL330_FRAGMENT;
const TRANSPARENT_BLACK = { r: 0, g: 0, b: 0, a: 0 } as raylib.Color;
const RAYLIB_NATIVE_EYE_SIZE = 2560;

const DEFAULT_WINDOW_FLAGS =
  raylib.ConfigFlags.FLAG_MSAA_4X_HINT |
  raylib.ConfigFlags.FLAG_WINDOW_HIDDEN;
const CONTEXT_WINDOW_WIDTH = 1;
const CONTEXT_WINDOW_HEIGHT = 1;

function getDefaultRaylibPath(): string {
  const url = new URL("../resources/raylib.dll", import.meta.url);
  return Deno.build.os === "windows"
    ? decodeURIComponent(url.pathname.replace(/^\/+/, ""))
    : decodeURIComponent(url.pathname);
}

function toRaylibColor(
  color: [number, number, number, number],
): raylib.Color {
  return { r: color[0], g: color[1], b: color[2], a: color[3] };
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

function createIdentityRaylibMatrix(): raylib.Matrix {
  return {
    m0: 1,
    m4: 0,
    m8: 0,
    m12: 0,
    m1: 0,
    m5: 1,
    m9: 0,
    m13: 0,
    m2: 0,
    m6: 0,
    m10: 1,
    m14: 0,
    m3: 0,
    m7: 0,
    m11: 0,
    m15: 1,
  };
}

function pointerValueOf(buffer: BufferSource): NonNullable<Deno.PointerValue> {
  const pointer = Deno.UnsafePointer.of(buffer);
  if (!pointer) {
    throw new Error("Failed to allocate native buffer pointer");
  }
  const value = Deno.UnsafePointer.value(pointer);
  if (value === null) {
    throw new Error("Failed to read native buffer pointer value");
  }
  return value;
}

const DEFAULT_RAYLIB_CAMERA: raylib.Camera3D = {
  position: { x: 0, y: 0, z: 0 },
  target: { x: 0, y: 0, z: -1 },
  up: { x: 0, y: 1, z: 0 },
  fovy: 60,
  projection: raylib.CameraProjection.CAMERA_PERSPECTIVE,
};

export class WebXROverlayRaylib {
  private windowInitialized = false;
  private renderWidth = 0;
  private renderHeight = 0;
  private leftEyeTarget: raylib.RenderTexture2D | null = null;
  private rightEyeTarget: raylib.RenderTexture2D | null = null;
  private outputTarget: raylib.RenderTexture2D | null = null;
  private combineShader: raylib.Shader | null = null;
  private torusModel: raylib.Model | null = null;
  private cubeModel: raylib.Model | null = null;
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

    this.lookRotationLocation = raylib.H.GetShaderLocation(this.combineShader, "lookRotation");
    this.halfFovLocation = raylib.H.GetShaderLocation(this.combineShader, "halfFOVInRadians");
    this.outputUvScaleLocation = raylib.H.GetShaderLocation(this.combineShader, "outputUvScale");
    this.outputUvOffsetLocation = raylib.H.GetShaderLocation(this.combineShader, "outputUvOffset");

    this.torusModel = raylib.H.LoadModelFromMesh(raylib.H.GenMeshTorus(0.12, 0.012, 16, 48));
    this.cubeModel = raylib.H.LoadModelFromMesh(raylib.H.GenMeshCube(1, 1, 1));

    LogChannel.log(
      "webxrv2",
      `[webxr] raylib compositor ready hidden=yes context=${CONTEXT_WINDOW_WIDTH}x${CONTEXT_WINDOW_HEIGHT} eye=${RAYLIB_NATIVE_EYE_SIZE}x${RAYLIB_NATIVE_EYE_SIZE}`,
    );
    LogChannel.log(
      "webxrv2",
      `[webxr] raylib combine shader locs lookRotation=${this.lookRotationLocation} halfFov=${this.halfFovLocation} outputUvScale=${this.outputUvScaleLocation} outputUvOffset=${this.outputUvOffsetLocation}`,
    );
  }

  hasTexture(): boolean {
    return this.outputTarget !== null;
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

  ensureTexture(eyeWidth: number, eyeHeight: number) {
    if (
      this.outputTarget !== null &&
      this.renderWidth === eyeWidth &&
      this.renderHeight === eyeHeight
    ) {
      return;
    }

    if (this.outputTarget !== null) {
      this.unloadTargets();
    }

    this.renderWidth = eyeWidth;
    this.renderHeight = eyeHeight;
    this.leftEyeTarget = raylib.H.LoadRenderTexture(eyeWidth, eyeHeight);
    this.rightEyeTarget = raylib.H.LoadRenderTexture(eyeWidth, eyeHeight);
    this.outputTarget = raylib.H.LoadRenderTexture(eyeWidth * 2, eyeHeight * 2);

    for (const target of [this.leftEyeTarget, this.rightEyeTarget, this.outputTarget]) {
      if (!target || !raylib.H.IsRenderTextureValid(target)) {
        throw new Error(
          `raylib render texture initialization failed eye=${eyeWidth}x${eyeHeight} output=${
            eyeWidth * 2
          }x${eyeHeight * 2}`,
        );
      }
      raylib.H.SetTextureFilter(target.texture, raylib.TextureFilter.TEXTURE_FILTER_BILINEAR);
    }
  }

  renderShadowFrame(frame: WebXRShadowFrame) {
    this.ensureTexture(RAYLIB_NATIVE_EYE_SIZE, RAYLIB_NATIVE_EYE_SIZE);

    const leftTarget = this.leftEyeTarget;
    const rightTarget = this.rightEyeTarget;
    const outputTarget = this.outputTarget;
    const shader = this.combineShader;
    if (!leftTarget || !rightTarget || !outputTarget || !shader) {
      throw new Error("raylib compositor not initialized");
    }

    this.renderEye(
      leftTarget,
      frame.leftEyeProjectionMatrix,
      frame.leftEyeViewMatrix,
    );
    this.renderEye(
      rightTarget,
      frame.rightEyeProjectionMatrix,
      frame.rightEyeViewMatrix,
    );

    raylib.H.SetShaderValueMatrix(
      shader,
      this.lookRotationLocation,
      toRaylibMatrix(frame.lookRotation),
    );
    const halfFovBuffer = new Float32Array([frame.halfFovInRadians]);
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

  getTextureSize() {
    return {
      width: this.outputTarget?.texture.width ?? 0,
      height: this.outputTarget?.texture.height ?? 0,
    };
  }

  describeTexture() {
    return {
      handle: this.outputTarget?.texture.id ?? 0,
      isTexture: Boolean(this.outputTarget),
      width: this.outputTarget?.texture.width ?? 0,
      height: this.outputTarget?.texture.height ?? 0,
      internalFormat: this.outputTarget?.texture.format ?? 0,
      glError: 0,
      glErrorLabel: "raylib",
    };
  }

  cleanup() {
    this.unloadTargets();

    if (this.torusModel) {
      raylib.H.UnloadModel(this.torusModel);
      this.torusModel = null;
    }
    if (this.cubeModel) {
      raylib.H.UnloadModel(this.cubeModel);
      this.cubeModel = null;
    }
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

  private renderEye(
    target: raylib.RenderTexture2D,
    projectionMatrix: Float32Array,
    viewMatrix: Float32Array,
  ) {
    const scene = getWebXRShadowSceneSnapshot();
    raylib.H.BeginTextureMode(target);
    raylib.H.ClearBackground(toRaylibColor(scene.background));
    raylib.H.BeginBlendMode(raylib.BlendMode.BLEND_ALPHA);
    raylib.H.BeginMode3D(DEFAULT_RAYLIB_CAMERA);
    raylib.H.rlSetMatrixProjection(toRaylibMatrix(projectionMatrix));
    raylib.H.rlSetMatrixModelview(toRaylibMatrix(viewMatrix));
    raylib.H.DrawPlane(
      { x: 0, y: 0, z: 0 },
      { x: 16, y: 16 },
      toRaylibColor(scene.floorColor),
    );
    raylib.H.DrawGrid(16, 1);

    for (const mesh of scene.meshes) {
      const position = {
        x: mesh.position[0],
        y: mesh.position[1],
        z: mesh.position[2],
      };
      const scale = {
        x: mesh.scale[0],
        y: mesh.scale[1],
        z: mesh.scale[2],
      };
      const tint = toRaylibColor(mesh.color);
      const wireTint = toRaylibColor(mesh.wireColor ?? mesh.color);

      if (mesh.kind === "torus" && this.torusModel) {
        raylib.H.DrawModelEx(
          this.torusModel,
          position,
          { x: 0, y: 1, z: 0 },
          mesh.rotation[1] * (180 / Math.PI),
          scale,
          tint,
        );
        raylib.H.DrawModelWiresEx(
          this.torusModel,
          position,
          { x: 0, y: 1, z: 0 },
          mesh.rotation[1] * (180 / Math.PI),
          scale,
          wireTint,
        );
        continue;
      }

      if (mesh.kind === "cube" && this.cubeModel) {
        raylib.H.DrawModelEx(
          this.cubeModel,
          position,
          { x: 0, y: 1, z: 0 },
          mesh.rotation[1] * (180 / Math.PI),
          scale,
          tint,
        );
        raylib.H.DrawModelWiresEx(
          this.cubeModel,
          position,
          { x: 0, y: 1, z: 0 },
          mesh.rotation[1] * (180 / Math.PI),
          scale,
          wireTint,
        );
      }
    }

    raylib.H.DrawSphere(
      { x: 0, y: 1.9, z: -1.25 },
      0.08,
      { r: 255, g: 179, b: 71, a: 255 },
    );
    raylib.H.EndMode3D();
    raylib.H.EndBlendMode();
    raylib.H.EndTextureMode();
  }
}
