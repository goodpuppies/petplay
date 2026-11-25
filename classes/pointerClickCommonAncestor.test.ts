import { assertEquals } from "@std/assert";
import * as THREE from "three";
import { Pointer } from "@pmndrs/pointer-events";
import type { Intersection } from "@pmndrs/pointer-events";

function makePointer(clickThresholdMs = 600): Pointer {
  const camera = new THREE.PerspectiveCamera();
  let currentIntersection: Intersection | undefined;
  const intersector = {
    isReady: () => true,
    startIntersection: () => {},
    intersectObject: () => {},
    finalizeIntersection: () => currentIntersection!,
    intersectPointerCapture: () => currentIntersection!,
  };
  const pointer = new Pointer(
    1,
    "ray",
    {},
    intersector as never,
    () => camera,
    undefined,
    undefined,
    undefined,
    { clickThresholdMs },
  );
  // Mark moved once so down/up execute synchronously
  const scene = new THREE.Scene();
  currentIntersection = {
    distance: 1,
    object: scene,
    point: new THREE.Vector3(),
    pointOnFace: new THREE.Vector3(),
    pointerPosition: new THREE.Vector3(),
    pointerQuaternion: new THREE.Quaternion(),
    localPoint: new THREE.Vector3(),
    details: { type: "ray" },
  };
  pointer.move(scene, { timeStamp: 0 });
  return pointer;
}

function hit(object: THREE.Object3D): Intersection {
  return {
    distance: 1,
    object,
    point: new THREE.Vector3(),
    pointOnFace: new THREE.Vector3(),
    pointerPosition: new THREE.Vector3(),
    pointerQuaternion: new THREE.Quaternion(),
    localPoint: new THREE.Vector3(),
    details: { type: "ray" },
  };
}

Deno.test("click fires on common button ancestor when ray shifts between child label and container", () => {
  const root = new THREE.Group();
  const buttonA = new THREE.Group();
  const labelA = new THREE.Mesh();
  const iconA = new THREE.Mesh();
  const buttonB = new THREE.Group();
  const labelB = new THREE.Mesh();
  buttonA.add(labelA, iconA);
  buttonB.add(labelB);
  root.add(buttonA, buttonB);

  let clicksA = 0;
  let clicksB = 0;
  buttonA.addEventListener("click" as never, () => {
    clicksA++;
  });
  buttonB.addEventListener("click" as never, () => {
    clicksB++;
  });

  const pointer = makePointer(600);

  // 1. Down on labelA, slight hand jitter onto buttonA background before up -> fires buttonA click
  pointer.setIntersection(hit(labelA));
  pointer.down({ button: 0, timeStamp: 100 });
  pointer.setIntersection(hit(buttonA));
  pointer.up({ button: 0, timeStamp: 250 });
  assertEquals(clicksA, 1);

  // 2. Down on buttonA background, shift onto iconA before up -> fires buttonA click
  pointer.setIntersection(hit(buttonA));
  pointer.down({ button: 0, timeStamp: 1000 });
  pointer.setIntersection(hit(iconA));
  pointer.up({ button: 0, timeStamp: 1450 }); // 450 ms deliberate trigger pull (< 600 ms)
  assertEquals(clicksA, 2);

  // 3. Down on iconA, shift onto sibling labelA inside same buttonA -> fires buttonA click
  pointer.setIntersection(hit(iconA));
  pointer.down({ button: 0, timeStamp: 2000 });
  pointer.setIntersection(hit(labelA));
  pointer.up({ button: 0, timeStamp: 2150 });
  assertEquals(clicksA, 3);

  // 4. Down on buttonA, drag off onto buttonB -> cancels click (neither A nor B fires)
  pointer.setIntersection(hit(labelA));
  pointer.down({ button: 0, timeStamp: 3000 });
  pointer.setIntersection(hit(labelB));
  pointer.up({ button: 0, timeStamp: 3150 });
  assertEquals(clicksA, 3);
  assertEquals(clicksB, 0);

  // 5. Hold longer than clickThresholdMs (650 ms > 600 ms) -> does not fire click
  pointer.setIntersection(hit(labelA));
  pointer.down({ button: 0, timeStamp: 4000 });
  pointer.up({ button: 0, timeStamp: 4650 });
  assertEquals(clicksA, 3);
});
