import React, { useRef } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import { extend, ThreeToJSXElements, useFrame } from "@react-three/fiber";
import { updateShadowSceneMesh } from "./webxrShadowScene.ts";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

declare module "@react-three/fiber" {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

type WebXRSceneProps = {
  XROrigin: React.ComponentType;
};

export function WebXRScene({ XROrigin }: WebXRSceneProps) {
  const accentRef = useRef<THREE.Mesh>(null!);

  useFrame((_state, delta) => {
    accentRef.current.rotation.y += delta * 0.25;
    updateShadowSceneMesh(0, {
      kind: "torus",
      position: [0, 1.45, -1.8],
      rotation: [0, accentRef.current.rotation.y, 0],
      scale: [1, 1, 1],
      color: [255, 139, 61, 255],
      wireColor: [255, 196, 148, 255],
    });
    updateShadowSceneMesh(1, {
      kind: "cube",
      position: [0.35, 1.2, -1.45],
      rotation: [0, accentRef.current.rotation.y * 0.6, 0],
      scale: [0.18, 0.18, 0.18],
      color: [84, 214, 44, 220],
      wireColor: [160, 255, 132, 255],
    });
  });

  return (
    <>
      <color attach="background" args={[0x091018]} />
      <fog attach="fog" args={["#091018", 1.5, 5]} />
      <ambientLight intensity={0.8} />
      <directionalLight intensity={2.8} position={[2, 3, 2]} />
      <pointLight intensity={8} position={[0, 1.9, -1.25]} color="#ffb347" />
      <XROrigin />

      <mesh ref={accentRef} position={[0, 1.45, -1.8]}>
        <torusGeometry args={[0.12, 0.012, 16, 48]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xff8b3d)} />
      </mesh>

      <mesh position={[0.35, 1.2, -1.45]}>
        <boxGeometry args={[0.18, 0.18, 0.18]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0x54d62c)} />
      </mesh>
    </>
  );
}
