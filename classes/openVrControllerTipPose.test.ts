import { composeMatrix34, composeTrackedDeviceTipPose } from "./openVrControllerTipPose.ts";

function assertNear(actual: number, expected: number, epsilon = 1e-6): void {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(`Expected ${expected}, got ${actual}`);
  }
}

Deno.test("composeMatrix34 rotates and translates a component into world space", () => {
  const result = composeMatrix34(
    [[0, -1, 0, 1], [1, 0, 0, 2], [0, 0, 1, 3]],
    [[1, 0, 0, 0.1], [0, 1, 0, 0.2], [0, 0, 1, 0.3]],
  );
  assertNear(result[0][3], 0.8);
  assertNear(result[1][3], 2.1);
  assertNear(result[2][3], 3.3);
});

Deno.test("composeTrackedDeviceTipPose emits a column-major matrix and quaternion", () => {
  const pose = composeTrackedDeviceTipPose(
    {
      matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1]),
      position: [4, 5, 6],
      quaternion: [0, 0, 0, 1],
    },
    [[1, 0, 0, 0.1], [0, 0, -1, 0.2], [0, 1, 0, 0.3]],
  );
  assertNear(pose.position[0], 4.1);
  assertNear(pose.position[1], 5.2);
  assertNear(pose.position[2], 6.3);
  assertNear(pose.matrix[12], 4.1);
  assertNear(pose.matrix[13], 5.2);
  assertNear(pose.matrix[14], 6.3);
  assertNear(Math.abs(pose.quaternion[0]), Math.SQRT1_2);
  assertNear(pose.quaternion[1], 0);
  assertNear(pose.quaternion[2], 0);
  assertNear(Math.abs(pose.quaternion[3]), Math.SQRT1_2);
});
