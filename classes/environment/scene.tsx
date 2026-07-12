import React, { useRef } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import {
  extend,
  type ThreeToJSXElements,
  useFrame,
  type UseFrameNextOptions,
} from "@react-three/fiber/webgpu";
import { updateShadowSceneMesh } from "../webxrShadowScene.ts";
import { getVrcCameraDebugSnapshot } from "../vrcCameraDebugState.ts";
import { BoxLineGeometry } from "three/addons/geometries/BoxLineGeometry.js";
import { DisplayInstance } from "./displayInstance/logic.tsx";
import { windowsSystemDisplayMouseSink } from "./displayInstance/mouse.ts";
import { KeyboardPanel, windowsSystemKeyboardSink } from "./keyboard/keyboard.tsx";
import { SpatialAudioProvider } from "./spatialAudio.tsx";
import { getPointerById } from "../../submodules/threewebxrwebgpudeno/submodules/xr/packages/pointer-events/src/pointer.ts";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

// The handle package expects this pointer-events side effect on the *same*
// Three Object3D constructor used by our scene. Pinning Three to a commit made
// its implicit load order unreliable, so make the bridge explicit here.
const object3DPrototype = THREE.Object3D.prototype as THREE.Object3D & {
  setPointerCapture?: (pointerId: number) => void;
  releasePointerCapture?: (pointerId: number) => void;
  hasPointerCapture?: (pointerId: number) => boolean;
};
object3DPrototype.setPointerCapture ??= function (this: THREE.Object3D, pointerId: number) {
  getPointerById(pointerId)?.setCapture(this as never);
};
object3DPrototype.releasePointerCapture ??= function (this: THREE.Object3D, pointerId: number) {
  const pointer = getPointerById(pointerId);
  if (pointer?.hasCaptured(this as never)) pointer.setCapture(undefined);
};
object3DPrototype.hasPointerCapture ??= function (this: THREE.Object3D, pointerId: number) {
  return getPointerById(pointerId)?.hasCaptured(this as never) ?? false;
};

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

function VrcCameraDebugVisuals() {
  const cameraGroupRef = useRef<THREE.Group>(null!);
  const lookAtTargetRef = useRef<THREE.Mesh>(null!);
  const legacyOriginRef = useRef<THREE.Group>(null!);

  const frameOpts = React.useMemo<UseFrameNextOptions>(
    () => ({ id: "petplay-vrc-camera-debug" }),
    [],
  );

  useFrame(() => {
    const snapshot = getVrcCameraDebugSnapshot();
    const pose = snapshot.relativeCameraPose;

    if (pose) {
      cameraGroupRef.current.visible = true;
      cameraGroupRef.current.position.set(
        pose.position[0],
        pose.position[1],
        pose.position[2],
      );
      cameraGroupRef.current.rotation.set(
        THREE.MathUtils.degToRad(pose.rotationDeg[0]),
        THREE.MathUtils.degToRad(pose.rotationDeg[1]),
        THREE.MathUtils.degToRad(pose.rotationDeg[2]),
      );
    } else {
      cameraGroupRef.current.visible = false;
    }

    if (snapshot.lookAtTargetEstimate) {
      lookAtTargetRef.current.visible = true;
      lookAtTargetRef.current.position.set(
        snapshot.lookAtTargetEstimate[0],
        snapshot.lookAtTargetEstimate[1],
        snapshot.lookAtTargetEstimate[2],
      );
    } else {
      lookAtTargetRef.current.visible = false;
    }

    if (snapshot.legacyOriginMatrix) {
      const m = snapshot.legacyOriginMatrix;
      legacyOriginRef.current.visible = true;
      legacyOriginRef.current.matrix.set(
        m[0][0],
        m[0][1],
        m[0][2],
        m[0][3],
        m[1][0],
        m[1][1],
        m[1][2],
        m[1][3],
        m[2][0],
        m[2][1],
        m[2][2],
        m[2][3],
        0,
        0,
        0,
        1,
      );
    } else {
      legacyOriginRef.current.visible = false;
    }
  }, frameOpts);

  return (
    <>
      <group ref={cameraGroupRef} visible={false}>
        <mesh>
          <sphereGeometry args={[0.08, 16, 12]} />
          <meshBasicNodeMaterial colorNode={TSL.color(0x00d1ff)} />
        </mesh>
        <mesh position={[0, 0, -0.18]}>
          <boxGeometry args={[0.03, 0.03, 0.36]} />
          <meshBasicNodeMaterial colorNode={TSL.color(0x6ee7ff)} />
        </mesh>
        <mesh position={[0.13, 0, 0]}>
          <boxGeometry args={[0.26, 0.02, 0.02]} />
          <meshBasicNodeMaterial colorNode={TSL.color(0xff5c7a)} />
        </mesh>
        <mesh position={[0, 0.13, 0]}>
          <boxGeometry args={[0.02, 0.26, 0.02]} />
          <meshBasicNodeMaterial colorNode={TSL.color(0x7cff6b)} />
        </mesh>
      </group>
      <mesh ref={lookAtTargetRef} visible={false}>
        <torusGeometry args={[0.18, 0.008, 12, 48]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffd166)} />
      </mesh>
      <group ref={legacyOriginRef} visible={false} matrixAutoUpdate={false}>
        <mesh>
          <torusGeometry args={[0.24, 0.01, 12, 48]} />
          <meshBasicNodeMaterial colorNode={TSL.color(0xff4fd8)} />
        </mesh>
        <mesh position={[0.18, 0, 0]}>
          <boxGeometry args={[0.36, 0.025, 0.025]} />
          <meshBasicNodeMaterial colorNode={TSL.color(0xff5c7a)} />
        </mesh>
        <mesh position={[0, 0.18, 0]}>
          <boxGeometry args={[0.025, 0.36, 0.025]} />
          <meshBasicNodeMaterial colorNode={TSL.color(0x7cff6b)} />
        </mesh>
        <mesh position={[0, 0, 0.18]}>
          <boxGeometry args={[0.025, 0.025, 0.36]} />
          <meshBasicNodeMaterial colorNode={TSL.color(0x62a8ff)} />
        </mesh>
      </group>
    </>
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
      <VrcCameraDebugVisuals />
      {/* <RoomWireBox color={roomLineColor} /> */}

      <DisplayInstance
        position={[-0.75, 1.2, -1.45]}
        displayInstanceActor={displayInstanceActor}
        onMouse={windowsSystemDisplayMouseSink}
      />
      {
        /*
        World-space keyboard: default pose matches petplay/keyboard/keyboard.ts constants;
        reorient with controller ray for typing toward the 16:9 overlay.
      */
      }
      <SpatialAudioProvider>
        <KeyboardPanel onKey={windowsSystemKeyboardSink} />
      </SpatialAudioProvider>
    </>
  );
}
