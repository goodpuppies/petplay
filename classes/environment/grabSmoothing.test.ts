import { assert, assertEquals } from "@std/assert";
import * as THREE from "three";
import { applyLaserGrabSmoothing, laserGrabSmoothingAlpha } from "./grabSmoothing.ts";

Deno.test("laserGrabSmoothingAlpha returns 1 when amount is 0 and decreases monotonically with amount", () => {
  assertEquals(laserGrabSmoothingAlpha(0, 1 / 90), { position: 1, rotation: 1 });
  const subtle = laserGrabSmoothingAlpha(0.3, 1 / 90);
  const medium = laserGrabSmoothingAlpha(0.6, 1 / 90);
  const heavy = laserGrabSmoothingAlpha(1.0, 1 / 90);
  assert(subtle.position > medium.position && medium.position > heavy.position);
  assert(subtle.rotation > medium.rotation && medium.rotation > heavy.rotation);
  assert(heavy.position > 0 && subtle.position < 1);
});

Deno.test("applyLaserGrabSmoothing moves part-way toward the new pose without snapping", () => {
  const obj = new THREE.Object3D();
  const prevPos = new THREE.Vector3(0, 0, 0);
  const prevQuat = new THREE.Quaternion();
  obj.position.set(1, 0, 0);
  obj.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);

  applyLaserGrabSmoothing(obj, prevPos, prevQuat, 0.3, 1 / 90);
  assert(obj.position.x > 0.1 && obj.position.x < 0.7, `expected partial step, got ${obj.position.x}`);
  const angle = 2 * Math.acos(Math.min(1, Math.abs(prevQuat.dot(obj.quaternion))));
  assert(angle > 0.1 && angle < Math.PI / 2 - 0.1, `expected partial rotation, got ${angle}`);
});
