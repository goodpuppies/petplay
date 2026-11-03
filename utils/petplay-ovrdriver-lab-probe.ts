#!/usr/bin/env -S deno run -A
/** Read-only synthetic-runtime probe; refuses a physical HMD. Does not start SteamVR. */
import * as VR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { stringToPointer } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { getOpenVrLibraryPath } from "../classes/nativeLibraryPaths.ts";

if (Deno.build.os !== "linux") throw new Error("This lab currently supports Linux only");
const server = new Deno.Command("pgrep", {
  args: ["-x", "vrserver"],
  stdout: "null",
  stderr: "null",
}).outputSync();
if (!server.success) throw new Error("Start the synthetic-only lab session first");
const settings = JSON.parse(
  await Deno.readTextFile(`${Deno.env.get("HOME")}/.local/share/Steam/config/steamvr.vrsettings`),
);
if (
  settings.steamvr?.forcedDriver !== "petplay" || settings.driver_petplay?.syntheticHmd !== true
) {
  throw new Error("Synthetic-only lab configuration is not active");
}
if (!VR.initializeOpenVR(getOpenVrLibraryPath())) throw new Error("OpenVR library unavailable");
const err = new Int32Array(1);
const errPtr = Deno.UnsafePointer.of(err) as VR.InitErrorPTRType;
VR.VR_InitInternal(errPtr, VR.ApplicationType.VRApplication_Overlay);
if (err[0]) throw new Error(`OpenVR init: ${err[0]}`);
try {
  function required(name: string) {
    const pointer = VR.VR_GetGenericInterface(stringToPointer(name), errPtr);
    if (!pointer || err[0]) throw new Error(`Missing ${name}: ${err[0]}`);
    return pointer;
  }
  if (VR.IVRSystem_Version !== "FnTable:IVRSystem_022") {
    throw new Error("Review property-reader ABI for changed interface");
  }
  const systemPtr = required(VR.IVRSystem_Version);
  const system = new VR.IVRSystem(systemPtr);
  const fn = Deno.UnsafePointer.create(new Deno.UnsafePointerView(systemPtr).getBigUint64(216));
  if (!fn) throw new Error("String-property function missing");
  const signature = {
    parameters: ["u32", "i32", "buffer", "u32", "buffer"],
    result: "u32",
  } as const;
  const read = new Deno.UnsafeFnPointer(fn as Deno.PointerObject<typeof signature>, signature);
  const serialBuffer = new Uint8Array(256);
  const serialError = new Int32Array(1);
  const length = read.call(
    0,
    VR.TrackedDeviceProperty.Prop_SerialNumber_String,
    serialBuffer,
    serialBuffer.length,
    serialError,
  );
  const serial = new TextDecoder().decode(serialBuffer.subarray(0, Math.max(0, length - 1)));
  if (serialError[0] || serial !== "PETPLAY-SYNTHETIC-HMD-001") {
    throw new Error(`Refusing non-lab HMD: ${serial}`);
  }
  const recommended = new Uint32Array(2);
  system.GetRecommendedRenderTargetSize(
    Deno.UnsafePointer.of(recommended.subarray(0, 1)),
    Deno.UnsafePointer.of(recommended.subarray(1)),
  );
  const propertyError = new Int32Array(1);
  const frequency = system.GetFloatTrackedDeviceProperty(
    0,
    VR.TrackedDeviceProperty.Prop_DisplayFrequency_Float,
    Deno.UnsafePointer.of(propertyError),
  );
  if (propertyError[0]) throw new Error("Cannot read active display frequency");
  const expected = settings.driver_petplay;
  if (expected.refreshHz != null && Math.abs(frequency - expected.refreshHz) > 0.01) {
    throw new Error(`Frequency mismatch: ${frequency}`);
  }
  if (
    expected.renderWidth != null &&
    (Math.abs(recommended[0] - expected.renderWidth) > 8 ||
      Math.abs(recommended[1] - expected.renderHeight) > 8)
  ) throw new Error(`Render-size mismatch: ${recommended}`);
  const overlay = new VR.IVROverlay(required(VR.IVROverlay_Version));
  const seconds = new Float32Array(1);
  const counter = new BigUint64Array(1);
  function vsync() {
    const valid = system.GetTimeSinceLastVsync(
      Deno.UnsafePointer.of(seconds),
      Deno.UnsafePointer.of(counter),
    );
    return { valid, frame: counter[0] };
  }
  for (let i = 0; i < 10; i++) overlay.WaitFrameSync(100);
  const intervals: number[] = [];
  let errors = 0, invalidVsync = 0, repeatedFrames = 0;
  const first = vsync();
  let last = first;
  const start = performance.now();
  let previous = start;
  for (let i = 0; i < 225; i++) {
    const result = overlay.WaitFrameSync(100);
    const now = performance.now();
    intervals.push(now - previous);
    previous = now;
    if (result !== 0) errors++;
    const sample = vsync();
    if (!sample.valid) invalidVsync++;
    if (sample.valid && last.valid && sample.frame === last.frame) repeatedFrames++;
    last = sample;
  }
  const elapsedMs = performance.now() - start;
  intervals.sort((a, b) => a - b);
  const report = {
    serial,
    display: { recommendedPerEye: [...recommended], frequency, requested: expected },
    samples: intervals.length,
    elapsedMs,
    errors,
    invalidVsync,
    repeatedFrames,
    frameDelta: String(last.frame - first.frame),
    counterHz: Number(last.frame - first.frame) * 1000 / elapsedMs,
    wakeHz: intervals.length * 1000 / elapsedMs,
    intervalMs: {
      min: intervals[0],
      p50: intervals[112],
      p95: intervals[213],
      max: intervals.at(-1),
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (Deno.args.includes("--workload-snapshot")) {
    const compositor = new VR.IVRCompositor(required(VR.IVRCompositor_Version));
    const timingBuffer = new ArrayBuffer(VR.Compositor_FrameTimingStruct.byteSize);
    const view = new DataView(timingBuffer);
    view.setUint32(0, timingBuffer.byteLength, true);
    const valid = compositor.GetFrameTiming(
      Deno.UnsafePointer.of(timingBuffer) as Deno.PointerValue<VR.Compositor_FrameTiming>,
      0,
    );
    console.log(
      JSON.stringify({
        experiment: "workload-snapshot",
        scenePid: compositor.GetCurrentSceneFocusProcess(),
        validTiming: valid,
        timing: valid ? VR.Compositor_FrameTimingStruct.read(view) : null,
      }),
    );
  }
  const holdSeconds = Number(Deno.args.find((a) => a.startsWith("--hold-open="))?.slice(12) ?? 0);
  if (!Number.isFinite(holdSeconds) || holdSeconds < 0 || holdSeconds > 3600) {
    throw new Error("--hold-open must be 0..3600 seconds");
  }
  if (holdSeconds) {
    console.error(`Holding guarded synthetic overlay client open for ${holdSeconds}s`);
    await new Promise((resolve) => setTimeout(resolve, holdSeconds * 1000));
  }
  if (Deno.args.includes("--direct-state")) {
    const { PostalService } = await import("../submodules/stageforge/mod.ts");
    const { attachOpenVrDriverProxy } = await import("../classes/petplayOpenVrDriverProxy.ts");
    const postal = new PostalService();
    const id = await attachOpenVrDriverProxy(
      postal,
      `${settings.driver_petplay.socketDirectory}/control.sock`,
    );
    try {
      console.log(
        JSON.stringify(
          {
            direct: await postal.PostMessage(
              { target: id, type: "GETDIRECTSTATE", payload: null },
              true,
            ),
          },
          null,
          2,
        ),
      );
    } finally {
      postal.detachProxy(id);
    }
  }
  const renderMode = Deno.args.find((a) => a.startsWith("--render-images="))?.slice(16);
  if (renderMode) {
    if (!settings.driver_petplay.driverDirect) throw new Error("Driver-direct backend required");
    const directory = Deno.args.find((a) => a.startsWith("--capture-dir="))?.slice(14);
    if (!directory) throw new Error("--capture-dir is required");
    const { probeRenderedImages } = await import("./petplay-ovrdriver-render-images.ts");
    await probeRenderedImages(
      settings.driver_petplay.socketDirectory,
      directory,
      renderMode,
      Deno.args.find((a) => a.startsWith("--render-pacing="))?.slice(16) ?? "vsync",
      Deno.args.includes("--render-rotation"),
      Number(Deno.args.find((a) => a.startsWith("--render-eye-size="))?.slice(18) ?? 512),
      Deno.args.includes("--render-stall-control"),
    );
  }
  if (Deno.args.includes("--motion-images")) {
    if (!settings.driver_petplay.driverDirect) throw new Error("Driver-direct backend required");
    const directory = Deno.args.find((a) => a.startsWith("--capture-dir="))?.slice(14);
    if (!directory) throw new Error("--capture-dir is required");
    const { probeMotionImages } = await import("./petplay-ovrdriver-motion-images.ts");
    await probeMotionImages(
      system,
      overlay,
      settings.driver_petplay.socketDirectory,
      directory,
      Deno.args.includes("--motion-step-control"),
    );
  }
  if (Deno.args.includes("--direct-markers")) {
    if (!settings.driver_petplay.driverDirect) throw new Error("Driver-direct backend is required");
    const { probeDirectMarkers } = await import("./petplay-ovrdriver-direct-probe.ts");
    await probeDirectMarkers(
      overlay,
      settings.driver_petplay.socketDirectory,
      Deno.args.find((a) => a.startsWith("--capture-dir="))?.slice("--capture-dir=".length),
    );
  }
  if (
    errors || invalidVsync || repeatedFrames || Math.abs(report.counterHz - 75) > 3 ||
    Math.abs(report.wakeHz - 75) > 3
  ) Deno.exitCode = 1;
  if (Deno.args.includes("--controllers")) {
    const { probeControllers } = await import("./petplay-ovrdriver-controller-probe.ts");
    await probeControllers(system, overlay, settings.driver_petplay.socketDirectory);
  }
} finally {
  VR.VR_ShutdownInternal();
}
// The process-worker backend retains a parent-side event source after murder.
// This standalone diagnostic owns all actors and has completed native shutdown.
if (Deno.args.some((a) => a.startsWith("--render-images="))) Deno.exit(Deno.exitCode ?? 0);
