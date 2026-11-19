import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import * as THREE from "npm:three@0.186.1";
import { dragAction, ViewCameraController, wheelNavigates } from "./viewControls.ts";

Deno.test("bindings: left interacts, right orbits, middle and shift+right pan", () => {
  assertEquals(dragAction(0, false), "scene");
  assertEquals(dragAction(0, true), "scene");
  assertEquals(dragAction(2, false), "orbit");
  assertEquals(dragAction(2, true), "pan");
  assertEquals(dragAction(1, false), "pan");
  assertEquals(wheelNavigates(false, false), false);
  assertEquals(wheelNavigates(true, false), true);
});

Deno.test("frame puts the camera at target + facing × distance, looking at the target", () => {
  const camera = new THREE.PerspectiveCamera();
  camera.matrixAutoUpdate = false;
  const controller = new ViewCameraController(camera);
  const center = new THREE.Vector3(1, 2, -3);
  const facing = new THREE.Vector3(0.3, 0.4, -0.5).normalize();
  controller.frame(center, facing, 2);
  controller.apply(undefined);
  const position = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  const expected = center.clone().addScaledVector(facing, 2);
  for (const axis of ["x", "y", "z"] as const) assertAlmostEquals(position[axis], expected[axis], 1e-9);
  const forward = new THREE.Vector3(0, 0, -1).transformDirection(camera.matrixWorld);
  assertAlmostEquals(forward.dot(facing), -1, 1e-9);
});

Deno.test("head mode follows the pose; leaving it keeps the view", () => {
  const camera = new THREE.PerspectiveCamera();
  camera.matrixAutoUpdate = false;
  const controller = new ViewCameraController(camera);
  const head = new THREE.Matrix4().compose(
    new THREE.Vector3(0, 1.6, 0),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.7, 0)),
    new THREE.Vector3(1, 1, 1),
  );
  controller.mode = "head";
  controller.apply(head);
  assertEquals(camera.matrixWorld.toArray(), head.toArray());
  controller.freeFrom(head);
  controller.apply(head);
  const position = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  assertAlmostEquals(position.distanceTo(new THREE.Vector3(0, 1.6, 0)), 0, 1e-9);
});
