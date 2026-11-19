import * as THREE from "three";
import { getPointerById } from "../submodules/threewebxrwebgpudeno/submodules/xr/packages/pointer-events/src/pointer.ts";
import { createViewRemotePointer } from "./viewRemotePointer.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
// Same capture support the production scene installs for Deno's Object3D instance.
const proto = THREE.Object3D.prototype as THREE.Object3D & {
  setPointerCapture(id: number): void;
  releasePointerCapture(id: number): void;
  hasPointerCapture(id: number): boolean;
};
proto.setPointerCapture = function (id) {
  getPointerById(id)?.setCapture(this as never);
};
proto.releasePointerCapture = function (id) {
  const pointer = getPointerById(id);
  if (pointer?.hasCaptured(this as never)) pointer.setCapture(undefined);
};
proto.hasPointerCapture = function (id) {
  return getPointerById(id)?.hasCaptured(this as never) ?? false;
};

const lens = new THREE.PerspectiveCamera(70, 1.6, 0.01, 200);
lens.position.set(0, 0, 3);
lens.updateMatrixWorld();
const camera = { matrixWorld: lens.matrixWorld.toArray(), projection: lens.projectionMatrix.toArray() };

type View = ReturnType<typeof createViewRemotePointer>;

/** Drags in `view`; every view in `all` updates each frame, as the stream server does. */
function drag(view: View, all: View[], button: number, y = 0.5) {
  const frame = () => all.forEach((v) => v.update());
  let sequence = 0;
  const send = (type: string, x: number, buttons: number, pressed: number) =>
    view.receive({
      version: 1,
      viewport: "scene-view",
      sequence: sequence++,
      type,
      pointerId: 1,
      pointerType: "mouse",
      x,
      y,
      button: pressed,
      buttons,
      camera,
    });
  const held = 1 << (button === 2 ? 1 : 0);
  send("pointermove", 0.5, 0, -1);
  send("pointerdown", 0.5, held, button);
  for (let i = 1; i <= 4; i++) {
    send("pointermove", 0.5 + i * 0.05, held, -1);
    frame();
  }
  send("pointerup", 0.7, 0, button);
  frame();
}

function setup() {
  const scene = new THREE.Scene();
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), new THREE.MeshBasicMaterial());
  scene.add(panel); // at the centre of the view; the left side of the screen is empty space
  scene.updateMatrixWorld(true);
  const a = createViewRemotePointer(scene, "a");
  const b = createViewRemotePointer(scene, "b");
  for (const view of [a, b]) {
    view.aim([0, 0, 3], [0, 0, 0]);
    view.update();
    view.takeViewMatrix();
  }
  return { scene, panel, a, b };
}

Deno.test("a view's drag on empty space navigates that view only", () => {
  const { a, b } = setup();
  drag(a, [a, b], 2, 0.1);
  assert(a.takeViewMatrix(), "right drag on empty space should orbit view a");
  assert(b.takeViewMatrix() === null, "view b must not follow view a's pointer");
  drag(b, [a, b], 0, 0.1);
  assert(b.takeViewMatrix(), "left drag on empty space should pan view b");
  assert(a.takeViewMatrix() === null, "view a must not follow view b's pointer");
  a.destroy();
  b.destroy();
});

Deno.test("a drag that starts on scene content is interaction, not navigation", () => {
  const { panel, a, b } = setup();
  let downs = 0;
  panel.addEventListener("pointerdown" as never, () => downs++);
  drag(a, [a, b], 0);
  assert(downs === 1, `panel should get the press, got ${downs}`);
  assert(a.takeViewMatrix() === null, "a drag starting on the panel must not pan");
  a.destroy();
  b.destroy();
});
