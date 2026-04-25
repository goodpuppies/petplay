import React, { forwardRef, useMemo } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { extend, type ThreeToJSXElements } from "@react-three/fiber/webgpu";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

declare module "@react-three/fiber/webgpu" {
  // deno-lint-ignore no-empty-interface
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

/** Default frame tint (shared with the display wireframe in prior code paths). */
export const DEFAULT_GRABBOX_LINE_COLOR = 0x7ec8e3;

export type GrabBoxProps = {
  width: number;
  height: number;
  depth: number;
  /** Albedo / emissive tint. */
  lineColor?: number;
  /** Uikit + this box both use a centered origin; children only need a `contentOffset` nudge, not a pivot correction. */
  children?: React.ReactNode;
};

/**
 * Simple wireframe box (AABB) for a grabbable region: universal overlay chrome + debug “hit hull”.
 *
 * Uses `Mesh` + `MeshLambertMaterial` with `wireframe` (not `LineBasicMaterial`) so
 * [classes/webxrRaythreeRaylibRenderer.ts](webxrRaythreeRaylibRenderer.ts) can carry `state.wireframe`
 * to raylib, matching [DisplayInstanceFrame](displayInstance/ui.tsx) behavior.
 */
export const GrabBox = forwardRef<THREE.Group, GrabBoxProps>(function GrabBox(
  { width, height, depth, lineColor = DEFAULT_GRABBOX_LINE_COLOR, children },
  ref,
) {
  const color = useMemo(() => new THREE.Color(lineColor), [lineColor]);

  return (
    <group
      ref={ref}
      userData={{ grabbox: true, grabboxSize: [width, height, depth] as const }}
    >
      <mesh>
        <boxGeometry args={[width, height, depth]} />
        <meshLambertMaterial
          wireframe
          color={color}
          emissive={color}
          emissiveIntensity={0.2}
          side={THREE.DoubleSide}
        />
      </mesh>
      {children}
    </group>
  );
});
