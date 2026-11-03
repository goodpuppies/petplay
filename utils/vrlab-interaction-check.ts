/** Bounded native input/presentation-path smoke. Run only against a scoped synthetic lab. */
import * as THREE from "three";
import { join } from "@std/path";
import { NativeInteractionRig, queryScene, wristSnapshot } from "./vrlab/interaction.ts";
import { type Vec3 } from "./vrlab/driver.ts";
import { setDashboard } from "./vrlab/steamvr.ts";
import { sleep, waitFor } from "./vrlab/util.ts";
import { WRIST_MAIN } from "./playtest.ts";

const output = Deno.args.find((a) => a.startsWith("--output="))?.slice(9) ??
  join(Deno.cwd(), "_scratch", "perf", `native-interactions-${Date.now()}.json`);
const phaseFile = Deno.args.find((a) => a.startsWith("--phase-file="))?.slice(13);
const revealRepeats = Number(
  Deno.args.find((a) => a.startsWith("--reveal-repeats="))?.slice(17) ?? 1,
);
if (!Number.isInteger(revealRepeats) || revealRepeats < 1 || revealRepeats > 10) {
  throw Error("reveal-repeats must be an integer from 1 to 10");
}
const results: {
  name: string;
  ok: boolean;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  detail?: unknown;
  error?: string;
}[] = [];
async function step(name: string, run: () => Promise<unknown>) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  if (phaseFile) {
    await Deno.writeTextFile(
      phaseFile,
      JSON.stringify({ phase: name, startedAt, processId: Deno.pid }),
    );
  }
  try {
    const detail = await run();
    results.push({
      name,
      ok: true,
      startedAt,
      endedAt: new Date().toISOString(),
      elapsedMs: performance.now() - started,
      detail,
    });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({
      name,
      ok: false,
      startedAt,
      endedAt: new Date().toISOString(),
      elapsedMs: performance.now() - started,
      error: String(error),
    });
    throw error;
  }
}
const layerVisible = () =>
  queryScene<boolean>(
    `const m=await import(new URL('../classes/environment/windowLayerMode.ts',moduleUrl).href);return m.getWindowLayerVisible();`,
  );
const initiallyVisible = await layerVisible();
const rig = await NativeInteractionRig.attach();
let runError: unknown;
const display = () =>
  queryScene<
    { id: string; position: Vec3; rotation: [number, number, number, number]; scale: Vec3 }
  >(`const {getSpatialGraph}=await import(new URL('../classes/environment/workspaceLayoutStore.ts',moduleUrl).href);const node=Object.values(getSpatialGraph()?.nodes??{}).find(n=>n.kind==='display'&&n.parentId==null);if(!node)throw Error('No root display');let found=null;host.rootStore.getState().scene.traverse(n=>{if(!found&&n.userData?.spatialElementId===node.id)found=n;});if(!found)throw Error('Display not mounted');found.updateWorldMatrix(true,true);const p=new THREE.Vector3(),q=new THREE.Quaternion(),s=new THREE.Vector3();found.matrixWorld.decompose(p,q,s);return {id:node.id,position:p.toArray(),rotation:q.toArray(),scale:s.toArray()};`);
