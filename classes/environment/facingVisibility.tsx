/**
 * Reusable R3F / pmndrs visibility primitive that smoothly fades and hides a 3D panel when its
 * front face (+Z) tilts past `maxAngleDeg` away from the viewer's head.
 *
 * Drives a `@preact/signals-core` opacity signal (consumed natively by `@pmndrs/uikit` via
 * `useFacingOpacity`) plus Three.js `visible` and `@pmndrs/pointer-events` `intersectChildren`
 * imperatively in `useFrame` — zero React re-renders, zero unmounting of children (preserving UI
 * state), and never mutates `pointerEvents` props so `pointerEventsOrder` stays intact.
 */
import React, { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { computed, type ReadonlySignal, type Signal, signal } from "@preact/signals-core";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { extend, type ThreeToJSXElements, useFrame } from "@react-three/fiber/webgpu";
import { getHeadObject } from "./trackedOrigins.ts";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

declare module "@react-three/fiber/webgpu" {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

type PointerIntersectGroup = THREE.Group & { intersectChildren?: boolean };

const FacingOpacityContext = createContext<ReadonlySignal<number> | null>(null);

/**
 * Combine a base opacity with the enclosing `<FacingVisibility>`'s fade signal (if any).
 * Returns a reactive `ReadonlySignal<number>` for `@pmndrs/uikit` when inside `<FacingVisibility>`,
 * or `baseOpacity` directly when outside.
 */
export function useFacingOpacity(baseOpacity: number): number | ReadonlySignal<number> {
  const facing = useContext(FacingOpacityContext);
  return useMemo(
    () => (facing ? computed(() => baseOpacity * facing.value) : baseOpacity),
    [facing, baseOpacity],
  );
}

/**
 * Compose an object's world matrix up the parent chain by hand.
 * `@react-three/xr`'s `<XRSpace>` writes `matrix` with `matrixAutoUpdate = false` without
 * flagging `matrixWorldNeedsUpdate`, so `updateWorldMatrix` can read stale poses.
 */
export function composeWorldMatrix(object: THREE.Object3D, target: THREE.Matrix4): THREE.Matrix4 {
  if (object.matrixAutoUpdate) object.updateMatrix();
  target.copy(object.matrix);
  for (let node = object.parent; node != null; node = node.parent) {
    if (node.matrixAutoUpdate) node.updateMatrix();
    target.premultiply(node.matrix);
  }
  return target;
}

/** Smoothstep target opacity (0..1) for a given tilt angle past `maxAngleDeg`. */
export function targetFacingOpacity(
  angleDeg: number,
  maxAngleDeg: number,
  fadeRangeDeg = 15,
): number {
  if (maxAngleDeg <= 0) return 1;
  if (angleDeg <= maxAngleDeg) return 1;
  if (fadeRangeDeg <= 0) return 0;
  const t = Math.max(0, Math.min(1, (angleDeg - maxAngleDeg) / fadeRangeDeg));
  const smooth = t * t * (3 - 2 * t);
  return 1 - smooth;
}

export type FacingVisibilityProps = {
  /** Angle in degrees where the panel begins fading away from the viewer; `<= 0` disables fading. */
  maxAngleDeg: number;
  /** Angular width in degrees over which opacity fades from 1 to 0 past `maxAngleDeg` (default 15°). */
  fadeRangeDeg?: number;
  /** Disable tilt fading altogether (e.g. desktop HUD preview). */
  enabled?: boolean;
  /** Return `true` to keep at full opacity while interacting (e.g. while dragging/repositioning). */
  keepVisible?: () => boolean;
  /** Called only when interactable visibility transitions (`true` <-> `false`). */
  onVisibilityChange?: (visible: boolean) => void;
  /** Called when the smoothed fade factor changes (0..1), e.g. to hide a depth-only occluder. */
  onOpacityChange?: (opacity: number) => void;
  children: React.ReactNode;
};

const VISIBLE_EPSILON = 0.02;
const FADE_SMOOTH_SPEED = 18;

export function FacingVisibility({
  maxAngleDeg,
  fadeRangeDeg = 15,
  enabled = true,
  keepVisible,
  onVisibilityChange,
  onOpacityChange,
  children,
}: FacingVisibilityProps) {
  const trackerRef = useRef<THREE.Group>(null);
  const contentRef = useRef<PointerIntersectGroup>(null);
  const opacitySignal = useRef<Signal<number> | null>(null);
  if (opacitySignal.current === null) opacitySignal.current = signal(1);
  const visibleRef = useRef(true);
  const keepVisibleRef = useRef(keepVisible);
  keepVisibleRef.current = keepVisible;
  const onChangeRef = useRef(onVisibilityChange);
  onChangeRef.current = onVisibilityChange;
  const onOpacityRef = useRef(onOpacityChange);
  onOpacityRef.current = onOpacityChange;

  const worldMatRef = useRef(new THREE.Matrix4());
  const posRef = useRef(new THREE.Vector3());
  const quatRef = useRef(new THREE.Quaternion());
  const scaleRef = useRef(new THREE.Vector3());
  const headPosRef = useRef(new THREE.Vector3());
  const toHeadRef = useRef(new THREE.Vector3());
  const normalRef = useRef(new THREE.Vector3());

  const applyOpacity = (nextOpacity: number) => {
    const clamped = nextOpacity <= 0.005 ? 0 : nextOpacity >= 0.995 ? 1 : nextOpacity;
    const sig = opacitySignal.current!;
    if (Math.abs(sig.value - clamped) > 0.002 || (clamped === 0 && sig.value !== 0) || (clamped === 1 && sig.value !== 1)) {
      sig.value = clamped;
      onOpacityRef.current?.(clamped);
    }
    const nextVisible = clamped > VISIBLE_EPSILON;
    const content = contentRef.current;
    if (content) {
      content.visible = nextVisible;
      content.intersectChildren = nextVisible;
    }
    if (visibleRef.current !== nextVisible) {
      visibleRef.current = nextVisible;
      onChangeRef.current?.(nextVisible);
    }
  };

  useEffect(() => {
    if (!enabled || maxAngleDeg <= 0) {
      applyOpacity(1);
    }
  }, [enabled, maxAngleDeg]);

  useFrame((r3fState, delta) => {
    if (!enabled || maxAngleDeg <= 0) return;
    let target = 1;
    if (!keepVisibleRef.current?.()) {
      const tracker = trackerRef.current;
      if (!tracker) return;
      composeWorldMatrix(tracker, worldMatRef.current).decompose(
        posRef.current,
        quatRef.current,
        scaleRef.current,
      );
      const renderer = (r3fState as unknown as { renderer?: unknown; gl?: unknown }).renderer ??
        (r3fState as unknown as { gl?: unknown }).gl;
      const head = renderer ? getHeadObject(renderer, r3fState.camera) : r3fState.camera;
      head.updateWorldMatrix(true, false);
      headPosRef.current.setFromMatrixPosition(head.matrixWorld);
      toHeadRef.current.subVectors(headPosRef.current, posRef.current);
      if (toHeadRef.current.lengthSq() >= 1e-6) {
        toHeadRef.current.normalize();
        normalRef.current.set(0, 0, 1).applyQuaternion(quatRef.current).normalize();
        const dot = Math.max(-1, Math.min(1, normalRef.current.dot(toHeadRef.current)));
        const angleDeg = Math.acos(dot) * (180 / Math.PI);
        target = targetFacingOpacity(angleDeg, maxAngleDeg, fadeRangeDeg);
      }
    }
    const current = opacitySignal.current!.value;
    const dt = Number.isFinite(delta) && delta > 0 ? Math.min(0.1, delta) : 1 / 60;
    const alpha = 1 - Math.exp(-dt * FADE_SMOOTH_SPEED);
    applyOpacity(current + (target - current) * alpha);
  });

  return (
    <FacingOpacityContext.Provider value={opacitySignal.current}>
      <group ref={trackerRef}>
        <group ref={contentRef} visible>
          {children}
        </group>
      </group>
    </FacingOpacityContext.Provider>
  );
}
