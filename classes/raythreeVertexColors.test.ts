import { assertEquals } from "@std/assert";
import * as THREE from "three";
import { RaythreeExtractor } from "../submodules/raythree/src/extract.ts";

Deno.test("raythree carries standard Three vertex colours and the material opt-in", () => {
  const scene = new THREE.Scene();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([
      0,
      0,
      -1,
      1,
      0,
      -1,
      0,
      1,
      -1,
    ], 3),
  );
  geometry.setAttribute(
    "color",
    new THREE.Uint8BufferAttribute(
      [
        255,
        0,
        0,
        0,
        255,
        0,
        0,
        0,
        255,
      ],
      3,
      true,
    ),
  );
  const material = new THREE.MeshBasicMaterial({ vertexColors: true });
  scene.add(new THREE.Mesh(geometry, material));
  const extractor = new RaythreeExtractor();
  const first = extractor.extract(scene, new THREE.PerspectiveCamera());
  const color = first.assets.geometries[0].attributes.color;
  assertEquals(color.itemSize, 3);
  assertEquals(color.normalized, true);
  assertEquals(color.componentType, "Uint8Array");
  assertEquals(Array.from(color.array), [255, 0, 0, 0, 255, 0, 0, 0, 255]);
  assertEquals(first.assets.materials[0].vertexColors, true);

  material.vertexColors = false;
  material.needsUpdate = true;
  const second = extractor.extract(scene, new THREE.PerspectiveCamera());
  assertEquals(second.assets.materials[0].vertexColors, false);
  geometry.dispose();
  material.dispose();
});