try {
  await setDashboard(rig.driver, false);
  await step("calibrate-native-rays", async () => {
    await rig.calibrateRay("left");
    await rig.calibrateRay("right");
    await rig.faceWrist();
  });
  // Return a previous diagnostic's open menu to home through real pointer clicks.
  for (let i = 0; i < 3 && (await wristSnapshot()).texts.includes("BACK"); i++) {
    await rig.clickWristText("BACK");
  }
  await step("open-settings", async () => {
    await rig.clickWristPoint(WRIST_MAIN.settings);
    await rig.expectText("SETTINGS");
  });
  for (
    const [tile, title] of [["WRIST", "WRIST MENU"], ["SCREENS", "MONITORS"], [
      "LAYOUTS",
      "LAYOUTS",
    ], ["CAMERA", "VRC CAMERA"]]
  ) {
    await step(`menu-${tile.toLowerCase()}`, async () => {
      await rig.clickWristText(tile!);
      await rig.expectText(title!);
      const snapshot = await wristSnapshot();
      await rig.clickWristText("BACK");
      await rig.expectText("SETTINGS");
      return snapshot.texts;
    });
  }
  await rig.clickWristText("BACK");
  await step("show-display", async () => {
    if (!await layerVisible()) await rig.clickWristPoint(WRIST_MAIN.layout);
    await waitFor("visible window layer", layerVisible, 3000, 100);
    return await display();
  });
  for (let repeat = 2; repeat <= revealRepeats; repeat++) {
    await sleep(1500);
    await step(`hide-display-${repeat}`, async () => {
      await rig.clickWristPoint(WRIST_MAIN.layout);
      await waitFor("hidden window layer", async () => !await layerVisible(), 3000, 100);
    });
    await sleep(1500);
    await step(`show-display-${repeat}`, async () => {
      await rig.clickWristPoint(WRIST_MAIN.layout);
      await waitFor("visible window layer", layerVisible, 3000, 100);
      return await display();
    });
  }
  await step("laser-drag-and-return", async () => {
    const before = await display();
    const start = new THREE.Vector3().fromArray(before.position);
    const origin = new THREE.Vector3(-.25, 1.4, .1);
    await rig.aim("left", before.position, origin.toArray() as Vec3);
    await rig.driver.setInput("left", { grip: 1 });
    await sleep(150);
    for (let i = 1; i <= 20; i++) {
      const shift = new THREE.Vector3(.25 * i / 20, 0, 0);
      await rig.aim(
        "left",
        start.clone().add(shift).toArray() as Vec3,
        origin.clone().add(shift).toArray() as Vec3,
      );
    }
    const moved = await display();
    const displacement = new THREE.Vector3().fromArray(moved.position).distanceTo(start);
    if (displacement < .15) throw Error(`Drag failed: moved only ${displacement} m`);
    for (let i = 19; i >= 0; i--) {
      const shift = new THREE.Vector3(.25 * i / 20, 0, 0);
      await rig.aim(
        "left",
        start.clone().add(shift).toArray() as Vec3,
        origin.clone().add(shift).toArray() as Vec3,
      );
    }
    await rig.driver.setInput("left", {});
    await sleep(200);
    const after = await display();
    const error = new THREE.Vector3().fromArray(after.position).distanceTo(start);
    if (error > .03) throw Error(`Drag return error ${error} m`);
    return { before, moved, after, displacement, returnErrorMeters: error };
  });
  await step("two-hand-scale-and-return", async () => {
    const before = await display(),
      center = new THREE.Vector3().fromArray(before.position),
      right = new THREE.Vector3(1, 0, 0).applyQuaternion(
        new THREE.Quaternion().fromArray(before.rotation),
      );
    const at = (x: number) => center.clone().addScaledVector(right, x).toArray() as Vec3;
    const aim = async (spread: number) => {
      await rig.aim("left", at(-spread), [-.25, 1.4, .1]);
      await rig.aim("right", at(spread), [.25, 1.4, .1]);
    };
    await aim(.1);
    await rig.driver.setInput("left", { grip: 1 });
    await rig.driver.setInput("right", { grip: 1 });
    await sleep(200);
    for (let i = 1; i <= 10; i++) await aim(.1 + .05 * i / 10);
    const enlarged = await display();
    if (enlarged.scale[0] < before.scale[0] * 1.2) {
      throw Error(`Scale did not increase: ${before.scale[0]} -> ${enlarged.scale[0]}`);
    }
    for (let i = 9; i >= 0; i--) await aim(.1 + .05 * i / 10);
    await rig.driver.setInput("left", {});
    await rig.driver.setInput("right", {});
    await sleep(200);
    const after = await display();
    if (Math.abs(after.scale[0] / before.scale[0] - 1) > .05) {
      throw Error("Scale did not return to its initial size");
    }
    return { before, enlarged, after };
  });
} catch (error) {
  runError = error;
  throw error;
} finally {
  const cleanupErrors: unknown[] = [];
  try {
    await rig.driver.setInput("left", {});
    await rig.driver.setInput("right", {});
    await rig.faceWrist();
    for (let i = 0; i < 3 && (await wristSnapshot()).texts.includes("BACK"); i++) {
      await rig.clickWristText("BACK");
    }
    if (await layerVisible() !== initiallyVisible) await rig.clickWristPoint(WRIST_MAIN.layout);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await rig.restore();
  } catch (error) {
    cleanupErrors.push(error);
  }
  await Deno.mkdir(join(output, ".."), { recursive: true });
  await Deno.writeTextFile(
    output,
    JSON.stringify(
      {
        kind: "native-interaction-functional-check",
        presentedPixelsVerified: false,
        note:
          "Checks native input and visible scene state; separate pixel/freshness and performance verification still required",
        runError: runError == null ? null : String(runError),
        cleanupErrors: cleanupErrors.map(String),
        results,
      },
      null,
      2,
    ),
  );
  if (runError === undefined && cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, "Native interaction cleanup failed");
  }
}
