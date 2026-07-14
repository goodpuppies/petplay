#!/usr/bin/env -S deno run -A --no-check

/**
 * Minimal Raylib -> OpenVR overlay submit probe.
 *
 * Deliberately excludes Stageforge, React, R3F, WebXR, Raythree, and capture.
 * It draws one animated rectangle into a Raylib RenderTexture2D, submits that
 * stable OpenGL texture once per SteamVR vsync, and reports timing percentiles.
 */

import raylib from "../../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import * as OpenVR from "../../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { createStruct, stringToPointer } from "../../submodules/OpenVR_TS_Bindings_Deno/utils.ts";

type TimingSummary = {
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  over5Ms: number;
  over10Ms: number;
  over25Ms: number;
  over50Ms: number;
  over100Ms: number;
};

const sizes = getSizesArg();
const durationMs = getNumberArg("--duration-ms", 8_000);
const warmupMs = Math.min(getNumberArg("--warmup-ms", 1_500), durationMs * 0.5);
const yieldMs = getNumberArg("--poll-yield-ms", 0);
const stereoPanorama = getBooleanArg("--stereo-panorama");
const finishBeforeSubmit = getBooleanArg("--gl-finish");
const nativeTiming = getBooleanArg("--native-timing");
const textureCount = Math.max(1, Math.min(4, Math.floor(getNumberArg("--texture-count", 1))));
const overlayKey = `petplay.probe.raylib-openvr.${crypto.randomUUID()}`;

let overlay: OpenVR.IVROverlay | null = null;
let overlayHandle = 0n;
let raylibWindowOpen = false;
let openGl:
  | Deno.DynamicLibrary<{
    glFinish: { parameters: []; result: "void" };
  }>
  | null = null;
let nativeTimer:
  | Deno.DynamicLibrary<{
    time_set_overlay_texture: {
      parameters: ["pointer", "u64", "pointer", "pointer"];
      result: "i32";
    };
  }>
  | null = null;
let setOverlayTexturePointer: Deno.PointerObject<unknown> | null = null;

if (!OpenVR.initializeOpenVR("../../resources/openvr_api.dll", import.meta.url)) {
  throw new Error("failed to load openvr_api.dll");
}

const initErrorBuffer = new Int32Array(1);
const initErrorPointer = Deno.UnsafePointer.of(initErrorBuffer) as OpenVR.InitErrorPTRType;
OpenVR.VR_InitInternal(initErrorPointer, OpenVR.ApplicationType.VRApplication_Overlay);
assertInitOk("VR_InitInternal", initErrorBuffer[0]);

