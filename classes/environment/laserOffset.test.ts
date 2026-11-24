import { assertEquals } from "@std/assert";
import * as THREE from "three/webgpu";
import {
  applyLaserOffset,
  getLaserOffset,
  LASER_OFFSET_MAX_DISTANCE,
  laserOffsetKey,
  laserOffsetMatrix,
  mirrorLaserOffset,
  mirrorPoseOffset,
  resetLaserOffset,
  saveLaserOffset,
  setLaserControllerModel,
  setLiveLaserOffset,
} from "./laserOffset.ts";
import { getSetting } from "../settings.ts";

const tilted = {
  position: [0, 0.01, -0.02] as [number, number, number],
  rotation: [Math.sin(-0.2), 0, 0, Math.cos(-0.2)] as [number, number, number, number],
};

Deno.test("offsets are kept per controller model and per hand", () => {
  setLaserControllerModel("left", "valve_controller_knu_1_0_left");
  setLaserControllerModel("right", "oculus_quest2_controller_right");
  saveLaserOffset("left", tilted);
  assertEquals(getLaserOffset("left"), tilted);
  assertEquals(getLaserOffset("right"), null, "the other hand keeps its own");
  assertEquals(
    Object.keys(getSetting("laserOffsets")),
    ["valve_controller_knu_1_0_left/left"],
  );
  // Another controller on the same hand starts from its own tip.
  setLaserControllerModel("left", "oculus_quest2_controller_left");
  assertEquals(getLaserOffset("left"), null);
  setLaserControllerModel("left", "valve_controller_knu_1_0_left");
  assertEquals(getLaserOffset("left"), tilted);
  resetLaserOffset("left");
  assertEquals(getLaserOffset("left"), null);
  assertEquals(getSetting("laserOffsets"), {});
});

Deno.test("a drag shows live and only saving persists it", () => {
  setLaserControllerModel("right", "model");
  setLiveLaserOffset("right", tilted);
  assertEquals(getLaserOffset("right"), tilted);
  assertEquals(getSetting("laserOffsets")[laserOffsetKey("right")], undefined);
  saveLaserOffset("right", tilted);
  assertEquals(getSetting("laserOffsets")[laserOffsetKey("right")], tilted);
  resetLaserOffset("right");
});

Deno.test("no offset leaves the laser on the tip", () => {
  setLaserControllerModel("right", "fresh");
  const object = new THREE.Object3D();
  object.position.set(1, 2, 3);
  applyLaserOffset(object, "right");
  assertEquals(object.position.toArray(), [0, 0, 0]);
  assertEquals(laserOffsetMatrix("right", new THREE.Matrix4()).equals(new THREE.Matrix4()), true);
});

Deno.test("the matrix places the laser at the saved pose", () => {
  setLaserControllerModel("left", "m");
  saveLaserOffset("left", tilted);
  const m = laserOffsetMatrix("left", new THREE.Matrix4());
  const origin = new THREE.Vector3().setFromMatrixPosition(m);
  assertEquals(origin.toArray().map((v) => Math.round(v * 1e6) / 1e6), [0, 0.01, -0.02]);
  resetLaserOffset("left");
});

Deno.test("mirror copies one laser onto the other hand once", () => {
  setLaserControllerModel("left", "touch_left");
  setLaserControllerModel("right", "touch_right");
  saveLaserOffset("left", tilted);
  mirrorLaserOffset("left");
  assertEquals(getLaserOffset("right"), mirrorPoseOffset(tilted));
  assertEquals(mirrorPoseOffset(mirrorPoseOffset(tilted)), tilted, "mirroring twice is identity");
  // Afterwards the hands are independent again.
  resetLaserOffset("left");
  assertEquals(getLaserOffset("right"), mirrorPoseOffset(tilted));
  // Mirroring a laser on its tip puts the other back on its tip too.
  mirrorLaserOffset("left");
  assertEquals(getLaserOffset("right"), null);
});

Deno.test("a laser stays near its controller", () => {
  setLaserControllerModel("right", "far");
  saveLaserOffset("right", { position: [0, 0, -2], rotation: [0, 0, 0, 1] });
  const offset = getLaserOffset("right")!;
  assertEquals(offset.position.map((v) => Math.round(v * 1e6) / 1e6), [
    0,
    0,
    -LASER_OFFSET_MAX_DISTANCE,
  ]);
  resetLaserOffset("right");
});
