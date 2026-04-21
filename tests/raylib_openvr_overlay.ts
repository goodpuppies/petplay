import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { stringToPointer } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import raylib from "../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import { OpenVrOverlayTexture } from "../classes/openVrOverlayTexture.ts";

type OverlayMode = "quad" | "stereo-panorama";

type Config = {
  hidden: boolean;
  width: number;
  height: number;
  perEye: number | null;
  mode: OverlayMode;
  shaderEnabled: boolean;
  durationSeconds: number;
  spawnWorker: boolean;
  overlayKey: string;
  overlayName: string;
  overlayWidthInMeters: number;
  overlayDistance: number;
};

const POSTPROCESS_FRAGMENT_SHADER = `#version 330
in vec2 fragTexCoord;
in vec4 fragColor;
uniform sampler2D texture0;
uniform float uTime;
out vec4 finalColor;

void main() {
    vec2 uv = fragTexCoord;
    vec2 centered = uv - vec2(0.5, 0.5);
    float wave = sin((uv.y * 18.0) + (uTime * 2.5)) * 0.015;
    vec2 warpedUv = vec2(uv.x + wave, uv.y);
    vec4 color = texture(texture0, warpedUv) * fragColor;
    float vignette = smoothstep(0.95, 0.15, length(centered));
    color.rgb *= mix(0.82, 1.18, vignette);
    color.rgb += vec3(0.04 * sin(uTime * 0.9), 0.02 * cos(uTime * 1.4), 0.05 * sin(uTime * 0.6));
    finalColor = vec4(color.rgb, color.a);
}
`;