try {
  const systemPointer = getInterface(OpenVR.IVRSystem_Version);
  const overlayPointer = getInterface(OpenVR.IVROverlay_Version);
  const system = new OpenVR.IVRSystem(systemPointer);
  overlay = new OpenVR.IVROverlay(overlayPointer);
  if (nativeTiming) {
    nativeTimer = Deno.dlopen(new URL("./native_timing.dll", import.meta.url), {
      time_set_overlay_texture: {
        parameters: ["pointer", "u64", "pointer", "pointer"],
        result: "i32",
      },
    });
    const pointerValue = new Deno.UnsafePointerView(overlayPointer).getBigUint64(464);
    setOverlayTexturePointer = Deno.UnsafePointer.create(pointerValue);
    if (!setOverlayTexturePointer) throw new Error("SetOverlayTexture function pointer is null");
  }

  const handleBuffer = new BigUint64Array(1);
  const handlePointer = Deno.UnsafePointer.of(handleBuffer) as Deno.PointerValue<
    OpenVR.OverlayHandle
  >;
  assertOverlayOk(
    overlay.CreateOverlay(overlayKey, "PetPlay Raylib/OpenVR timing probe", handlePointer),
    "CreateOverlay",
  );
  overlayHandle = handleBuffer[0];

  const [transformPointer, transformView] = createStruct<OpenVR.HmdMatrix34>(
    {
      m: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, -1.2],
      ],
    },
    OpenVR.HmdMatrix34Struct,
  );
  // Retain backing storage for the complete native call lifetime.
  void transformView;
  assertOverlayOk(
    overlay.SetOverlayTransformTrackedDeviceRelative(
      overlayHandle,
      OpenVR.k_unTrackedDeviceIndex_Hmd,
      transformPointer,
    ),
    "SetOverlayTransformTrackedDeviceRelative",
  );
  assertOverlayOk(overlay.SetOverlayWidthInMeters(overlayHandle, 0.8), "SetOverlayWidthInMeters");
  if (stereoPanorama) {
    assertOverlayOk(
      overlay.SetOverlayFlag(
        overlayHandle,
        OpenVR.OverlayFlags.VROverlayFlags_Panorama,
        false,
      ),
      "SetOverlayFlag(Panorama=false)",
    );
    assertOverlayOk(
      overlay.SetOverlayFlag(
        overlayHandle,
        OpenVR.OverlayFlags.VROverlayFlags_StereoPanorama,
        true,
      ),
      "SetOverlayFlag(StereoPanorama=true)",
    );
  }

  const [boundsPointer, boundsView] = createStruct<OpenVR.TextureBounds>(
    { uMin: 0, uMax: 1, vMin: 1, vMax: 0 },
    OpenVR.TextureBoundsStruct,
  );
  void boundsView;
  assertOverlayOk(
    overlay.SetOverlayTextureBounds(overlayHandle, boundsPointer),
    "SetOverlayTextureBounds",
  );

  raylib.loadRaylib(getRaylibPath());
  raylib.SetTraceLogLevel(raylib.TraceLogLevel.LOG_WARNING);
  raylib.SetConfigFlags(raylib.ConfigFlags.FLAG_WINDOW_HIDDEN);
  raylib.H.InitWindow(1, 1, `raylib_openvr_probe_${crypto.randomUUID()}`);
  raylibWindowOpen = true;
  if (finishBeforeSubmit) {
    openGl = Deno.dlopen("opengl32.dll", {
      glFinish: { parameters: [], result: "void" },
    });
  }

  console.log(
    JSON.stringify({
      event: "probe-start",
      deno: Deno.version.deno,
      sizes,
      durationMs,
      warmupMs,
      pollYieldMs: yieldMs,
      stereoPanorama,
      finishBeforeSubmit,
      nativeTiming,
      textureCount,
      overlayKey,
    }),
  );

  for (const size of sizes) {
    await runSize(system, overlay, overlayHandle, size);
  }
} finally {
  if (overlay && overlayHandle !== 0n) {
    try {
      overlay.ClearOverlayTexture(overlayHandle);
    } catch {
      // Continue cleanup if SteamVR has already released the overlay.
    }
    try {
      overlay.HideOverlay(overlayHandle);
    } catch {
      // Continue cleanup.
    }
    try {
      overlay.DestroyOverlay(overlayHandle);
    } catch {
      // Continue cleanup.
    }
  }
  if (raylibWindowOpen) {
    raylib.H.CloseWindow();
  }
  openGl?.close();
  nativeTimer?.close();
  OpenVR.VR_ShutdownInternal();
  OpenVR.closeOpenVR();
}

