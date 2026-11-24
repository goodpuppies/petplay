/** Runs the actual independent render owner, with no PetPlay scene producer or real hand input.
 * deno run -A --no-check utils/overlay-motion-live.ts [directory] [eye-size] [phase-ms] [phase-name]
 * Records CPU publication only. Attach compositor capture separately to measure consumption.
 */
import { IPCWorker, PostalService } from "../submodules/stageforge/mod.ts";
const directory = Deno.args[0] ?? "/tmp/petplay-motion-live";
const eyeSize = Number(Deno.args[1] ?? 512);
const duration = Number(Deno.args[2] ?? 4000);
if (!Number.isFinite(duration) || duration < 500 || duration > 60000) {
  throw new Error("phase-ms must be 500..60000");
}
await Deno.mkdir(directory, { recursive: true });
const postal = new PostalService().registerWorker("process", IPCWorker);
const url = new URL("../petplay/overlayRenderOwner.ts", import.meta.url);
const actor = await postal.add(url.href, url.href, undefined, "process");
const request = (type: string, payload: unknown = null) =>
  postal.PostMessage({ target: actor, type, payload }, true);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  await request("STARTOVERLAYRENDERER", {
    eyeSize,
    overlayName: "PetPlay deterministic motion probe",
    presentMode: "projection",
  });
  for (
    const phase of [
      { name: "projection-before", mode: "projection", pacing: "presenter", rotate: false },
      { name: "panorama-presenter", mode: "panorama", pacing: "presenter", rotate: false },
      { name: "panorama-presenter-rotated", mode: "panorama", pacing: "presenter", rotate: true },
      { name: "panorama-vsync", mode: "panorama", pacing: "vsync", rotate: false },
      { name: "projection-after", mode: "projection", pacing: "presenter", rotate: false },
    ].filter((phase) => !Deno.args[3] || phase.name === Deno.args[3])
  ) {
    await request("SETPRESENTMODE", phase.mode);
    await request("SETRENDERERDEBUG", {
      panoramaPacing: phase.pacing,
      panoramaTextureRotation: phase.rotate,
    });
    await request("SETMOTIONPROBE", { enabled: true, durationMs: duration });
    await pause(duration + 100);
    const capture = await request("GETMOTIONPROBE");
    const health = await request("__HEALTH__");
    await Deno.writeTextFile(
      `${directory}/${phase.name}.json`,
      JSON.stringify({ phase, eyeSize, capture, health }, null, 2),
    );
    console.log(`Saved ${phase.name}`);
    if ((health as { error?: string }).error) throw new Error(JSON.stringify(health));
  }
} finally {
  await request("SETMOTIONPROBE", { enabled: false });
  await request("STOPOVERLAYRENDERER");
  await postal.shutdown(actor);
}
Deno.exit(0);
