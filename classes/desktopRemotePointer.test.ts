import { createSteamVrRemotePointer } from "./steamVrRemotePointer.ts";
import * as THREE from "three";
import { defaultApply, HandleStore, TransformHandles } from "@pmndrs/handle";
import { forwardHtmlEvents } from "@pmndrs/pointer-events";
import { getPointerById } from "../submodules/threewebxrwebgpudeno/submodules/xr/packages/pointer-events/src/pointer.ts";
import { installSyntheticDomEventPolyfills, SyntheticCanvas } from "./desktopPointerSurface.ts";
import { type DesktopPointerMessage, DesktopRemotePointer } from "./desktopRemotePointer.ts";
import {
  type ControllerPose,
  ControllerPoseWriter,
  controllerTrackingPose,
} from "./openVrControllerControl.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
installSyntheticDomEventPolyfills();
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
function setup() {
  const surface = new SyntheticCanvas(1000, 600, "[pointer-test]");
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1000 / 600, .01, 100);
  camera.position.set(0, 0, 3);
  camera.updateMatrixWorld();
  const bridge = forwardHtmlEvents(surface as never, camera, scene, { batchEvents: false });
  const remote = new DesktopRemotePointer(surface);
  let sequence = 0;
  function event(type: DesktopPointerMessage["type"], x: number, y: number, buttons = 0) {
    remote.receive({
      version: 1,
      viewport: "desktop-control",
      sequence: ++sequence,
      type,
      pointerId: 1,
      pointerType: "mouse",
      x,
      y,
      button: type === "pointermove" ? -1 : 0,
      buttons,
    });
    bridge.update();
  }
  return { surface, scene, camera, bridge, remote, event };
}
Deno.test("remote viewport coordinates raycast, drag a pmndrs handle, and cancel capture on disconnect", () => {
  const s = setup();
  const target = new THREE.Mesh(new THREE.BoxGeometry(.5, .5, .5), new THREE.MeshBasicMaterial());
  s.scene.add(target);
  s.scene.updateMatrixWorld(true);
  const store = new HandleStore(target, () => ({ rotate: false, scale: false }));
  const unbind = store.bind(target);
  try {
    s.event("pointermove", .5, .5);
    s.event("pointerdown", .5, .5, 1);
    assert(store.inputState.size === 1, "raw down should raycast and start a handle grab in Deno");
    s.event("pointermove", .62, .5, 1);
    store.update(.1);
    assert(target.position.x > .2, "camera ray movement must move the handle");
    s.remote.cancel();
    assert(
      Number(store.inputState.size) === 0 && store.capturedObjects.size === 0,
      "disconnect must cancel the drag and release pmndrs capture",
    );
    const x = target.position.x;
    s.event("pointermove", .8, .5, 0);
    store.update(.2);
    assert(target.position.x === x, "a reconnected hover cannot continue the previous drag");
  } finally {
    unbind();
    s.bridge.destroy();
    target.geometry.dispose();
    (target.material as THREE.Material).dispose();
  }
});
Deno.test("raw remote input drives a real pmndrs translation gizmo and emits tracking-space poses", async () => {
  const s = setup();
  const sent: ControllerPose[] = [];
  const writer = new ControllerPoseWriter(async (_hand, pose) => {
    sent.push(pose);
  });
  const gizmo = new TransformHandles(() => ({
    apply: (state, target) => {
      defaultApply(state, target);
      void writer.set("right", controllerTrackingPose(target));
    },
  }));
  s.scene.add(gizmo);
  const unbind = gizmo.bind("translate", "x");
  s.scene.updateMatrixWorld(true);
  gizmo.update(0, s.camera);
  s.scene.updateMatrixWorld(true);
  try {
    const point = new THREE.Vector3(.3, 0, 0).project(s.camera);
    const x = (point.x + 1) / 2;
    s.event("pointermove", x, .5);
    s.event("pointerdown", x, .5, 1);
    s.event("pointermove", x + .1, .5, 1);
    gizmo.update(.1, s.camera);
    s.event("pointerup", x + .1, .5);
    gizmo.update(.2, s.camera);
    await Promise.resolve();
    await Promise.resolve();
    assert(gizmo.position.x > .15, "axis gizmo must respond to browser pointer coordinates");
    assert(
      sent.some((p) => p.position[0] > .15),
      "gizmo must publish a translated raw tracking pose",
    );
    assert(
      Math.abs(gizmo.position.y) < 1e-6 && Math.abs(gizmo.position.z) < 1e-6,
      "x handle must constrain the other axes",
    );
  } finally {
    s.remote.cancel();
    unbind();
    s.bridge.destroy();
  }
});
Deno.test("input sessions reject wrong views and replayed input and keep pointer identities separate", () => {
  const surface = new SyntheticCanvas(100, 100, "[pointer-test]");
  const a = new DesktopRemotePointer(surface), b = new DesktopRemotePointer(surface);
  const ids: number[] = [];
  surface.addEventListener(
    "pointerdown",
    (e) => ids.push((e as unknown as { pointerId: number }).pointerId),
  );
  const message = {
    version: 1,
    viewport: "desktop-control",
    sequence: 1,
    type: "pointerdown",
    pointerId: 1,
    pointerType: "mouse",
    x: .5,
    y: .5,
    button: 0,
    buttons: 1,
  };
  a.receive(message);
  b.receive(message);
  assert(
    ids.length === 2 && ids[0] !== ids[1] && ids[0] !== 1,
    "remote and local pointers must not collide",
  );
  for (const invalid of [{ ...message, viewport: "stereo" }, { ...message, x: NaN }, message]) {
    let rejected = false;
    try {
      a.receive(invalid);
    } catch {
      rejected = true;
    }
    assert(rejected, "invalid or replayed pointer packet must be rejected");
  }
  a.cancel();
  b.cancel();
});
Deno.test("tracking poses remove a translated and rotated origin and reject scaled controller transforms", () => {
  const origin = new THREE.Group();
  origin.position.set(2, 3, 4);
  origin.rotation.y = .7;
  const target = new THREE.Object3D();
  target.position.set(.2, 1, -.5);
  target.rotation.x = .2;
  origin.add(target);
  origin.updateMatrixWorld(true);
  const pose = controllerTrackingPose(target, origin.matrixWorld);
  assert(
    new THREE.Vector3(...pose.position).distanceTo(target.position) < 1e-6,
    "tracking origin must be removed",
  );
  assert(
    Math.abs(new THREE.Quaternion(...pose.rotation).dot(target.quaternion)) > 1 - 1e-6,
    "tracking rotation must be removed",
  );
  target.scale.x = 2;
  let rejected = false;
  try {
    controllerTrackingPose(target, origin.matrixWorld);
  } catch {
    rejected = true;
  }
  assert(rejected, "scale cannot be sent as an OpenVR pose");
});
Deno.test("pose writer bounds pending motion and preserves the final pose while the driver is slow", async () => {
  const sent: ControllerPose[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((r) => release = r);
  const writer = new ControllerPoseWriter(async (_hand, pose) => {
    sent.push(pose);
    if (sent.length === 1) await blocked;
  });
  const pose = (x: number): ControllerPose => ({ position: [x, 0, 0], rotation: [0, 0, 0, 1] });
  const completion = writer.set("right", pose(1));
  for (let x = 2; x <= 100; x++) void writer.set("right", pose(x));
  assert(sent.length === 1, "only one driver request may be in flight");
  release();
  await completion;
  assert(
    Number(sent.length) === 2 && sent[1].position[0] === 100,
    "intermediate motion should coalesce but the final pose must arrive",
  );
});

Deno.test("SteamVR stream input selects the rendered eye and keeps capture when a drag crosses the stereo seam", () => {
  const scene = new THREE.Scene();
  const left = new THREE.PerspectiveCamera(60, 1, .01, 100);
  left.position.set(-1, 0, 3);
  left.updateMatrixWorld();
  const right = left.clone();
  right.position.x = 1;
  right.updateMatrixWorld();
  const target = new THREE.Mesh(new THREE.BoxGeometry(.4, .4, .4), new THREE.MeshBasicMaterial());
  scene.add(target);
  scene.updateMatrixWorld(true);
  const store = new HandleStore(target, () => ({ scale: false, rotate: false }));
  const unbind = store.bind(target);
  const input = createSteamVrRemotePointer(() => ({ scene, leftCamera: left, rightCamera: right }));
  let seq = 0;
  const cameras: number[] = [];
  target.addEventListener(
    "pointerdown" as never,
    ((event: { pointerPosition: THREE.Vector3 }) => cameras.push(event.pointerPosition.x)) as never,
  );
  const event = (type: string, x: number, buttons: number) =>
    input.receive({
      version: 1,
      viewport: "steamvr-stereo",
      sequence: ++seq,
      type,
      pointerId: 4,
      pointerType: "mouse",
      x,
      y: .5,
      button: type === "pointermove" ? -1 : 0,
      buttons,
    });
  try {
    const l = new THREE.Vector3().project(left);
    event("pointermove", (l.x + 1) / 4, 0);
    event("pointerdown", (l.x + 1) / 4, 1);
    assert(store.inputState.size === 1, "left half must hit the mesh using the left camera");
    event("pointermove", .55, 1);
    store.update(.1);
    assert(
      store.inputState.size === 1,
      "crossing the stereo seam must preserve the original eye capture",
    );
    input.cancel();
    assert(Number(store.inputState.size) === 0, "blur must cancel the stereo drag");
    target.position.set(0, 0, 0);
    target.updateMatrixWorld(true);
    const r = new THREE.Vector3().project(right);
    event("pointermove", .5 + (r.x + 1) / 4, 0);
    event("pointerdown", .5 + (r.x + 1) / 4, 1);
    assert(store.inputState.size === 1, "input must still work after cancellation");
    assert(
      cameras.length === 2 && cameras[0] === -1 && cameras[1] === 1,
      "each eye must use its own rendered camera origin",
    );
  } finally {
    input.destroy();
    unbind();
    target.geometry.dispose();
    (target.material as THREE.Material).dispose();
  }
});
