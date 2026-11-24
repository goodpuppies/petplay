/** Called only after lab-probe has verified the synthetic-only runtime. */
import { IPCWorker, PostalService } from "../submodules/stageforge/mod.ts";
import { attachOpenVrDriverProxy } from "../classes/petplayOpenVrDriverProxy.ts";
export async function probeRenderedImages(
  socketDirectory: string,
  directory: string,
  mode: string,
  pacing = "vsync",
  rotate = false,
  eyeSize = 512,
  stallControl = false,
) {
  if (!["panorama", "projection"].includes(mode)) throw new Error("Unknown render mode");
  if (!Number.isInteger(eyeSize) || eyeSize < 256 || eyeSize > 2048) {
    throw new Error("Render eye size must be an integer from 256 to 2048");
  }
  const postal = new PostalService().registerWorker("process", IPCWorker);
  const driver = await attachOpenVrDriverProxy(postal, `${socketDirectory}/control.sock`);
  const native = (type: string, payload: unknown = null) =>
    postal.PostMessage({ target: driver, type, payload }, true);
  const original = await native("GETCONTROLLERSTATE") as { config: unknown };
  const url = new URL("../petplay/overlayRenderOwner.ts", import.meta.url);
  let actor: Awaited<ReturnType<PostalService["add"]>> | undefined;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    const config = { mode: "sine", frequencyHz: .7, positionAmplitudeM: .12, yawAmplitudeRad: 0 };
    const ack = await native("SETCONTROLLERMOTION", config) as { commandId: number };
    let state: { appliedId: number; epochSeconds: number };
    const deadline = performance.now() + 1000;
    do {
      state = await native("GETCONTROLLERSTATE") as typeof state;
      if (state.appliedId === ack.commandId) break;
      if (performance.now() > deadline) throw new Error("Motion command timeout");
      await pause(5);
    } while (true);
    actor = await postal.add(url.href, url.href, undefined, "process");
    const request = (type: string, payload: unknown = null) =>
      postal.PostMessage({ target: actor!, type, payload }, true);
    await request("STARTOVERLAYRENDERER", {
      eyeSize,
      overlayName: `PetPlay ${mode} image probe`,
      presentMode: mode,
    });
    await request("SETRENDERERDEBUG", { panoramaPacing: pacing, panoramaTextureRotation: rotate });
    await request("SETMOTIONPROBE", { enabled: true, nativeController: true, durationMs: 18000 });
    await pause(1500);
    const health = await request("__HEALTH__") as { error?: string; publishedFrames: number };
    if (health.error || !health.publishedFrames) throw new Error(JSON.stringify(health));
    await Deno.writeTextFile(`${directory}/stream.tmp`, "motion", { createNew: true, mode: 0o600 });
    await Deno.rename(`${directory}/stream.tmp`, `${directory}/stream`);
    const limit = performance.now() + 12000;
    let completion;
    let stalled = false;
    const started = performance.now();
    const interventions: unknown[] = [];
    while (true) {
      if (stallControl && !stalled && performance.now() - started > 1500) {
        stalled = true;
        interventions.push({ kind: "freeze-rendering-100ms", beginMs: performance.now() });
        await request("SETRENDERERDEBUG", { freezeRendering: true });
        await pause(100);
        await request("SETRENDERERDEBUG", { freezeRendering: false });
      }
      try {
        completion = JSON.parse(await Deno.readTextFile(`${directory}/motion.complete`));
        break;
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
      const health = await request("__HEALTH__") as { error?: string };
      if (health.error) throw new Error(JSON.stringify(health));
      if (performance.now() > limit) throw new Error("Stream timeout");
      await pause(100);
    }
    console.log(
      JSON.stringify({
        experiment: "motion-images",
        publication: `petplay-${mode}-${pacing}${rotate ? "-rotated" : ""}`,
        eyeSize,
        interventions,
        config,
        epochSeconds: state.epochSeconds,
        completion,
        rows: [],
        renderer: await request("GETMOTIONPROBE"),
        health: await request("__HEALTH__"),
      }),
    );
  } finally {
    if (actor) {
      await postal.PostMessage({
        target: actor,
        type: "SETMOTIONPROBE",
        payload: { enabled: false },
      }, true);
      await postal.PostMessage({ target: actor, type: "STOPOVERLAYRENDERER", payload: null }, true);
      await postal.shutdown(actor);
    }
    await native("SETCONTROLLERMOTION", original.config);
    postal.detachProxy(driver);
  }
}