async function runSize(
  system: OpenVR.IVRSystem,
  currentOverlay: OpenVR.IVROverlay,
  handle: bigint,
  size: number,
): Promise<void> {
  const targets = Array.from(
    { length: textureCount },
    () => raylib.H.LoadRenderTexture(size, size),
  );
  for (const target of targets) {
    if (!raylib.H.IsRenderTextureValid(target)) {
      for (const allocated of targets) {
        if (raylib.H.IsRenderTextureValid(allocated)) raylib.H.UnloadRenderTexture(allocated);
      }
      throw new Error(`LoadRenderTexture(${size}, ${size}) failed`);
    }
  }

  const textureStructs = targets.map((target) =>
    createStruct<OpenVR.Texture>(
      {
        handle: BigInt(target.texture.id) as unknown as Deno.PointerValue<unknown>,
        eType: OpenVR.TextureType.TextureType_OpenGL,
        eColorSpace: OpenVR.ColorSpace.ColorSpace_Auto,
      },
      OpenVR.TextureStruct,
    )
  );

  const secondsBuffer = new Float32Array(1);
  const frameBuffer = new BigUint64Array(1);
  const secondsPointer = Deno.UnsafePointer.of(secondsBuffer) as Deno.PointerValue<number>;
  const framePointer = Deno.UnsafePointer.of(frameBuffer) as Deno.PointerValue<bigint>;
  let lastVsync = 0n;
  let submitted = 0;
  let measured = 0;
  let skippedVsyncFrames = 0;
  let lastMeasuredVsync = 0n;
  const submitTimes: number[] = [];
  const nativeSubmitTimes: number[] = [];
  const finishTimes: number[] = [];
  const drawTimes: number[] = [];
  const waits: number[] = [];
  const frameTimes: number[] = [];
  const stalls: Array<{
    submit: number;
    finish: number;
    frame: number;
    atMs: number;
    vsync: string;
  }> = [];
  const start = performance.now();
  let lastFrameAt = start;
  const nativeDuration = new Float64Array(1);
  const nativeDurationPointer = Deno.UnsafePointer.of(nativeDuration)!;

  try {
    assertOverlayOk(currentOverlay.ShowOverlay(handle), "ShowOverlay");
    while (performance.now() - start < durationMs) {
      const waitStarted = performance.now();
      while (true) {
        if (!system.GetTimeSinceLastVsync(secondsPointer, framePointer)) {
          throw new Error("GetTimeSinceLastVsync failed");
        }
        if (lastVsync === 0n || frameBuffer[0] !== lastVsync) break;
        await new Promise((resolve) => setTimeout(resolve, yieldMs));
      }
      const vsync = frameBuffer[0];
      lastVsync = vsync;
      const waitMs = performance.now() - waitStarted;

      const drawStarted = performance.now();
      const textureIndex = submitted % targets.length;
      const target = targets[textureIndex];
      const phase = submitted % 240;
      const x = Math.floor((phase / 239) * Math.max(0, size - Math.max(8, size / 4)));
      raylib.H.BeginTextureMode(target);
      raylib.H.ClearBackground({ r: 8, g: 12, b: 20, a: 255 });
      raylib.H.DrawRectangle(
        x,
        Math.floor(size * 0.35),
        Math.max(8, Math.floor(size * 0.25)),
        Math.max(8, Math.floor(size * 0.3)),
        { r: 40, g: 210, b: 255, a: 255 },
      );
      raylib.H.EndTextureMode();
      const drawMs = performance.now() - drawStarted;

      const finishStarted = performance.now();
      if (finishBeforeSubmit) openGl!.symbols.glFinish();
      const finishMs = performance.now() - finishStarted;

      const submitStarted = performance.now();
      const texturePointer = textureStructs[textureIndex][0];
      const error = nativeTimer
        ? nativeTimer.symbols.time_set_overlay_texture(
          setOverlayTexturePointer,
          handle,
          texturePointer,
          nativeDurationPointer,
        ) as OpenVR.OverlayError
        : currentOverlay.SetOverlayTexture(handle, texturePointer);
      const submitMs = performance.now() - submitStarted;
      assertOverlayOk(error, "SetOverlayTexture");

      const now = performance.now();
      const elapsed = now - start;
      submitted++;
      if (elapsed >= warmupMs) {
        if (lastMeasuredVsync !== 0n && vsync > lastMeasuredVsync + 1n) {
          skippedVsyncFrames += Number(vsync - lastMeasuredVsync - 1n);
        }
        lastMeasuredVsync = vsync;
        measured++;
        submitTimes.push(submitMs);
        if (nativeTimer) nativeSubmitTimes.push(nativeDuration[0]);
        if (finishBeforeSubmit) finishTimes.push(finishMs);
        drawTimes.push(drawMs);
        waits.push(waitMs);
        frameTimes.push(now - lastFrameAt);
        if (submitMs >= 10 || finishMs >= 10) {
          stalls.push({
            submit: submitMs,
            finish: finishMs,
            frame: now - lastFrameAt,
            atMs: elapsed,
            vsync: String(vsync),
          });
        }
      }
      lastFrameAt = now;
    }

    const measuredDurationMs = Math.max(1, durationMs - warmupMs);
    console.log(
      JSON.stringify({
        event: "size-result",
        size,
        textureCount,
        textureMegabytesEach: round((size * size * 4) / (1024 * 1024)),
        textureMegabytesTotal: round((size * size * 4 * textureCount) / (1024 * 1024)),
        submitted,
        measured,
        submitHz: round((measured * 1000) / measuredDurationMs),
        skippedVsyncFrames,
        glFinish: finishBeforeSubmit ? summarize(finishTimes) : null,
        setOverlayTexture: summarize(submitTimes),
        setOverlayTextureNative: nativeTimer ? summarize(nativeSubmitTimes) : null,
        raylibDraw: summarize(drawTimes),
        vsyncWait: summarize(waits),
        frameInterval: summarize(frameTimes),
        worstStalls: stalls.sort((a, b) =>
          Math.max(b.submit, b.finish) - Math.max(a.submit, a.finish)
        ).slice(0, 10),
      }),
    );
  } finally {
    try {
      currentOverlay.ClearOverlayTexture(handle);
    } finally {
      // Keep the struct backing stores alive until OpenVR releases the texture.
      void textureStructs;
      for (const target of targets) raylib.H.UnloadRenderTexture(target);
    }
  }
}

