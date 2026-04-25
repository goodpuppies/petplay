import React, { useMemo, useRef } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import {
  createPortal,
  extend,
  type ThreeToJSXElements,
  useFrame,
  useThree,
} from "@react-three/fiber/webgpu";

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
 * Always-visible controller aim cue. **Unlit solid** so Raylib gets stable albedo; `depthTest` /
 * `depthWrite` off so the beam paints over scene geometry (e.g. keyboard) when sorted late via
 * `renderOrder`. `WebXRRaythreeRaylibRenderer` honors those flags via rlgl depth test / mask.
 */
export function ConstantControllerAimBeam(
  { length = 0.95, color = 0x5ec8ff, opacity = 1, renderOrder = 9999 }: ConstantControllerAimBeamProps,
) {
  const threeColor = useMemo(() => new THREE.Color(color), [color]);
  const opaque = opacity >= 0.999;

  return (
    <mesh
      position={[0, 0, -length / 2]}
      renderOrder={renderOrder}
      {...({
        pointerEvents: "none",
      } as Record<string, unknown>)}
    >
      <boxGeometry args={[BEAM_THICKNESS, BEAM_THICKNESS, length]} />
      <meshBasicMaterial
        color={threeColor}
        toneMapped={false}
        depthTest={false}
        depthWrite={false}
        transparent={!opaque}
        opacity={opacity}
      />
    </mesh>
  );
}

/**
 * Same geometry/material as `ConstantControllerAimBeam`, but the mesh is portaled to the R3F
 * scene root so Raythree still sees it when a parent `XRSpace` never sets `visible` (e.g. no
 * `getPose` for that space in OpenVR / IWER — `traverseVisible` would skip the whole subtree).
 *
 * A hidden in-tree anchor supplies the world matrix each frame after XR matrix hooks run.
 */
export function PortaledControllerAimBeam(
  { length = 0.95, color = 0x5ec8ff, opacity = 1, renderOrder = 9999 }: ConstantControllerAimBeamProps,
) {
  const scene = useThree((s) => s.scene);
  const anchorRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const threeColor = useMemo(() => new THREE.Color(color), [color]);
  const opaque = opacity >= 0.999;

  useFrame(() => {
    const anchor = anchorRef.current;
    const mesh = meshRef.current;
    if (anchor == null || mesh == null) {
      return;
    }
    anchor.updateWorldMatrix(true, false);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(anchor.matrixWorld);
  });

  return (
    <>
      <group ref={anchorRef} position={[0, 0, -length / 2]} visible={false} />
      {createPortal(
        <mesh
          ref={meshRef}
          matrixAutoUpdate={false}
          renderOrder={renderOrder}
          visible
          {...({
            pointerEvents: "none",
          } as Record<string, unknown>)}
        >
          <boxGeometry args={[BEAM_THICKNESS, BEAM_THICKNESS, length]} />
          <meshBasicMaterial
            color={threeColor}
            toneMapped={false}
            depthTest={false}
            depthWrite={false}
            transparent={!opaque}
            opacity={opacity}
          />
        </mesh>,
        scene,
      )}
    </>
  );
}
