import React, { forwardRef, useEffect, useMemo } from "react";
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
  /** `edges` draws only the 12 box edges; `mesh` keeps the old triangle wireframe with face diagonals. */
  wireframeMode?: "edges" | "mesh";
  /**
   * When `false`, XR **trigger rays** ignore this hull so they can hit children behind the shell
   * (keyboard keys). Squeeze “grab” still collides. Default `true` for generic shells like the display bezel.
   */
  shellRayPickable?: boolean;
  /** Include the invisible interaction hull. Use `false` for purely visual/edit hints. */
  interactionHull?: boolean;
  /** Draw the wireframe chrome. The invisible interaction hull remains active. */
  visibleChrome?: boolean;
  /** Uikit + this box both use a centered origin; children only need a `contentOffset` nudge, not a pivot correction. */
  children?: React.ReactNode;
};

/**
 * Simple wireframe box (AABB) for a grabbable region: universal overlay chrome + debug “hit hull”.
 *
 * `wireframeMode="edges"` draws only the AABB outline and keeps a separate invisible mesh as the
 * interaction hull. `wireframeMode="mesh"` preserves the old triangle-wireframe visual.
 */
export const GrabBox = forwardRef<THREE.Group, GrabBoxProps>(function GrabBox(
  {
    width,
    height,
    depth,
    lineColor = DEFAULT_GRABBOX_LINE_COLOR,
    wireframeMode = "edges",
    shellRayPickable = true,
    interactionHull = true,
    visibleChrome = true,
    children,
  },
  ref,
) {
  const color = useMemo(() => new THREE.Color(lineColor), [lineColor]);
  const edgeGeometry = useMemo(() => {
    if (wireframeMode !== "edges") {
      return null;
    }
    const box = new THREE.BoxGeometry(width, height, depth);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    return edges;
  }, [depth, height, width, wireframeMode]);

  useEffect(() => {
    return () => {
      edgeGeometry?.dispose();
    };
  }, [edgeGeometry]);

  const shellPointerMods = !shellRayPickable
    ? ({ pointerEventsType: { deny: ["ray", "screen-mouse", "poker"] } } as Record<string, unknown>)
    : {};

  return (
    <group
      ref={ref}
      userData={{ grabbox: true, grabboxSize: [width, height, depth] as const }}
    >
      {wireframeMode === "edges" && edgeGeometry != null
        ? (
          <>
            {visibleChrome
              ? (
                <lineSegments
                  geometry={edgeGeometry as unknown as THREE.BufferGeometry}
                  userData={{ bridge: { radius: 0.001, radialSegments: 4 } }}
                  {...({ pointerEvents: "none" } as Record<string, unknown>)}
                >
                  <lineBasicMaterial color={color} />
                </lineSegments>
              )
              : null}
            {interactionHull
              ? (
                <mesh renderOrder={-100} {...shellPointerMods}>
                  <boxGeometry args={[width, height, depth]} />
                  <meshBasicMaterial
                    depthTest
                    depthWrite
                    colorWrite={false}
                    side={THREE.DoubleSide}
                  />
                </mesh>
              )
              : null}
          </>
        )
        : (
          <mesh {...shellPointerMods}>
            <boxGeometry args={[width, height, depth]} />
            <meshLambertMaterial
              wireframe
              color={color}
              emissive={color}
              emissiveIntensity={0.2}
              visible={visibleChrome}
              side={THREE.DoubleSide}
            />
          </mesh>
        )}
      {children}
    </group>
  );
});
