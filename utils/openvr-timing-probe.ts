#!/usr/bin/env -S deno run -A

import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { stringToPointer } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";

const durationMs = getNumberArg("--duration-ms", 2_000);

const ok = OpenVR.initializeOpenVR("../resources/openvr_api.dll", import.meta.url);
if (!ok) {
  throw new Error("failed to load openvr_api.dll");
}

const initErrorBuf = new Int32Array(1);
const initErrorPtr = Deno.UnsafePointer.of(initErrorBuf) as OpenVR.InitErrorPTRType;

OpenVR.VR_InitInternal(initErrorPtr, OpenVR.ApplicationType.VRApplication_Overlay);
let initError = initErrorBuf[0] as OpenVR.InitError;
if (initError !== OpenVR.InitError.VRInitError_None) {
  throw new Error(`VR_InitInternal failed: ${OpenVR.InitError[initError] ?? initError}`);
}

try {
  const systemPtr = OpenVR.VR_GetGenericInterface(
    stringToPointer(OpenVR.IVRSystem_Version),
    initErrorPtr,
  );
  initError = initErrorBuf[0] as OpenVR.InitError;
  if (initError !== OpenVR.InitError.VRInitError_None || systemPtr == null) {
    throw new Error(
      `VR_GetGenericInterface(IVRSystem) failed: ${OpenVR.InitError[initError] ?? initError}`,
    );
  }

  const vr = new OpenVR.IVRSystem(systemPtr);
  const hmd = OpenVR.k_unTrackedDeviceIndex_Hmd;

  console.log("OpenVR timing probe");
  console.log(`IVRSystem: ${OpenVR.IVRSystem_Version}`);
  console.log(`HMD connected: ${vr.IsTrackedDeviceConnected(hmd)}`);
  console.log(`HMD class: ${enumName(OpenVR.TrackedDeviceClass, vr.GetTrackedDeviceClass(hmd))}`);
  logFloatProp(
    vr,
    hmd,
    "Prop_DisplayFrequency_Float",
    OpenVR.TrackedDeviceProperty.Prop_DisplayFrequency_Float,
  );
  logFloatProp(
    vr,
    hmd,
    "Prop_SecondsFromVsyncToPhotons_Float",
    OpenVR.TrackedDeviceProperty.Prop_SecondsFromVsyncToPhotons_Float,
  );

  const first = readVsync(vr);
  console.log(
    `Initial GetTimeSinceLastVsync: ok=${first.ok}, seconds=${
      first.seconds.toFixed(6)
    }, frame=${first.frame}`,
  );

  const stats = await measureVsyncCounter(vr, durationMs);
  console.log(`Measured for ${(stats.elapsedMs / 1000).toFixed(3)}s:`);
  console.log(`  calls: ${stats.calls}`);
  console.log(`  frame changes: ${stats.frameChanges}`);
  console.log(`  first frame: ${stats.firstFrame}`);
  console.log(`  last frame: ${stats.lastFrame}`);
  console.log(`  frame delta: ${stats.frameDelta}`);
  console.log(`  frame-counter Hz: ${stats.frameHz.toFixed(2)}`);
  console.log(`  observed change Hz: ${stats.changeHz.toFixed(2)}`);
  console.log(
    `  secondsSinceLastVsync range: ${stats.minSeconds.toFixed(6)}..${stats.maxSeconds.toFixed(6)}`,
  );
} finally {
  OpenVR.VR_ShutdownInternal();
}

function readFloatProp(
  vr: OpenVR.IVRSystem,
  deviceIndex: number,
  prop: OpenVR.TrackedDeviceProperty,
): { value: number; error: OpenVR.TrackedPropertyError } {
  const errBuf = new Int32Array(1);
  const errPtr = Deno.UnsafePointer.of(errBuf) as Deno.PointerValue<OpenVR.TrackedPropertyError>;
  const value = vr.GetFloatTrackedDeviceProperty(deviceIndex, prop, errPtr);
  return { value, error: errBuf[0] as OpenVR.TrackedPropertyError };
}

function logFloatProp(
  vr: OpenVR.IVRSystem,
  deviceIndex: number,
  label: string,
  prop: OpenVR.TrackedDeviceProperty,
): void {
  const { value, error } = readFloatProp(vr, deviceIndex, prop);
  console.log(`${label}: ${value} (${enumName(OpenVR.TrackedPropertyError, error)})`);
}

function readVsync(vr: OpenVR.IVRSystem): { ok: boolean; seconds: number; frame: bigint } {
  const secondsBuf = new Float32Array(1);
  const frameBuf = new BigUint64Array(1);
  const secondsPtr = Deno.UnsafePointer.of(secondsBuf) as Deno.PointerValue<number>;
  const framePtr = Deno.UnsafePointer.of(frameBuf) as Deno.PointerValue<bigint>;
  const ok = vr.GetTimeSinceLastVsync(secondsPtr, framePtr);
  return { ok, seconds: secondsBuf[0], frame: frameBuf[0] };
}

async function measureVsyncCounter(
  vr: OpenVR.IVRSystem,
  requestedDurationMs: number,
): Promise<{
  calls: number;
  elapsedMs: number;
  frameChanges: number;
  firstFrame: bigint;
  lastFrame: bigint;
  frameDelta: bigint;
  frameHz: number;
  changeHz: number;
  minSeconds: number;
  maxSeconds: number;
}> {
  let calls = 0;
  let frameChanges = 0;
  let firstFrame: bigint | null = null;
  let lastFrame = 0n;
  let minSeconds = Number.POSITIVE_INFINITY;
  let maxSeconds = Number.NEGATIVE_INFINITY;
  const start = performance.now();
  let lastYield = start;

  while (performance.now() - start < requestedDurationMs) {
    const sample = readVsync(vr);
    calls++;
    if (sample.ok) {
      firstFrame ??= sample.frame;
      if (sample.frame !== lastFrame && lastFrame !== 0n) {
        frameChanges++;
      }
      lastFrame = sample.frame;
      minSeconds = Math.min(minSeconds, sample.seconds);
      maxSeconds = Math.max(maxSeconds, sample.seconds);
    }

    const now = performance.now();
    if (now - lastYield >= 5) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }

  const elapsedMs = performance.now() - start;
  const startFrame = firstFrame ?? 0n;
  const frameDelta = lastFrame >= startFrame ? lastFrame - startFrame : 0n;
  const seconds = elapsedMs / 1000;
  return {
    calls,
    elapsedMs,
    frameChanges,
    firstFrame: startFrame,
    lastFrame,
    frameDelta,
    frameHz: Number(frameDelta) / seconds,
    changeHz: frameChanges / seconds,
    minSeconds: Number.isFinite(minSeconds) ? minSeconds : 0,
    maxSeconds: Number.isFinite(maxSeconds) ? maxSeconds : 0,
  };
}

function getNumberArg(name: string, fallback: number): number {
  const raw = Deno.args.find((arg) => arg.startsWith(`${name}=`))?.split("=", 2)[1];
  if (raw == null) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function enumName(enumObject: Record<string, string | number>, value: number): string {
  return `${enumObject[value] ?? "Unknown"} (${value})`;
}
