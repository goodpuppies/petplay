import * as THREE from "three";
import { updateCompositorInputCamera } from "./compositorInputCamera.ts";

Deno.test("stream picking uses the compositor lens when an overlay is rendered with a wider FOV", () => {
  const render = new THREE.PerspectiveCamera(112, 1, .1, 1000);
  render.position.set(.032, 1.6, 0);
  render.updateMatrixWorld();
  const display = new THREE.PerspectiveCamera(90, 1, .1, 1000);
  display.position.copy(render.position);
  display.updateMatrixWorld();
  const input = updateCompositorInputCamera(
    new THREE.PerspectiveCamera(),
    render,
    display.projectionMatrix,
  );
  const target = new THREE.Vector3(.25, 1.4, -.9);
  const pixel = target.clone().project(display);
  const coords = new THREE.Vector2(pixel.x, pixel.y);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(coords, input);
  if (ray.ray.distanceToPoint(target) > 1e-6) {
    throw Error("input ray must pass through the visible display pixel");
  }
  ray.setFromCamera(coords, render);
  if (ray.ray.distanceToPoint(target) < .03) {
    throw Error("fixture must expose the old render/display projection mismatch");
  }
  render.position.set(-.2, 1.7, .1);
  render.rotation.y = .2;
  render.updateMatrixWorld();
  updateCompositorInputCamera(input, render, display.projectionMatrix);
  if (!input.matrixWorld.equals(render.matrixWorld)) {
    throw Error("input must retain the current eye pose");
  }
  if (!input.projectionMatrix.equals(display.projectionMatrix)) {
    throw Error("eye movement must not replace the compositor lens");
  }
});