function summarize(values: number[]): TimingSummary {
  if (values.length === 0) {
    return {
      count: 0,
      avgMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      over5Ms: 0,
      over10Ms: 0,
      over25Ms: 0,
      over50Ms: 0,
      over100Ms: 0,
    };
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
  return {
    count: values.length,
    avgMs: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    p50Ms: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
    p99Ms: round(percentile(0.99)),
    maxMs: round(sorted[sorted.length - 1]),
    over5Ms: values.filter((value) => value >= 5).length,
    over10Ms: values.filter((value) => value >= 10).length,
    over25Ms: values.filter((value) => value >= 25).length,
    over50Ms: values.filter((value) => value >= 50).length,
    over100Ms: values.filter((value) => value >= 100).length,
  };
}

function getInterface(version: string): Deno.PointerObject<unknown> {
  initErrorBuffer[0] = OpenVR.InitError.VRInitError_None;
  const pointer = OpenVR.VR_GetGenericInterface(stringToPointer(version), initErrorPointer);
  assertInitOk(`VR_GetGenericInterface(${version})`, initErrorBuffer[0]);
  if (!pointer) throw new Error(`VR_GetGenericInterface(${version}) returned null`);
  return pointer;
}

function assertInitOk(operation: string, error: number): void {
  if (error !== OpenVR.InitError.VRInitError_None) {
    throw new Error(`${operation}: ${OpenVR.InitError[error] ?? error}`);
  }
}

function assertOverlayOk(error: OpenVR.OverlayError, operation: string): void {
  if (error !== OpenVR.OverlayError.VROverlayError_None) {
    throw new Error(`${operation}: ${OpenVR.OverlayError[error] ?? error}`);
  }
}

function getRaylibPath(): string {
  const url = new URL("../../resources/raylib.dll", import.meta.url);
  return Deno.build.os === "windows"
    ? decodeURIComponent(url.pathname.replace(/^\/+/, ""))
    : decodeURIComponent(url.pathname);
}

function getSizesArg(): number[] {
  const raw = Deno.args.find((arg) => arg.startsWith("--sizes="))?.split("=", 2)[1] ??
    "512,2048,3560,7120";
  const parsed = raw.split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value >= 16 && value <= 8192);
  if (parsed.length === 0) throw new Error("--sizes must contain at least one size from 16..8192");
  return [...new Set(parsed)];
}

function getNumberArg(name: string, fallback: number): number {
  const raw = Deno.args.find((arg) => arg.startsWith(`${name}=`))?.split("=", 2)[1];
  const value = raw == null ? fallback : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function getBooleanArg(name: string): boolean {
  const raw = Deno.args.find((arg) => arg === name || arg.startsWith(`${name}=`));
  if (raw == null) return false;
  const value = raw.split("=", 2)[1]?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off" || value === "no");
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
