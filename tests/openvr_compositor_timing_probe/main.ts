#!/usr/bin/env -S deno run -A --no-check

/** Read-only SteamVR scene-application timing sampler for before/after load comparisons. */

import * as OpenVR from "../../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { stringToPointer } from "../../submodules/OpenVR_TS_Bindings_Deno/utils.ts";

const durationMs = getNumberArg("--duration-ms", 10_000);
const pollMs = getNumberArg("--poll-ms", 4);
const timingSize = OpenVR.Compositor_FrameTimingStruct.byteSize;
const cumulativeSize = OpenVR.Compositor_CumulativeStatsStruct.byteSize;

if (!OpenVR.initializeOpenVR("../../resources/openvr_api.dll", import.meta.url)) {
  throw new Error("failed to load openvr_api.dll");
}

const initError = new Int32Array(1);
const initErrorPointer = Deno.UnsafePointer.of(initError) as OpenVR.InitErrorPTRType;
OpenVR.VR_InitInternal(initErrorPointer, OpenVR.ApplicationType.VRApplication_Background);
assertInitOk("VR_InitInternal", initError[0]);

try {
  const compositorPointer = getInterface(OpenVR.IVRCompositor_Version);
  const compositor = new OpenVR.IVRCompositor(compositorPointer);
  const before = readCumulative(compositor);
  const timings: OpenVR.Compositor_FrameTiming[] = [];
  const timingBytes = new Uint8Array(timingSize);
  const timingView = new DataView(timingBytes.buffer);
  const timingPointer = Deno.UnsafePointer.of(timingBytes) as Deno.PointerValue<
    OpenVR.Compositor_FrameTiming
  >;
  let lastFrameIndex = -1;
  const started = performance.now();

  while (performance.now() - started < durationMs) {
    timingView.setUint32(0, timingSize, true);
    if (compositor.GetFrameTiming(timingPointer, 0)) {
      const timing = OpenVR.Compositor_FrameTimingStruct.read(
        timingView,
      ) as unknown as OpenVR.Compositor_FrameTiming;
      if (timing.nFrameIndex !== lastFrameIndex) {
        lastFrameIndex = timing.nFrameIndex;
        timings.push(timing);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  const after = readCumulative(compositor);
  const fields = {
    clientFrameIntervalMs: timings.map((v) => v.flClientFrameIntervalMs),
    totalRenderGpuMs: timings.map((v) => v.flTotalRenderGpuMs),
    preSubmitGpuMs: timings.map((v) => v.flPreSubmitGpuMs),
    postSubmitGpuMs: timings.map((v) => v.flPostSubmitGpuMs),
    compositorRenderGpuMs: timings.map((v) => v.flCompositorRenderGpuMs),
    compositorRenderCpuMs: timings.map((v) => v.flCompositorRenderCpuMs),
    presentCallCpuMs: timings.map((v) => v.flPresentCallCpuMs),
    waitForPresentCpuMs: timings.map((v) => v.flWaitForPresentCpuMs),
    submitFrameMs: timings.map((v) => v.flSubmitFrameMs),
    transferLatencyMs: timings.map((v) => v.flTransferLatencyMs),
  };
  const first = timings.at(0);
  const last = timings.at(-1);
  const runtimeSeconds = first && last
    ? Math.max(0, last.flSystemTimeInSeconds - first.flSystemTimeInSeconds)
    : 0;

  console.log(JSON.stringify({
    event: "openvr-compositor-timing",
    durationMs,
    sampledFrames: timings.length,
    frameIndexStart: first?.nFrameIndex ?? null,
    frameIndexEnd: last?.nFrameIndex ?? null,
    observedFps: runtimeSeconds > 0 && first && last
      ? round((last.nFrameIndex - first.nFrameIndex) / runtimeSeconds)
      : 0,
    applicationPid: after.nPid,
    timing: Object.fromEntries(
      Object.entries(fields).map(([name, values]) => [name, summarize(values)]),
    ),
    perFrameCounters: {
      framesWithDroppedCount: timings.filter((v) => v.nNumDroppedFrames > 0).length,
      framesWithMisPresentedCount: timings.filter((v) => v.nNumMisPresented > 0).length,
      framesWithReprojectionFlags: timings.filter((v) => v.nReprojectionFlags !== 0).length,
    },
    cumulativeDelta: {
      framePresents: after.nNumFramePresents - before.nNumFramePresents,
      droppedFrames: after.nNumDroppedFrames - before.nNumDroppedFrames,
      reprojectedFrames: after.nNumReprojectedFrames - before.nNumReprojectedFrames,
      frameSubmits: after.nNumFrameSubmits - before.nNumFrameSubmits,
      compositorCpuMs: round(after.flSumCompositorCPUTimeMS - before.flSumCompositorCPUTimeMS),
      compositorGpuMs: round(after.flSumCompositorGPUTimeMS - before.flSumCompositorGPUTimeMS),
      applicationCpuMs: round(after.flSumApplicationCPUTimeMS - before.flSumApplicationCPUTimeMS),
      applicationGpuMs: round(after.flSumApplicationGPUTimeMS - before.flSumApplicationGPUTimeMS),
    },
  }));
} finally {
  OpenVR.VR_ShutdownInternal();
  OpenVR.closeOpenVR();
}

function readCumulative(compositor: OpenVR.IVRCompositor): OpenVR.Compositor_CumulativeStats {
  const bytes = new Uint8Array(cumulativeSize);
  const pointer = Deno.UnsafePointer.of(bytes) as Deno.PointerValue<
    OpenVR.Compositor_CumulativeStats
  >;
  compositor.GetCumulativeStats(pointer, cumulativeSize);
  return OpenVR.Compositor_CumulativeStatsStruct.read(new DataView(bytes.buffer));
}

function getInterface(version: string): Deno.PointerObject<unknown> {
  initError[0] = OpenVR.InitError.VRInitError_None;
  const pointer = OpenVR.VR_GetGenericInterface(stringToPointer(version), initErrorPointer);
  assertInitOk(`VR_GetGenericInterface(${version})`, initError[0]);
  if (!pointer) throw new Error(`VR_GetGenericInterface(${version}) returned null`);
  return pointer;
}

function assertInitOk(operation: string, error: number): void {
  if (error !== OpenVR.InitError.VRInitError_None) {
    throw new Error(`${operation}: ${OpenVR.InitError[error] ?? error}`);
  }
}

function summarize(values: number[]) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return { avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const percentile = (fraction: number) =>
    finite[Math.min(finite.length - 1, Math.ceil(finite.length * fraction) - 1)];
  return {
    avg: round(finite.reduce((sum, value) => sum + value, 0) / finite.length),
    p50: round(percentile(0.5)),
    p95: round(percentile(0.95)),
    p99: round(percentile(0.99)),
    max: round(finite.at(-1)!),
  };
}

function getNumberArg(name: string, fallback: number): number {
  const raw = Deno.args.find((arg) => arg.startsWith(`${name}=`))?.split("=", 2)[1];
  const value = raw == null ? fallback : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
