import React, { useRef } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import {
  extend,
  type ThreeToJSXElements,
  type UseFrameNextOptions,
  useFrame,
} from "@react-three/fiber/webgpu";
import { Handle } from "@react-three/handle";
import { PostMan } from "../../../submodules/stageforge/mod.ts";
import { hmd34FromColumnMajor4x4 } from "../../openvrTransform.ts";
import {
  DEFAULT_DISPLAY_HEIGHT,
  DISPLAY_ASPECT_WIDTH_OVER_HEIGHT,
  DisplayInstanceFrame,
  type DisplayInstanceFrameProps,
} from "./ui.tsx";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

declare module "@react-three/fiber/webgpu" {
  // deno-lint-ignore no-empty-interface
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

export type DisplayInstanceProps = DisplayInstanceFrameProps & {
  position?: [number, number, number];
  rotation?: [number, number, number];
  /** Optional actor id for future overlay / bridge correlation. */
  displayInstanceActor?: string | null;
};

function hmd34ApproxEqual(
  a: { m: number[][] },
  b: { m: number[][] },
  eps: number = 0.0001,
): boolean {
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      if (Math.abs(a.m[i][j] - b.m[i][j]) > eps) {
        return false;
      }
    }
  }
  return true;
}

/**
 * 16:9 wireframe display frame with XR handle: move/rotate and uniform scale (aspect preserved).
 * When `displayInstanceActor` is set, the OpenVR desktop overlay actor is kept aligned with
 * this transform and world width (meters) each frame.
 */
export function DisplayInstance(
  { position, rotation, displayInstanceActor, ...frameProps }: DisplayInstanceProps,
) {
  const handleRef = useRef<THREE.Group | null>(null);
  const p0 = useRef(new THREE.Vector3());
  const p1 = useRef(new THREE.Vector3());
  const decompPos = useRef(new THREE.Vector3());
  const decompQuat = useRef(new THREE.Quaternion());
  const decompScale = useRef(new THREE.Vector3());
  const unitScale = useRef(new THREE.Vector3(1, 1, 1));
  const rigidWorld = useRef(new THREE.Matrix4());
  const lastSentHmd = useRef<ReturnType<typeof hmd34FromColumnMajor4x4> | null>(null);
  const lastSentWidth = useRef<number | null>(null);

  const height = frameProps.height ?? DEFAULT_DISPLAY_HEIGHT;
  const localHalfW = 0.5 * height * DISPLAY_ASPECT_WIDTH_OVER_HEIGHT;

  const displaySyncFrameOpts = React.useMemo<UseFrameNextOptions>(
    () => ({
      id: "petplay-display-openvr",
      enabled: displayInstanceActor != null,
      phase: "finish",
      fps: 60,
      drop: true,
    }),
    [displayInstanceActor],
  );

  useFrame(() => {
    if (displayInstanceActor == null) {
      return;
    }
    const targetActor = displayInstanceActor;
    const obj = handleRef.current;
    if (obj == null) {
      return;
    }
    obj.updateWorldMatrix(true, true);
    // `SetOverlayWidthInMeters` already encodes the physical size. OpenVR expects a
    // rigid 3×4 (rotation + translation); baking scale into 3×3 as well would double-apply
    // size together with the width we send.
    obj.matrixWorld.decompose(
      decompPos.current,
      decompQuat.current,
      decompScale.current,
    );
    rigidWorld.current.compose(decompPos.current, decompQuat.current, unitScale.current);
    const hmd = hmd34FromColumnMajor4x4(rigidWorld.current.elements as unknown as {
      0: number; 4: number; 8: number; 12: number;
      1: number; 5: number; 9: number; 13: number;
      2: number; 6: number; 10: number; 14: number;
    });
    p0.current.set(-localHalfW, 0, 0);
    p1.current.set(localHalfW, 0, 0);
    p0.current.applyMatrix4(obj.matrixWorld);
    p1.current.applyMatrix4(obj.matrixWorld);
    const widthMeters = p0.current.distanceTo(p1.current);

    if (lastSentHmd.current && lastSentWidth.current !== null) {
      if (hmd34ApproxEqual(hmd, lastSentHmd.current) && Math.abs(lastSentWidth.current - widthMeters) < 0.0001) {
        return;
      }
    }
    lastSentHmd.current = hmd;
    lastSentWidth.current = widthMeters;
    try {
      PostMan.PostMessage({
        target: targetActor,
        type: "SYNCDISPLAYPOSE",
        payload: { hmd, widthMeters },
      });
    } catch {
      // actor may be torn down
    }
  }, displaySyncFrameOpts);

  return (
    <group
      position={position}
      rotation={rotation}
      userData={{ displayInstance: true, aspect: "16:9", displayInstanceActor: displayInstanceActor ?? null }}
    >
      <Handle handleRef={handleRef as unknown as React.RefObject<import("three").Object3D | null>} multitouch scale={{ uniform: true }}>
        <DisplayInstanceFrame ref={handleRef} {...frameProps} />
      </Handle>
    </group>
  );
}
