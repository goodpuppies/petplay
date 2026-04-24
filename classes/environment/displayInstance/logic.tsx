import React, { useRef } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { extend, type ThreeToJSXElements } from "@react-three/fiber/webgpu";
import { Handle } from "@react-three/handle";
import {
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

/**
 * 16:9 wireframe display frame with XR handle: move/rotate and uniform scale (aspect preserved).
 */
export function DisplayInstance(
  { position, rotation, displayInstanceActor, ...frameProps }: DisplayInstanceProps,
) {
  const handleRef = useRef<THREE.Object3D>(null!);

  return (
    <group
      position={position}
      rotation={rotation}
      userData={{ displayInstance: true, aspect: "16:9", displayInstanceActor: displayInstanceActor ?? null }}
    >
      <Handle handleRef={handleRef} multitouch scale={{ uniform: true }}>
        <DisplayInstanceFrame ref={handleRef} {...frameProps} />
      </Handle>
    </group>
  );
}
