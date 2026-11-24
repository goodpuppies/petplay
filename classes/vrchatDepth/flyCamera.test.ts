import { assertAlmostEquals, assertEquals } from "@std/assert";
import { unityPoseToRightHanded, type VrcWorldCameraPose } from "../vrcCameraCalibration.ts";
import { cameraPoseFromWorld, stepFlyCamera } from "./flyCamera.ts";

Deno.test("fly camera converts captured world poses back to Unity OSC poses", () => {
  for (const yaw of [-150, 0, 75, 170]) {
    const expected: VrcWorldCameraPose = { position: [2, 1, -3], rotationDeg: [25, yaw, 10] };
    const actual = cameraPoseFromWorld(unityPoseToRightHanded(expected));
    assertEquals(actual.position, expected.position);
    actual.rotationDeg.forEach((v, i) => assertAlmostEquals(v, expected.rotationDeg[i], 1e-5));
  }
});

Deno.test("fly camera movement follows view direction, with bounded diagonal speed and frame gaps", () => {
  const pose: VrcWorldCameraPose = { position: [0, 0, 0], rotationDeg: [0, 90, 0] };
  const forward = stepFlyCamera(pose, { forward: 1 }, 0.1);
  assertAlmostEquals(forward.position[0], 0.3);
  assertAlmostEquals(forward.position[2], 0, 1e-8);
  const right = stepFlyCamera(pose, { right: 1 }, 0.1);
  assertAlmostEquals(right.position[2], -0.3);
  const diagonal = stepFlyCamera(pose, { forward: 1, right: 1, up: 1 }, 20);
  assertAlmostEquals(Math.hypot(...diagonal.position), 0.3);
  assertAlmostEquals(
    Math.hypot(...stepFlyCamera(pose, { forward: 1, fast: true }, 0.1).position),
    1.2,
  );
});

Deno.test("mouse look clamps pitch and makes positive mouse y look down", () => {
  const pose: VrcWorldCameraPose = { position: [0, 0, 0], rotationDeg: [0, 0, 0] };
  const looked = stepFlyCamera(pose, { mouseY: 100, mouseX: 100 }, 0);
  assertEquals(looked.rotationDeg, [15, 15, 0]);
  const down = stepFlyCamera(looked, { forward: 1 }, 0.1);
  assertAlmostEquals(down.position[1], -Math.sin(Math.PI / 12) * 0.3);
  assertEquals(stepFlyCamera(pose, { mouseY: 10000 }, 0).rotationDeg[0], 89);
});