export function parseArgs(args: string[] = Deno.args): Config {
  const hidden = args.includes("--hidden");
  const widthArg = args.find((arg) => arg.startsWith("--width="));
  const heightArg = args.find((arg) => arg.startsWith("--height="));
  const perEyeArg = args.find((arg) => arg.startsWith("--per-eye="));
  const modeArg = args.find((arg) => arg.startsWith("--mode="));
  const shaderArg = args.find((arg) => arg.startsWith("--shader="));
  const durationArg = args.find((arg) => arg.startsWith("--duration="));
  const spawnWorker = args.includes("--spawn-worker");

  const mode = (modeArg?.split("=", 2)[1] ?? "quad") as OverlayMode;
  const perEye = perEyeArg
    ? Number.parseInt(perEyeArg.split("=", 2)[1], 10)
    : null;
  const width = perEye && mode === "stereo-panorama"
    ? perEye
    : Number.parseInt(widthArg?.split("=", 2)[1] ?? "2048", 10);
  const height = perEye && mode === "stereo-panorama"
    ? perEye * 2
    : Number.parseInt(heightArg?.split("=", 2)[1] ?? "2048", 10);
  const shaderEnabled = (shaderArg?.split("=", 2)[1] ?? "on") !== "off";
  const durationSeconds = Number.parseInt(durationArg?.split("=", 2)[1] ?? "10", 10);

  if (!Number.isFinite(width) || width <= 0) {
    throw new Error(`Invalid --width value: ${widthArg}`);
  }
  if (!Number.isFinite(height) || height <= 0) {
    throw new Error(`Invalid --height value: ${heightArg}`);
  }
  if (perEye !== null && (!Number.isFinite(perEye) || perEye <= 0)) {
    throw new Error(`Invalid --per-eye value: ${perEyeArg}`);
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Invalid --duration value: ${durationArg}`);
  }
  if (mode !== "quad" && mode !== "stereo-panorama") {
    throw new Error(`Invalid --mode value: ${mode}`);
  }

  return {
    hidden,
    width,
    height,
    perEye,
    mode,
    shaderEnabled,
    durationSeconds,
    spawnWorker,
    overlayKey: `petplay.test.raylib.${mode}`,
    overlayName: `PetPlay Raylib ${mode}`,
    overlayWidthInMeters: mode === "stereo-panorama" ? 3 : 1.4,
    overlayDistance: 1,
  };
}

function buildWorkerArgs(config: Config): string[] {
  const args = [
    `--mode=${config.mode}`,
    `--width=${config.width}`,
    `--height=${config.height}`,
    `--shader=${config.shaderEnabled ? "on" : "off"}`,
    `--duration=${config.durationSeconds}`,
  ];

  if (config.hidden) {
    args.push("--hidden");
  }
  if (config.perEye !== null) {
    args.push(`--per-eye=${config.perEye}`);
  }

  return args;
}

async function runWorkerHarness(config: Config) {
  const worker = new Worker(new URL("./raylib_openvr_overlay_worker.ts", import.meta.url).href, {
    type: "module",
    deno: { permissions: "inherit" },
  });

  const workerArgs = buildWorkerArgs({ ...config, spawnWorker: false });
  worker.postMessage({ type: "start", args: workerArgs });

  await new Promise<void>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as { type: string; message?: string; error?: string };
      if (data.type === "log" && data.message) {
        console.log(`[worker-probe] ${data.message}`);
        return;
      }
      if (data.type === "done") {
        console.log("[worker-probe] completed");
        worker.terminate();
        resolve();
        return;
      }
      if (data.type === "error") {
        worker.terminate();
        reject(new Error(data.error ?? "Unknown worker error"));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
  });
}

function resolveDll(path: string): string {
  const url = new URL(path, import.meta.url);
  return Deno.build.os === "windows"
    ? decodeURIComponent(url.pathname.replace(/^\/+/, ""))
    : decodeURIComponent(url.pathname);
}

function initializeOpenVrOverlayPointer(): number {
  const openVrDll = "../resources/openvr_api.dll";
  const initialized = OpenVR.initializeOpenVR(openVrDll, import.meta.url);
  if (!initialized) {
    throw new Error(`Failed to load OpenVR DLL from ${openVrDll}`);
  }

  const initErrorPtr = P.Int32P<OpenVR.InitError>();
  OpenVR.VR_InitInternal(initErrorPtr, OpenVR.ApplicationType.VRApplication_Overlay);
  const initError = new Deno.UnsafePointerView(initErrorPtr).getInt32() as OpenVR.InitError;
  if (initError !== OpenVR.InitError.VRInitError_None) {
    throw new Error(`VR_InitInternal failed: ${OpenVR.InitError[initError]}`);
  }

  const overlayPtr = OpenVR.VR_GetGenericInterface(
    stringToPointer(OpenVR.IVROverlay_Version),
    initErrorPtr,
  );
  const interfaceError = new Deno.UnsafePointerView(initErrorPtr).getInt32() as OpenVR.InitError;
  if (interfaceError !== OpenVR.InitError.VRInitError_None || !overlayPtr) {
    throw new Error(
      `VR_GetGenericInterface(IVROverlay) failed: ${OpenVR.InitError[interfaceError]}`,
    );
  }

  const overlayPointerNumeric = Deno.UnsafePointer.value(overlayPtr);
  if (overlayPointerNumeric === 0) {
    throw new Error("IVROverlay pointer resolved to 0");
  }

  return Number(overlayPointerNumeric);
}

function drawQuadProbeSurface(target: raylib.RenderTexture2D, elapsed: number) {
  raylib.H.BeginTextureMode(target);
  raylib.H.ClearBackground({ r: 12, g: 18, b: 28, a: 255 });
  raylib.H.DrawText("raylib -> openvr", 48, 48, 52, raylib.RAYWHITE);
  raylib.H.DrawText(`texture ${target.texture.width}x${target.texture.height}`, 48, 112, 32, raylib.SKYBLUE);
  raylib.H.DrawRectangleRounded(
    { x: 72, y: 190, width: 620, height: 220 },
    0.12,
    16,
    { r: 243, g: 156, b: 18, a: 255 },
  );
  raylib.H.DrawRectangleRoundedLinesEx(
    { x: 72, y: 190, width: 620, height: 220 },
    0.12,
    16,
    6,
    raylib.WHITE,
  );
  raylib.H.DrawCircle(
    Math.round(920 + Math.sin(elapsed * 1.6) * 120),
    330,
    120,
    { r: 0, g: 201, b: 255, a: 255 },
  );
  raylib.H.DrawText(`t=${elapsed.toFixed(2)}s`, 96, 270, 44, raylib.BLACK);
  raylib.H.EndTextureMode();
}

function drawStereoPanoramaProbeSurface(target: raylib.RenderTexture2D, elapsed: number) {
  const halfHeight = Math.round(target.texture.height / 2);

  raylib.H.BeginTextureMode(target);
  raylib.H.ClearBackground(raylib.BLACK);

  raylib.H.DrawRectangle(0, 0, target.texture.width, halfHeight, { r: 30, g: 20, b: 10, a: 255 });
  raylib.H.DrawText("LEFT / TOP", 64, 48, 64, { r: 255, g: 182, b: 72, a: 255 });
  raylib.H.DrawCircle(
    Math.round(320 + Math.sin(elapsed * 1.8) * 180),
    Math.round(halfHeight * 0.55),
    110,
    { r: 255, g: 127, b: 39, a: 255 },
  );

  raylib.H.DrawRectangle(0, halfHeight, target.texture.width, halfHeight, { r: 8, g: 26, b: 34, a: 255 });
  raylib.H.DrawText("RIGHT / BOTTOM", 64, halfHeight + 48, 64, { r: 120, g: 240, b: 255, a: 255 });
  raylib.H.DrawCircle(
    Math.round(640 + Math.cos(elapsed * 1.4) * 220),
    Math.round(halfHeight + halfHeight * 0.58),
    110,
    { r: 0, g: 210, b: 255, a: 255 },
  );

  raylib.H.EndTextureMode();
}

function drawPreview(target: raylib.RenderTexture2D, config: Config) {
  const fps = raylib.GetFPS();
  const frameTimeMs = raylib.GetFrameTime() * 1000;
  raylib.BeginDrawing();
  raylib.H.ClearBackground({ r: 5, g: 8, b: 12, a: 255 });
  raylib.H.DrawText(`Mode: ${config.mode}`, 32, 24, 32, raylib.RAYWHITE);
  raylib.H.DrawText(`Shader: ${config.shaderEnabled ? "on" : "off"}`, 240, 24, 32, raylib.RAYWHITE);
  raylib.H.DrawText(`FPS: ${fps}  Frame: ${frameTimeMs.toFixed(2)} ms`, 430, 24, 32, raylib.RAYWHITE);
  raylib.H.DrawText(
    `Texture ID: ${target.texture.id}  Size: ${target.texture.width}x${target.texture.height}`,
    32,
    64,
    24,
    raylib.SKYBLUE,
  );
  raylib.H.DrawText(
    config.hidden
      ? "Hidden mode requested; if this window exists, GLFW ignored hidden."
      : "Visible probe window. Pass --hidden to test hidden-context behavior.",
    32,
    96,
    20,
    raylib.GRAY,
  );
  raylib.H.DrawText(
    config.perEye && config.mode === "stereo-panorama"
      ? `Per-eye: ${config.perEye}x${config.perEye} -> packed texture ${config.width}x${config.height}`
      : `Configured texture ${config.width}x${config.height}`,
    32,
    120,
    20,
    raylib.GRAY,
  );
  raylib.H.DrawTexturePro(
    target.texture,
    {
      x: 0,
      y: 0,
      width: target.texture.width,
      height: -target.texture.height,
    },
    {
      x: 32,
      y: 164,
      width: 960,
      height: 960,
    },
    { x: 0, y: 0 },
    0,
    raylib.WHITE,
  );
  raylib.EndDrawing();
}

function applyPostProcessShader(
  sourceTarget: raylib.RenderTexture2D,
  outputTarget: raylib.RenderTexture2D,
  shader: raylib.Shader | null,
  timeLocation: number,
  elapsed: number,
) {
  raylib.H.BeginTextureMode(outputTarget);
  raylib.H.ClearBackground(raylib.BLACK);

  if (shader) {
    const timeBuffer = new Float32Array([elapsed]);
    const timePointer = Deno.UnsafePointer.of(timeBuffer);
    if (!timePointer) {
      throw new Error("Failed to allocate shader uniform buffer");
    }
    raylib.H.SetShaderValue(
      shader,
      timeLocation,
      timePointer,
      raylib.ShaderUniformDataType.SHADER_UNIFORM_FLOAT,
    );
    raylib.H.BeginShaderMode(shader);
  }

  raylib.H.DrawTexturePro(
    sourceTarget.texture,
    {
      x: 0,
      y: 0,
      width: sourceTarget.texture.width,
      height: -sourceTarget.texture.height,
    },
    {
      x: 0,
      y: 0,
      width: outputTarget.texture.width,
      height: outputTarget.texture.height,
    },
    { x: 0, y: 0 },
    0,
    raylib.WHITE,
  );

  if (shader) {
    raylib.H.EndShaderMode();
  }

  raylib.H.EndTextureMode();
}

export function runProbe(config: Config) {
  const overlayPointer = initializeOpenVrOverlayPointer();
  const raylibDll = resolveDll("../resources/raylib.dll");
  raylib.loadRaylib(raylibDll);

  if (config.hidden) {
    raylib.SetConfigFlags(raylib.ConfigFlags.FLAG_WINDOW_HIDDEN);
  }

  let sourceTarget: raylib.RenderTexture2D | null = null;
  let overlayTarget: raylib.RenderTexture2D | null = null;
  let overlay: OpenVrOverlayTexture | null = null;
  let postProcessShader: raylib.Shader | null = null;
  let timeLocation = -1;
  let lastPerfLogAt = 0;
  const startedAt = performance.now();

  try {
    raylib.H.InitWindow(1024, 1120, config.overlayName);
    raylib.SetTargetFPS(90);

    sourceTarget = raylib.H.LoadRenderTexture(config.width, config.height);
    overlayTarget = raylib.H.LoadRenderTexture(config.width, config.height);
    if (!raylib.H.IsRenderTextureValid(sourceTarget)) {
      throw new Error(
        `LoadRenderTexture(source) failed for ${config.width}x${config.height} hidden=${config.hidden}`,
      );
    }
    if (!raylib.H.IsRenderTextureValid(overlayTarget)) {
      throw new Error(
        `LoadRenderTexture(output) failed for ${config.width}x${config.height} hidden=${config.hidden}`,
      );
    }

    if (config.shaderEnabled) {
      postProcessShader = raylib.H.LoadShaderFromMemory(null, POSTPROCESS_FRAGMENT_SHADER);
      if (!raylib.H.IsShaderValid(postProcessShader)) {
        throw new Error("LoadShaderFromMemory(postprocess) failed");
      }
      timeLocation = raylib.H.GetShaderLocation(postProcessShader, "uTime");
    }

    console.log(
      `[probe] render textures ok src=${sourceTarget.texture.id}/${sourceTarget.id} ` +
        `dst=${overlayTarget.texture.id}/${overlayTarget.id} ` +
        `size=${sourceTarget.texture.width}x${sourceTarget.texture.height} hidden=${config.hidden} ` +
        `mode=${config.mode}${config.perEye ? ` perEye=${config.perEye}` : ""}`,
    );
    if (postProcessShader) {
      console.log(`[probe] shader initialized id=${postProcessShader.id} uTime=${timeLocation}`);
    }

    overlay = new OpenVrOverlayTexture(overlayPointer);
    overlay.initialize(overlayTarget.texture.id, {
      key: config.overlayKey,
      name: config.overlayName,
      widthInMeters: config.overlayWidthInMeters,
      distance: config.overlayDistance,
      mode: config.mode,
      attachToHmd: true,
      flipVertical: false,
    });

    console.log(`[probe] overlay initialized mode=${config.mode}`);

    while (!raylib.WindowShouldClose()) {
      const elapsed = raylib.GetTime();
      if ((performance.now() - startedAt) / 1000 >= config.durationSeconds) {
        break;
      }
      if (config.mode === "stereo-panorama") {
        drawStereoPanoramaProbeSurface(sourceTarget, elapsed);
      } else {
        drawQuadProbeSurface(sourceTarget, elapsed);
      }
      applyPostProcessShader(sourceTarget, overlayTarget, postProcessShader, timeLocation, elapsed);
      overlay.present();
      const now = performance.now();
      if (now - lastPerfLogAt >= 1000) {
        lastPerfLogAt = now;
        console.log(
          `[probe] fps=${raylib.GetFPS()} frameMs=${(raylib.GetFrameTime() * 1000).toFixed(2)} ` +
            `tex=${config.width}x${config.height} shader=${config.shaderEnabled ? "on" : "off"}`,
        );
      }
      drawPreview(overlayTarget, config);
    }
  } finally {
    overlay?.cleanup();
    if (postProcessShader) {
      raylib.H.UnloadShader(postProcessShader);
    }
    if (sourceTarget) {
      raylib.H.UnloadRenderTexture(sourceTarget);
    }
    if (overlayTarget) {
      raylib.H.UnloadRenderTexture(overlayTarget);
    }
    if (raylib.IsWindowReady()) {
      raylib.CloseWindow();
    }
    raylib.unloadRaylib();
    try {
      OpenVR.VR_ShutdownInternal();
    } catch {
      // ignore shutdown races
    }
  }
}

if (import.meta.main) {
  const config = parseArgs();
  if (config.spawnWorker) {
    await runWorkerHarness(config);
  } else {
    runProbe(config);
  }
}
