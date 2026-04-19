import React, { useRef } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import { extend, ThreeToJSXElements, useFrame } from "@react-three/fiber";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

declare module "@react-three/fiber" {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

type WebXRSceneProps = {
  XROrigin: React.ComponentType;
};

export function WebXRScene({ XROrigin }: WebXRSceneProps) {
  const cubeRef = useRef<THREE.Mesh>(null!);
  const orbRef = useRef<THREE.Mesh>(null!);

  useFrame((_state, delta) => {
    cubeRef.current.rotation.x += delta * 0.6;
    cubeRef.current.rotation.y += delta * 1.1;
    orbRef.current.position.x = Math.sin(performance.now() * 0.001) * 0.35;
    orbRef.current.position.y = 1.55 + Math.cos(performance.now() * 0.0014) * 0.15;
  });

  return (
    <>
      <color attach="background" args={[0xff0033]} />
      <ambientLight intensity={0.9} />
      <directionalLight intensity={3.5} position={[2, 3, 2]} />
      <pointLight intensity={12} position={[0, 1.8, -1.5]} color="#ffb347" />
      <XROrigin />

      {/* <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -1]}>
        <planeGeometry args={[8, 8]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0x00ff88)} />
      </mesh> */}

      <mesh ref={cubeRef} position={[0, 1.6, -2]}>
        <boxGeometry args={[0.5, 0.5, 0.5]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0x0033ff)} />
      </mesh>

      <mesh ref={orbRef} position={[0.4, 1.55, -1.2]}>
        <sphereGeometry args={[0.18, 24, 24]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffff00)} />
      </mesh>
    </>
  );
}
