import React, { useLayoutEffect, useRef } from "react";
import * as THREE from "three";
import { createPortal, useFrame, useThree } from "@react-three/fiber/webgpu";
import { MsdfText } from "../../../submodules/threewebxrwebgpudeno/msdf-text.tsx";

export const TEXT_PROBE_DISTANCES = { near: 0.35, far: 1.4 } as const;
export type TextProbeDistance = keyof typeof TEXT_PROBE_DISTANCES;

/** A scene-level diagnostic, independent of wrist transforms and keyboard layout. */
export function TextDistanceProbe({ distance }: { distance: TextProbeDistance }) {
  const scene = useThree((state) => state.scene);
  const root = useRef<THREE.Group>(null);
  const meters = TEXT_PROBE_DISTANCES[distance];
  useFrame((state) => {
    const group = root.current;
    if (!group) return;
    // The renderer is three's WebGPURenderer; r3f's types call it WebGLRenderer.
    const xr = (state.renderer as unknown as {
      xr: { isPresenting: boolean; getCamera(): THREE.Camera };
    }).xr;
    const head = xr.isPresenting ? xr.getCamera() : state.camera;
    head.updateWorldMatrix(true, false);
    group.matrix.copy(group.parent?.matrixWorld ?? new THREE.Matrix4()).invert()
      .multiply(head.matrixWorld);
    group.updateMatrixWorld(true);
  });
  // Hidden wrist pages retain React state, but must never leave a diagnostic in the scene.
  useLayoutEffect(() => {
    const group = root.current;
    if (group) group.visible = true;
    return () => {
      if (group) group.visible = false;
    };
  }, []);
  return createPortal(
    <group
      ref={root}
      matrixAutoUpdate={false}
      userData={{ renderTrackingAnchor: "head", textDistanceProbe: true }}
      {...({ pointerEvents: "none" } as Record<string, unknown>)}
    >
      {
        /* Size and displacement both scale with depth; the cyclopean projection stays fixed.
          Stereo disparity necessarily changes, and individual-eye pixel phases can change. */
      }
      <group
        position={[0, 0, -meters]}
        scale={meters}
        userData={{ textProbeDistance: distance, textProbeMeters: meters }}
      >
        <mesh position={[0, 0, -0.002]}>
          <planeGeometry args={[0.06, 0.06]} />
          <meshBasicMaterial color="#26262b" />
        </mesh>
        <group userData={{ bridge: { kind: "skip" } }}>
          <MsdfText
            text="@"
            color="#ffffff"
            fontSize={0.00027}
            anchorX="center"
            position={[0, -17 * 0.00027, 0]}
          />
        </group>
      </group>
    </group>,
    scene,
  );
}
