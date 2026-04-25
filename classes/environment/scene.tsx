import React, { useRef } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import {
  extend,
  type ThreeToJSXElements,
  type UseFrameNextOptions,
  useFrame,
} from "@react-three/fiber/webgpu";
import { updateShadowSceneMesh } from "../webxrShadowScene.ts";
import { BoxLineGeometry } from "three/addons/geometries/BoxLineGeometry.js";
import { DisplayInstance } from "./displayInstance/logic.tsx";
import { KeyboardPanel, windowsSystemKeyboardSink } from "./keyboard/keyboard.tsx";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

declare module "@react-three/fiber/webgpu" {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

type WebXRSceneProps = {
  XROrigin: React.ComponentType;
  displayInstanceActor?: string | null;
};

function RoomWireBox({ color }: { color: THREE.Color }) {
  const geometry = React.useMemo(
    () => new BoxLineGeometry(6, 6, 6, 10, 10, 10).translate(0, 3, 0),
    [],
  );

  React.useEffect(() => {
    return () => geometry.dispose();
  }, [geometry]);

  return (
    <lineSegments geometry={geometry as unknown as THREE.BufferGeometry}>
      <lineBasicMaterial color={color} />
    </lineSegments>
  );
}

export function WebXRScene(
  { XROrigin: _XROrigin, displayInstanceActor = null }: WebXRSceneProps,
) {
  void _XROrigin;
  const accentRef = useRef<THREE.Mesh>(null!);

  // R3F v10: keep mesh animation on the default `update` phase. Memoize options
  // so the scheduler job is not re-registered every React render.
  const accentFrameOpts = React.useMemo<UseFrameNextOptions>(
    () => ({ id: "petplay-accent-torus" }),
    [],
  );
  useFrame((_state, delta) => {
    accentRef.current.rotation.y += delta * 0.25;
  }, accentFrameOpts);

  // Ghost overlay snapshot for Raylib: not needed at HMD rate; `finish` runs after uikit/keyboard
  // update jobs, and 60Hz is plenty for a slow torus + shadow mesh mirror.
  const shadowMirrorOpts = React.useMemo<UseFrameNextOptions>(
    () => ({
      id: "petplay-raylib-torus-shadow",
      phase: "finish",
      fps: 60,
      drop: true,
    }),
    [],
  );
  useFrame(() => {
    updateShadowSceneMesh(0, {
      kind: "torus",
      position: [0, 1.45, -1.8],
      rotation: [0, accentRef.current.rotation.y, 0],
      scale: [1, 1, 1],
      color: [255, 139, 61, 255],
      wireColor: [255, 196, 148, 255],
    });
  }, shadowMirrorOpts);

  const roomLineColor = React.useMemo(() => new THREE.Color(0xbcbcbc), []);

  return (
    <>
      <color attach="background" args={[0x091018]} />
      <fog attach="fog" args={["#091018", 4, 10]} />
      <ambientLight intensity={0.8} />
      <directionalLight intensity={2.8} position={[2, 3, 2]} />
      <pointLight intensity={8} position={[0, 1.9, -1.25]} color="#ffb347" />
      {/* <XROrigin /> */}

      <mesh ref={accentRef} position={[0, 1.45, -1.8]}>
        <torusGeometry args={[0.12, 0.012, 16, 48]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xff8b3d)} />
      </mesh>
      {/* <RoomWireBox color={roomLineColor} /> */}

      <DisplayInstance
        position={[-0.75, 1.2, -1.45]}
        displayInstanceActor={displayInstanceActor}
      />
      {/*
        World-space keyboard: default pose matches petplay/keyboard/keyboard.ts constants;
        reorient with controller ray for typing toward the 16:9 overlay.
      */}
      <KeyboardPanel onKey={windowsSystemKeyboardSink} />
    </>
  );
}
