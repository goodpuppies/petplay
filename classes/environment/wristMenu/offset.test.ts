import { assertEquals } from "@std/assert";
import * as THREE from "three";
import { isWristOffset, type WristOffset, wristOffsetForHand } from "./offset.ts";

Deno.test("wrist offset validation", () => {
  assertEquals(isWristOffset({ position: [0, 0.1, 0], rotation: [0, 0, 0, 1] }), true);
  assertEquals(isWristOffset({ position: [0, 0.1], rotation: [0, 0, 0, 1] }), false);
  assertEquals(isWristOffset({ position: [0, NaN, 0], rotation: [0, 0, 0, 1] }), false);
  assertEquals(isWristOffset(null), false);
});

Deno.test("left-hand offset is the right one reflected across YZ", () => {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.5, -0.2));
  const right: WristOffset = { position: [0.1, 0.2, 0.05], rotation: [q.x, q.y, q.z, q.w] };
  const left = wristOffsetForHand(right, "left");
  // Reflecting the posed object's +Y axis must equal posing it with the mirrored offset.
  const mirror = new THREE.Matrix4().makeScale(-1, 1, 1);
  const pose = (o: WristOffset) =>
    new THREE.Matrix4().compose(
      new THREE.Vector3(...o.position),
      new THREE.Quaternion(...o.rotation),
      new THREE.Vector3(1, 1, 1),
    );
  const expected = mirror.clone().multiply(pose(right)).multiply(mirror);
  const actual = pose(left);
  for (let i = 0; i < 16; i++) {
    assertEquals(Math.abs(actual.elements[i] - expected.elements[i]) < 1e-9, true, `element ${i}`);
  }
  assertEquals(wristOffsetForHand(left, "left"), right);
  assertEquals(wristOffsetForHand(right, "right"), right);
});
