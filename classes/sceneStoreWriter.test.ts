import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import * as THREE from "three";
import { glyphQuads, nodeClip } from "./sceneStoreWriter.ts";

Deno.test("clip planes in node space cut the same points as in world space", () => {
  const nodeWorld = new THREE.Matrix4().compose(
    new THREE.Vector3(0.3, 1.4, -0.5),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -1.1, 0.2)),
    new THREE.Vector3(1, 1, 1),
  );
  // Four arbitrary world planes (normal, offset).
  const world = new Float64Array([
    1, 0, 0, -0.2,
    0, -1, 0, 1.5,
    0.6, 0, 0.8, 0.1,
    0, 0.6, -0.8, 0.3,
  ]);
  const local = nodeClip(world, { nodeWorld })!;
  assert(local);
  for (const p of [[0.1, 0.2, 0.3], [-1, 2, 0.5], [0.4, -0.3, -2]]) {
    const y = new THREE.Vector4(p[0], p[1], p[2], 1);
    const x = y.clone().applyMatrix4(nodeWorld);
    for (let i = 0; i < 16; i += 4) {
      const inWorld = world[i]! * x.x + world[i + 1]! * x.y + world[i + 2]! * x.z + world[i + 3]!;
      const inNode = local[i]! * y.x + local[i + 1]! * y.y + local[i + 2]! * y.z + local[i + 3]!;
      assertAlmostEquals(inNode, inWorld, 1e-9);
    }
  }
});

Deno.test("uikit's no-clip planes become null", () => {
  const none = new Float32Array(16);
  for (let i = 0; i < 16; i += 4) none.set([-1, 0, 0, 9007199254740992], i);
  assertEquals(nodeClip(none, { nodeWorld: null }), null);
});

Deno.test("glyph quads take opposite corners and their UVs", () => {
  const positions = [3, -58, 3, 4, 51, 4, 51, -58];
  const uvs = [0.25, 0.75, 0.25, 0.5, 0.5, 0.5, 0.5, 0.75];
  assertEquals(Array.from(glyphQuads(positions, uvs)!), [3, -58, 51, 4, 0.25, 0.75, 0.5, 0.5]);
});
