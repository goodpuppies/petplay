import { assertEquals } from "@std/assert";
import * as THREE from "three";
import {
  classifyGeometryShape,
  PETPLAY_RENDER_PROPS_KEY,
  resolvePetplayRenderProps,
} from "./renderProps.ts";
import { playspaceFrame } from "./playspaceFrame.ts";

Deno.test("classifyGeometryShape: infers flat, beam, and box from local AABB + world scale", () => {
  const unitBox = {
    min: [-0.5, -0.5, -0.5] as [number, number, number],
    max: [0.5, 0.5, 0.5] as [number, number, number],
  };
  const unitCircle = {
    min: [-1, -1, 0] as [number, number, number],
    max: [1, 1, 0] as [number, number, number],
  };

  // Circle cursor dot scaled to 6 mm radius
  const dotMat = new THREE.Matrix4().makeScale(0.006, 0.006, 1).elements;
  const flat = classifyGeometryShape(unitCircle, dotMat);
  assertEquals(flat?.shape, "flat");
  assertEquals(flat?.extent, [1, 1, 0]);

  // Laser beam: unit box scaled to 2 mm thick × 1.2 m long
  const beamMat = new THREE.Matrix4().makeScale(0.002, 0.002, 1.2).elements;
  const beam = classifyGeometryShape(unitBox, beamMat);
  assertEquals(beam?.shape, "beam");
  assertEquals(beam?.extent, [0.5, 0.5, 0.5]);

  // Grab-box outline: 0.8 × 0.5 × 0.06 m merged box
  const grabBox = {
    min: [-0.401, -0.251, -0.031] as [number, number, number],
    max: [0.401, 0.251, 0.031] as [number, number, number],
  };
  const box = classifyGeometryShape(grabBox, new THREE.Matrix4().elements);
  assertEquals(box?.shape, "box");
  assertEquals(box?.center, [0, 0, 0]);
});

Deno.test("resolvePetplayRenderProps: merges ancestor props with descendant overrides", () => {
  const parent = new THREE.Group();
  parent.userData[PETPLAY_RENDER_PROPS_KEY] = {
    overlayRole: "panel",
    sortOrder: 0,
    nativeOverlay: true,
  };
  const child = new THREE.Mesh();
  child.userData[PETPLAY_RENDER_PROPS_KEY] = {
    nativeOverlay: false,
    dynamicOverlay: true,
  };
  parent.add(child);

  assertEquals(resolvePetplayRenderProps(child), {
    overlayRole: "panel",
    sortOrder: 0,
    nativeOverlay: false,
    dynamicOverlay: true,
  });
  assertEquals(resolvePetplayRenderProps(new THREE.Mesh()), undefined);
});

Deno.test("playspaceFrame.poseColumnMajorToRows34: converts identity and anchored poses", () => {
  playspaceFrame.setAnchor(null);
  const pose = new THREE.Matrix4().makeTranslation(1, 2, 3).elements;
  const out = new Float32Array(12);
  playspaceFrame.poseColumnMajorToRows34(pose, out);
  assertEquals(Array.from(out), [1, 0, 0, 1, 0, 1, 0, 2, 0, 0, 1, 3]);

  // Anchor offset by (+10, 0, 0) in raw space: PetPlay (1, 2, 3) -> Raw (11, 2, 3)
  playspaceFrame.setAnchor(new THREE.Matrix4().makeTranslation(10, 0, 0).elements);
  try {
    playspaceFrame.poseColumnMajorToRows34(pose, out);
    assertEquals(Array.from(out), [1, 0, 0, 11, 0, 1, 0, 2, 0, 0, 1, 3]);
  } finally {
    playspaceFrame.setAnchor(null);
  }
});
