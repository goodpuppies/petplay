import "../../submodules/threewebxrwebgpudeno/submodules/xr/packages/pointer-events/src/pointer.ts";
import { HandleStore, type HandleOptions } from "@pmndrs/handle";
import * as THREE from "three/webgpu";
import type { PointerEvent as PenPointerEvent } from "@pmndrs/pointer-events";

/**
 * `three/webgpu` ships no usable `Object3D` member types, so the transform fields this test reads
 * and writes are declared structurally. Only the members actually exercised appear here.
 */
type TransformedObject = THREE.Object3D & {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
  rotation: THREE.Euler;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function transformedObject(): TransformedObject {
  return new THREE.Object3D() as unknown as TransformedObject;
}

function pointerEvent(
  object: THREE.Object3D,
  {
    type = "pointerdown",
    point = [0.5, 0, 0],
    position = [0.5, 0, 0],
    quaternion,
    detailsType = "ray",
    pointerId = 42,
  }: {
    type?: string;
    point?: [number, number, number];
    position?: [number, number, number];
    quaternion?: THREE.Quaternion;
    detailsType?: string;
    pointerId?: number;
  } = {},
) {
  return {
    type,
    pointerId,
    pointerType: "grab",
    object,
    point: new THREE.Vector3(...point),
    pointerPosition: new THREE.Vector3(...position),
    pointerQuaternion: quaternion ?? new THREE.Quaternion(),
    details: { type: detailsType },
    intersection: { details: { type: detailsType } },
    timeStamp: 1,
    stopPropagation() {},
  } as unknown as PenPointerEvent;
}

/** A rotation-only grab, exactly how a hinge configures its handle. */
function hingeOptions(projectRays = false): HandleOptions<unknown> {
  return {
    apply: (state, target) => {
      const object = target as unknown as TransformedObject;
      object.position.copy(state.current.position);
      object.quaternion.copy(state.current.quaternion);
      object.scale.copy(state.current.scale);
    },
    rotate: "y",
    translate: "as-rotate",
    scale: false,
    multitouch: false,
    projectRays,
  };
}

Deno.test("push/pull is refused on a rotation-only handle", () => {
  const target = transformedObject();
  const store = new HandleStore(target, hingeOptions);
  store.handlers.onPointerDown(pointerEvent(new THREE.Object3D()));
  const pointer = store.inputState.get(42);
  assert(pointer != null, "the grab should register its pointer");
  const before = pointer.initialPointerWorldPoint.clone();

  assert(
    store.translateAlongPointerRay(42, 0.5) === false,
    "a handle whose translation is rotation must refuse push/pull",
  );
  assert(
    pointer.initialPointerWorldPoint.equals(before),
    "refusing push/pull must not shift the pointer baseline the rotation is derived from",
  );
});

Deno.test("push/pull still moves a freely translating handle", () => {
  const target = transformedObject();
  const store = new HandleStore(target);
  store.handlers.onPointerDown(pointerEvent(new THREE.Object3D()));
  assert(
    store.translateAlongPointerRay(42, 0.5) === true,
    "a free handle should still accept push/pull",
  );
  assert(target.position.length() > 0.1, "the free handle should have moved along the ray");
});

Deno.test("an absolute axis angle owns the rotation while the hand is moving", () => {
  const handle = new THREE.Object3D();
  const target = transformedObject();
  const store = new HandleStore(target, hingeOptions);
  store.handlers.onPointerDown(pointerEvent(handle));
  assert(Math.abs(target.rotation.y) < 1e-6, "a fresh grab starts aligned with the pointer");

  assert(
    store.setTargetAxisAngle(42, "y", 0.3) === true,
    "an active rotation-only grab should accept an absolute angle",
  );
  assert(
    Math.abs(target.rotation.y - 0.3) < 1e-3,
    `the setter should reach the requested angle (got ${target.rotation.y})`,
  );

  // The hand moves between stick frames; the next stick frame re-asserts the angle, so the hand's
  // contribution is discarded instead of fighting the stick.
  store.handlers.onPointerMove(pointerEvent(handle, {
    type: "pointermove",
    point: [0.4, 0, 0.2],
    position: [0.9, 0.3, 0.4],
  }));
  store.update(2, true);
  store.setTargetAxisAngle(42, "y", 0.3);
  assert(
    Math.abs(target.rotation.y - 0.3) < 1e-3,
    `hand motion must not fight a deflected stick (got ${target.rotation.y})`,
  );

  store.setTargetAxisAngle(42, "y", -0.5);
  assert(
    Math.abs(target.rotation.y + 0.5) < 1e-3,
    `a later absolute angle should still take effect (got ${target.rotation.y})`,
  );
});

/** A single-axis (hinge) rotation, e.g. a display hinged along its top edge. */
function hingeAxisOptions(axis: "x" | "y" | "z"): HandleOptions<unknown> {
  return {
    apply: (state, target) => {
      const object = target as unknown as TransformedObject;
      object.position.copy(state.current.position);
      object.quaternion.copy(state.current.quaternion);
      object.scale.copy(state.current.scale);
    },
    rotate: axis,
    translate: "as-rotate",
    scale: false,
    multitouch: false,
    projectRays: false,
  };
}

Deno.test("a hinge turns by the same angle wherever it is grabbed along its axis", () => {
  const radius = 0.25;
  const turnBy = 0.2;
  const turnedFor = (lateralOffset: number) => {
    const handle = new THREE.Object3D();
    const target = transformedObject();
    const store = new HandleStore(target, () => hingeAxisOptions("x"));
    store.handlers.onPointerDown(pointerEvent(handle, { point: [lateralOffset, radius, 0] }));
    store.update(1, true);
    // The same physical hand motion: the grab point swings a fixed angle about the hinge axis.
    store.handlers.onPointerMove(pointerEvent(handle, {
      type: "pointermove",
      point: [lateralOffset, radius * Math.cos(turnBy), radius * Math.sin(turnBy)],
    }));
    store.update(2, true);
    return target.rotation.x;
  };

  const centred = turnedFor(0);
  assert(
    Math.abs(centred - turnBy) < 0.005,
    `a centred grab should turn the hinge ${turnBy} rad (got ${centred})`,
  );
  const offCentre = turnedFor(radius);
  assert(
    Math.abs(offCentre - turnBy) < 0.005,
    `grabbing a radius off the axis must turn the same amount (got ${offCentre})`,
  );
});

Deno.test("one hand scales a hinge by its radius, but only when the grab is at the hand", () => {
  const radius = 0.2;
  const scaledFor = (lateralOffset: number, handOffset: number) => {
    const handle = new THREE.Object3D();
    const target = transformedObject();
    const store = new HandleStore(target, () => ({
      ...hingeAxisOptions("x"),
      translate: "as-rotate-and-scale",
      scale: { uniform: true },
      oneHandScaleMaxGrabOffset: 0.2,
      multitouch: true,
    }));
    store.handlers.onPointerDown(pointerEvent(handle, {
      // The hand sits `handOffset` beyond the point it grabbed: ~0 for a direct grab, an arm's
      // length for a laser.
      point: [lateralOffset, radius, 0],
      position: [lateralOffset, radius, handOffset],
    }));
    store.update(1, true);
    // Pull straight out to 1.5x the radius: the hinge stands in for the second hand.
    store.handlers.onPointerMove(pointerEvent(handle, {
      type: "pointermove",
      point: [lateralOffset, radius * 1.5, 0],
      position: [lateralOffset, radius * 1.5, handOffset],
    }));
    store.update(2, true);
    return { scale: target.scale.x, turn: target.rotation.x };
  };

  const centred = scaledFor(0, 0);
  assert(
    Math.abs(centred.scale - 1.5) < 0.01,
    `pulling to 1.5x the radius should scale by 1.5 (got ${centred.scale})`,
  );
  assert(Math.abs(centred.turn) < 0.01, `a radial pull must not turn the hinge (got ${centred.turn})`);

  const offCentre = scaledFor(0.3, 0);
  assert(
    Math.abs(offCentre.scale - 1.5) < 0.01,
    `the radius is about the axis, so an off-axis grab scales the same (got ${offCentre.scale})`,
  );

  // A laser grabs a whole grab-distance off the hand, so the same pull would be far too twitchy:
  // it rotates only. (Its pointer type is still 'grab', so geometry is the only reliable signal.)
  const laser = scaledFor(0, 0.6);
  assert(
    Math.abs(laser.scale - 1) < 0.01,
    `a laser pull must not resize the panel (got ${laser.scale})`,
  );
});

Deno.test("a second pointer pinch-scales a constrained-rotation handle", () => {
  const handle = new THREE.Object3D();
  const target = transformedObject();
  const store = new HandleStore(target, () => ({
    ...hingeAxisOptions("y"),
    scale: { uniform: true },
    multitouch: true,
  }));
  store.handlers.onPointerDown(pointerEvent(handle, { pointerId: 1, point: [0.2, 0, 0] }));
  store.handlers.onPointerDown(pointerEvent(handle, { pointerId: 2, point: [0.8, 0, 0] }));
  store.update(1, true);
  assert(Math.abs(target.scale.x - 1) < 0.001, `a two-pointer grab starts at scale 1 (${target.scale.x})`);

  // Separation 0.6 -> 1.2: a uniform pinch should double the element.
  store.handlers.onPointerMove(pointerEvent(handle, { type: "pointermove", pointerId: 1, point: [0.1, 0, 0] }));
  store.handlers.onPointerMove(pointerEvent(handle, { type: "pointermove", pointerId: 2, point: [1.3, 0, 0] }));
  store.update(2, true);
  assert(
    Math.abs(target.scale.x - 2) < 0.05,
    `the pinch should scale with the pointer separation (got ${target.scale.x})`,
  );
});

/**
 * A laser grab must behave like a hand at the frozen grab point: the hinge follows the *point*, so
 * translating the hand while the point stays put cannot rotate it. Projecting the ray instead makes
 * the same hand motion sweep the interaction plane at the grab distance and rotate the hinge — the
 * "moves randomly" half of the bug, which is why the spatial handles set `projectRays: false`.
 */
Deno.test("a hinge follows the frozen grab point, not the hand's ray", () => {
  const tilted = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.6, 0, 0));
  const nudgeHand = (store: HandleStore<unknown>) => {
    const handle = new THREE.Object3D();
    store.handlers.onPointerDown(pointerEvent(handle, {
      point: [0.5, 0, 0],
      position: [0.5, 0, 1],
      quaternion: tilted,
    }));
    store.update(1, true);
    // The hand translates; the intersection (grab point) stays where it was.
    store.handlers.onPointerMove(pointerEvent(handle, {
      type: "pointermove",
      point: [0.5, 0, 0],
      position: [0.5, 0.4, 1],
      quaternion: tilted,
    }));
    store.update(2, true);
  };

  const frozen = transformedObject();
  nudgeHand(new HandleStore(frozen, () => hingeOptions(false)));
  assert(
    Math.abs(frozen.rotation.y) < 1e-3,
    `a frozen grab point must not rotate with the hand (got ${frozen.rotation.y})`,
  );

  const projected = transformedObject();
  nudgeHand(new HandleStore(projected, () => hingeOptions(true)));
  assert(
    Math.abs(projected.rotation.y) > 0.05,
    "ray projection is what turned hand translation into hinge rotation",
  );
});
