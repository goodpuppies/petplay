/** Small camera steps through the real debug command path, restored in finally. */
import { message } from "./vrlab/petplay.ts";
import type { VrcWorldCameraPose } from "../classes/vrcCameraCalibration.ts";
import { DepthLatencyTracker } from "../classes/vrchatDepth/latency.ts";

type Report = ReturnType<DepthLatencyTracker["report"]>;
const option = (name: string) =>
  Deno.args.find((arg) => arg.startsWith(`--${name}=`))?.split("=", 2)[1];
const count = Math.max(1, Math.min(32, Number(option("samples") ?? 12)));
if (!Number.isInteger(count)) throw new Error("--samples must be a finite integer");
const out = option("out") ?? "_scratch/vrchat-depth/latency-probe.json";
const status = await message<
  {
    details: {
      depthDebug: boolean;
      flyControlled: boolean;
      depthAgeMs: number | null;
      observedCamera: VrcWorldCameraPose | null;
    };
  }
>("main", "VRCCAMERAVIEWSTATUS");
const view = status.details;
if (!view.depthDebug || !view.observedCamera || view.depthAgeMs == null || view.depthAgeMs > 500) {
  throw new Error("Open vrcdepth debug with fresh depth before probing");
}
if (view.flyControlled) throw new Error("Release RMB before running the camera-step latency probe");
const original = structuredClone(view.observedCamera);
const outcomes: { sequence: number; matched: boolean }[] = [];
let report: Report | null = null;
await message("vrcCameraView", "GETDEPTHLATENCY", { reset: true });
try {
  for (let i = 0; i < count; i++) {
    const sign = i % 2 ? -1 : 1;
    const pose: VrcWorldCameraPose = {
      position: [
        original.position[0] + sign * (i + 1) * 0.008,
        original.position[1],
        original.position[2],
      ],
      rotationDeg: [
        original.rotationDeg[0],
        original.rotationDeg[1] + sign * 2,
        original.rotationDeg[2],
      ],
    };
    const command = await message<{ sequence: number }>("vrcCameraView", "DEPTHDEBUGSETPOSE", pose);
    const deadline = performance.now() + 2000;
    let matched = false;
    while (performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      report = await message<Report>("vrcCameraView", "GETDEPTHLATENCY");
      const sample = report.samples.find((sample) => sample.sequence === command.sequence);
      if (sample) {
        console.log(JSON.stringify(sample));
        matched = true;
        break;
      }
    }
    outcomes.push({ sequence: command.sequence, matched });
    if (!matched) console.log(JSON.stringify({ sequence: command.sequence, timeout: true }));
  }
  report = await message<Report>("vrcCameraView", "GETDEPTHLATENCY");
} finally {
  try {
    await message("vrcCameraView", "DEPTHDEBUGSETPOSE", original);
  } finally {
    try {
      await message("cameraOrigin", "SETUSERCAMERAFLYING", false);
    } finally {
      const slash = out.lastIndexOf("/");
      await Deno.mkdir(slash < 0 ? "." : out.slice(0, slash) || "/", { recursive: true });
      await Deno.writeTextFile(out, JSON.stringify({ original, outcomes, report }, null, 2));
    }
  }
}
console.log(JSON.stringify({ summary: report?.summary, endpoint: report?.endpoint, out }, null, 2));
