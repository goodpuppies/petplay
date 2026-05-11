import React, { useMemo } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { extend, type ThreeToJSXElements } from "@react-three/fiber/webgpu";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

declare module "@react-three/fiber/webgpu" {
  // deno-lint-ignore no-empty-interface
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

export type ConstantControllerAimBeamProps = {
  /** Meters along local -Z from the controller aim origin. */
  length?: number;
  color?: number;
  /** 1 = fully opaque (recommended for Raylib). Lower values enable alpha (transparent pass). */
  opacity?: number;
  renderOrder?: number;
};

/** Cross-section (m); 2 mm reads clearly with solid unlit extrusion in the overlay. */
const BEAM_THICKNESS = 0.002;

/**
 * Controller aim cue: thin unlit box along local -Z. `depthTest` / `depthWrite` off. For the Raylib
 * overlay, `raythreeHudOverUi` draws this **after** uikit; `renderOrder` only affects the WebGPU
 * path among scene objects.
 */
export function ConstantControllerAimBeam(
  { length = 0.95, color = 0x5ec8ff, opacity = 1, renderOrder = 9999 }:
    ConstantControllerAimBeamProps,
) {
  const threeColor = useMemo(() => new THREE.Color(color), [color]);
  const opaque = opacity >= 0.999;

  return (
    <mesh
      position={[0, 0, -length / 2]}
      renderOrder={renderOrder}
      userData={{ raythreeHudOverUi: true }}
      {...({
        pointerEvents: "none",
      } as Record<string, unknown>)}
    >
      <boxGeometry args={[BEAM_THICKNESS, BEAM_THICKNESS, length]} />
      <meshBasicMaterial
        color={threeColor}
        toneMapped={false}
        depthTest
        depthWrite={false}
        transparent={!opaque}
        opacity={opacity}
      />
    </mesh>
  );
}
