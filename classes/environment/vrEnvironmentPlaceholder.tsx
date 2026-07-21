import React from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import { extend, type ThreeToJSXElements } from "@react-three/fiber/webgpu";

// Keep this component compatible with both the WebGPU scene and RayThree extraction.
extend(THREE as never);

declare module "@react-three/fiber/webgpu" {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

const GRID_HALF_SIZE = 10;
const GRID_STEP = 0.5;

function FloorGrid() {
  const lines = React.useMemo(() => {
    const result: Array<
      { key: string; position: [number, number, number]; scale: [number, number, number] }
    > = [];
    for (let offset = -GRID_HALF_SIZE; offset <= GRID_HALF_SIZE; offset += GRID_STEP) {
      const major = Math.abs(offset % 2) < 0.001;
      const thickness = major ? 0.012 : 0.004;
      result.push({
        key: `x-${offset}`,
        position: [0, 0.003, offset],
        scale: [GRID_HALF_SIZE * 2, thickness, thickness],
      });
      result.push({
        key: `z-${offset}`,
        position: [offset, 0.003, 0],
        scale: [thickness, thickness, GRID_HALF_SIZE * 2],
      });
    }
    return result;
  }, []);

  return (
    <group>
      {lines.map(({ key, position, scale }) => (
        <mesh key={key} position={position} scale={scale}>
          <boxGeometry args={[1, 1, 1]} />
          <meshBasicNodeMaterial colorNode={TSL.color(0x25758b)} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Lightweight desktop stand-in for the familiar SteamVR compositor space.
 * It gives scale, horizon, and play-area cues without depending on OpenVR.
 */
export function VREnvironmentPlaceholder() {
  return (
    <group userData={{ vrEnvironmentPlaceholder: true }}>
      <mesh position={[0, -0.035, 0]}>
        <cylinderGeometry args={[14, 14, 0.06, 64]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0x07141b)} />
      </mesh>

      <FloorGrid />

      <mesh position={[0, 0.015, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.6, 0.018, 8, 64]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0x55d9f2)} />
      </mesh>
      <mesh position={[0, 0.012, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[2.25, 0.009, 8, 64]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0x1c7184)} />
      </mesh>

      {[-7, -3.5, 0, 3.5, 7].map((x, index) => (
        <mesh key={`horizon-${x}`} position={[x, 1.1 + (index % 2) * 0.45, -9]}>
          <boxGeometry args={[2.4, 2.2 + (index % 2) * 0.9, 0.25]} />
          <meshBasicNodeMaterial colorNode={TSL.color(0x0b2731)} />
        </mesh>
      ))}

      {[-6, 6].map((x) => (
        <group key={`beacon-${x}`} position={[x, 0, -5]}>
          <mesh position={[0, 1.25, 0]}>
            <cylinderGeometry args={[0.06, 0.12, 2.5, 12]} />
            <meshBasicNodeMaterial colorNode={TSL.color(0x174b59)} />
          </mesh>
          <mesh position={[0, 2.55, 0]}>
            <sphereGeometry args={[0.12, 12, 8]} />
            <meshBasicNodeMaterial colorNode={TSL.color(0x62e7ff)} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
