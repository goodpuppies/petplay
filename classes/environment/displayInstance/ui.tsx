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

/** 16:9 content aspect (width = height × this value). */
export const DISPLAY_ASPECT_WIDTH_OVER_HEIGHT = 16 / 9;

/** Default full-height of the display frame in scene units (meters). */
export const DEFAULT_DISPLAY_HEIGHT = 0.5;

/** Default depth of the thin box “screen” volume. */
export const DEFAULT_DISPLAY_DEPTH = 0.04;

/** Default frame color (hex). */
export const DEFAULT_LINE_COLOR = 0x7ec8e3;

export type DisplayInstanceFrameProps = {
  /** Full height of the 16:9 frame. Width = height × `DISPLAY_ASPECT_WIDTH_OVER_HEIGHT`. */
  height?: number;
  depth?: number;
  /** Albedo / tint; same prop name as before. */
  lineColor?: number;
};

/**
 * Visual-only 16:9 thin box. Uses `Mesh` + `MeshLambertMaterial` with `wireframe` (not
 * `LineBasicMaterial`) so the raythree extract gets `state.wireframe` and
 * [classes/webxrRaythreeRaylibRenderer.ts](classes/webxrRaythreeRaylibRenderer.ts) can mirror edges via
 * `DrawModelWiresEx` (unlit) using material base color. The WebGPU/Three wireframe and the mirror are
 * independent; raylib does not use `uBaseColor` lighting for wire draw.
 */
export const DisplayInstanceFrame = forwardRef<THREE.Object3D, DisplayInstanceFrameProps>(
  function DisplayInstanceFrame(
    { height = DEFAULT_DISPLAY_HEIGHT, depth = DEFAULT_DISPLAY_DEPTH, lineColor = DEFAULT_LINE_COLOR },
    ref,
  ) {
    const width = height * DISPLAY_ASPECT_WIDTH_OVER_HEIGHT;
    const color = useMemo(() => new THREE.Color(lineColor), [lineColor]);

    return (
      <mesh ref={ref}>
        <boxGeometry args={[width, height, depth]} />
        <meshLambertMaterial
          wireframe
          color={color}
          emissive={color}
          emissiveIntensity={0.2}
          side={THREE.DoubleSide}
        />
      </mesh>
    );
  },
);
