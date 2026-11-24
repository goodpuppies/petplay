import "../../submodules/threewebxrwebgpudeno/submodules/xr/packages/pointer-events/src/pointer.ts";
import { PetPlayHandleStore as HandleStore } from "./petplayHandleStore.tsx";
import * as THREE from "three/webgpu";
import type { PointerEvent as PenPointerEvent } from "@pmndrs/pointer-events";
import { cancelStaleHandleGrab } from "./grabbox.tsx";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function pointerEvent(
  type: "pointerdown" | "pointercancel",
  object: THREE.Object3D,
  pointerId = 42,
  handedness: "left" | "right" = "left",
) {
  return {
    type,
    pointerId,
    pointerType: "grab",
    pointerState: { inputSource: { handedness } },
    object,
    point: new THREE.Vector3(0, 0, 0),
    pointerPosition: new THREE.Vector3(0, 0, 1),
    pointerQuaternion: new THREE.Quaternion(),
    details: { type: "ray" },
    intersection: { details: { type: "ray" } },
    timeStamp: 1,
    stopPropagation() {},
  } as unknown as PenPointerEvent;
}

Deno.test("a cancelled controller pointer releases its active Handle grab", () => {
  const target = new THREE.Object3D();
  const handle = new THREE.Object3D();
  const store = new HandleStore(target);
  store.handlers.onPointerDown(pointerEvent("pointerdown", handle));
  assert(store.inputState.size === 1, "pointer down should start a grab");
  assert(store.capturedObjects.size === 1, "pointer should be captured");

  store.handlers.onPointerEnd(pointerEvent("pointercancel", handle));
  assert(Number(store.inputState.size) === 0, "controller cancellation should end the grab");
  assert(
    Number(store.capturedObjects.size) === 0,
    "controller cancellation should release capture",
  );
  assert(store.getState() == null, "no active Handle state should survive cancellation");
});

Deno.test("duplicate grab pointers from one hand cannot create false multitouch", () => {
  const target = new THREE.Object3D();
  const handle = new THREE.Object3D();
  const store = new HandleStore(target);

  store.handlers.onPointerDown(pointerEvent("pointerdown", handle, 1, "left"));
  store.handlers.onPointerDown(pointerEvent("pointerdown", handle, 2, "left"));
  assert(store.inputState.size === 1, "a replacement left device must not become a second hand");

  store.handlers.onPointerDown(pointerEvent("pointerdown", handle, 3, "right"));
  assert(
    Number(store.inputState.size) === 2,
    "the actual other hand should still enable multitouch",
  );
  store.cancel();
});

Deno.test("a grab whose pointer silently lost capture is cancelled", () => {
  const target = new THREE.Object3D();
  const handle = new THREE.Object3D();
  let captured = true;
  handle.hasPointerCapture = () => captured;
  const store = new HandleStore(target);
  store.handlers.onPointerDown(pointerEvent("pointerdown", handle));
  assert(!cancelStaleHandleGrab(store), "a held grab must survive the check");
  assert(store.inputState.size === 1, "the held grab should still be active");

  // The pointer was disabled mid-grab, so no pointerup will ever reach the store.
  captured = false;
  assert(cancelStaleHandleGrab(store), "the stale grab should be detected");
  assert(Number(store.inputState.size) === 0, "the stale grab should end");
  assert(Number(store.capturedObjects.size) === 0, "the stale capture should be dropped");
});
