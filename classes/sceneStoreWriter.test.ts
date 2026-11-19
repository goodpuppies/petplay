import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import * as THREE from "three";
import type { ExtractionResult } from "../submodules/raythree/src/lib.ts";
import type { VideoSurfaceData } from "../submodules/raythree/src/store/mod.ts";
import { glyphQuads, nodeClip, PetplaySceneStoreWriter, type VideoSurfaceMarker } from "./sceneStoreWriter.ts";

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

const emptyExtraction = {
  assets: { geometries: [], materials: [], textures: [] },
  frame: { camera: {} as never, lights: [], instances: [] },
  warnings: [],
} as unknown as ExtractionResult;

Deno.test("displays become videoSurface items with their geometry, and leave with them", () => {
  const writer = new PetplaySceneStoreWriter();
  const store = writer.store;
  const scene = new THREE.Scene();
  const display = new THREE.Group();
  display.position.set(0.5, 1.2, -1);
  const marker: VideoSurfaceMarker = {
    feed: "desktop",
    geometry: new THREE.PlaneGeometry(1.6, 0.9),
    crop: { x: 0.5, y: 0, width: 0.5, height: 1 },
    opacity: 1,
  };
  display.add(Object.assign(new THREE.Group(), { userData: { videoSurface: marker } }));
  scene.add(display);
  scene.updateMatrixWorld(true);

  const surfaces = () =>
    [...store.ids("items")].map((id) => store.get("items", id)!).filter((item) => item.header.kind === "videoSurface");
  writer.write(emptyExtraction, undefined, scene);
  const [surface] = surfaces();
  assert(surface, "a marked display is written");
  const data = surface.data as VideoSurfaceData;
  assertEquals(data.feed, "desktop");
  assertEquals(data.crop, marker.crop);
  assertEquals(Array.from(surface.transform).slice(12, 15), [0.5, 1.2, -1]);
  const geometry = store.get("geometries", data.geometry);
  assert(geometry, "its surface geometry is in the store");
  assertEquals((geometry.data.attributes.uv.array as Float32Array).length, 8);

  // An unchanged frame commits nothing.
  const tick = store.tick;
  writer.write(emptyExtraction, undefined, scene);
  assertEquals(store.tick, tick);

  // Hidden (the window layer is hidden): gone, geometry too.
  display.visible = false;
  writer.write(emptyExtraction, undefined, scene);
  assertEquals(surfaces().length, 0);
  assert(!store.has("geometries", data.geometry), "the unused geometry is removed");
});
