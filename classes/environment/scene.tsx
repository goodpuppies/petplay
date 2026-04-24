import React, { useRef } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import { extend, ThreeToJSXElements, useFrame } from "@react-three/fiber/webgpu";
import { Handle } from "@react-three/handle";
import {
  getShadowControllerSnapshot,
  getVRCOriginMatrixElements,
  isVRCOriginKnown,
  updateShadowSceneMesh,
} from "../webxrShadowScene.ts";
import { BoxLineGeometry } from "three/addons/geometries/BoxLineGeometry.js";


// deno-lint-ignore no-explicit-any
extend(THREE as any);

declare module "@react-three/fiber/webgpu" {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

type WebXRSceneProps = {
  XROrigin: React.ComponentType;
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
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color={color} />
    </lineSegments>
  );
}

function BouncingCube({ seed }: { seed: CubeSeed }) {
  const meshRef = React.useRef<THREE.Mesh>(null);
  const velocity = React.useRef(new THREE.Vector3(...seed.velocity));

  useFrame((_state, deltaSeconds) => {
    const mesh = meshRef.current;
    if (mesh === null) {
      return;
    }

    const delta = deltaSeconds * 60;
    velocity.current.multiplyScalar(1 - (0.001 * delta));
    mesh.position.addScaledVector(velocity.current, delta);

    if (mesh.position.x < -3 || mesh.position.x > 3) {
      mesh.position.x = THREE.MathUtils.clamp(mesh.position.x, -3, 3);
      velocity.current.x = -velocity.current.x;
    }

    if (mesh.position.y < 0 || mesh.position.y > 6) {
      mesh.position.y = THREE.MathUtils.clamp(mesh.position.y, 0, 6);
      velocity.current.y = -velocity.current.y;
    }

    if (mesh.position.z < -3 || mesh.position.z > 3) {
      mesh.position.z = THREE.MathUtils.clamp(mesh.position.z, -3, 3);
      velocity.current.z = -velocity.current.z;
    }

    mesh.rotation.x += velocity.current.x * 2 * delta;
    mesh.rotation.y += velocity.current.y * 2 * delta;
    mesh.rotation.z += velocity.current.z * 2 * delta;
  });

  return (
    <mesh
      ref={meshRef}
      position={seed.position}
      rotation={seed.rotation}
      scale={seed.scale}
    >
      <boxGeometry args={[0.15, 0.15, 0.15]} />
      <meshLambertMaterial color={seed.color} />
    </mesh>
  );
}

type CubeSeed = {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  color: THREE.Color;
  velocity: [number, number, number];
};

function createCubeSeed(): CubeSeed {
  return {
    position: [
      Math.random() * 4 - 2,
      Math.random() * 4,
      Math.random() * 4 - 2,
    ],
    rotation: [
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
    ],
    scale: [
      Math.random() + 0.5,
      Math.random() + 0.5,
      Math.random() + 0.5,
    ],
    color: new THREE.Color(Math.random() * 0xffffff),
    velocity: [
      Math.random() * 0.01 - 0.005,
      Math.random() * 0.01 - 0.005,
      Math.random() * 0.01 - 0.005,
    ],
  };
}
const CUBE_COUNT = 200;

export function WebXRScene({ XROrigin }: WebXRSceneProps) {
  const accentRef = useRef<THREE.Mesh>(null!);
  const boxRef = useRef<THREE.Mesh>(null!);
  // Group that mirrors the VRChat world origin in SteamVR absolute space.
  // Anything parented here gets expressed in VRC coordinates.
  const vrcOriginGroupRef = useRef<THREE.Group>(null!);
  const boxWorldPositionRef = useRef(new THREE.Vector3());
  const boxWorldQuaternionRef = useRef(new THREE.Quaternion());
  const boxWorldScaleRef = useRef(new THREE.Vector3());
  const boxWorldRotationRef = useRef(new THREE.Euler());

  // Trigger-to-teleport bookkeeping. We track the prior trigger state
  // per hand so we only teleport on the rising edge (press), not every
  // frame the trigger is held.
  const prevTriggerRef = useRef({ left: false, right: false });
  const vrcOriginMat4Ref = useRef(new THREE.Matrix4());
  const vrcOriginInvMat4Ref = useRef(new THREE.Matrix4());
  const handAbsMat4Ref = useRef(new THREE.Matrix4());
  const boxLocalMat4Ref = useRef(new THREE.Matrix4());
  const boxLocalPosRef = useRef(new THREE.Vector3());
  const cubes = React.useMemo(
    () => Array.from({ length: CUBE_COUNT }, () => createCubeSeed()),
    [],
  );

  useFrame((_state, delta) => {
    // Pull the latest VRC origin (updated by the webxr actor's ORIGINUPDATE
    // handler) and drive the wrapping group's matrix directly. Falls back to
    // identity until the first origin snapshot arrives.
    const vrcGroup = vrcOriginGroupRef.current;
    if (vrcGroup) {
      vrcGroup.matrixAutoUpdate = false;
      if (isVRCOriginKnown()) {
        vrcGroup.matrix.fromArray(getVRCOriginMatrixElements());
      } else {
        vrcGroup.matrix.identity();
      }
      vrcGroup.matrixWorldNeedsUpdate = true;
    }

    // Trigger-press → teleport the cube to the pressing hand.
    // The cube is a child of the VRC origin group, so its local position
    // is VRC-relative. To land it on a hand whose pose is expressed in
    // SteamVR absolute space, transform: boxLocal = inv(vrcOrigin) * handAbs.
    const teleportTarget = boxRef.current;
    const snapshot = getShadowControllerSnapshot();
    const hands: Array<"left" | "right"> = ["left", "right"];
    for (const hand of hands) {
      const slot = snapshot[hand];
      const prev = prevTriggerRef.current[hand];
      const now = slot.triggerPressed && slot.valid;
      if (now && !prev && teleportTarget) {
        handAbsMat4Ref.current.fromArray(slot.matrix);
        vrcOriginMat4Ref.current.fromArray(getVRCOriginMatrixElements());
        vrcOriginInvMat4Ref.current.copy(vrcOriginMat4Ref.current).invert();
        boxLocalMat4Ref.current
          .multiplyMatrices(vrcOriginInvMat4Ref.current, handAbsMat4Ref.current);
        boxLocalPosRef.current.setFromMatrixPosition(boxLocalMat4Ref.current);
        teleportTarget.position.copy(boxLocalPosRef.current);
      }
      prevTriggerRef.current[hand] = now;
    }

    accentRef.current.rotation.y += delta * 0.25;
    updateShadowSceneMesh(0, {
      kind: "torus",
      position: [0, 1.45, -1.8],
      rotation: [0, accentRef.current.rotation.y, 0],
      scale: [1, 1, 1],
      color: [255, 139, 61, 255],
      wireColor: [255, 196, 148, 255],
    });
    const box = boxRef.current;
    box.updateWorldMatrix(true, false);
    box.getWorldPosition(boxWorldPositionRef.current);
    box.getWorldQuaternion(boxWorldQuaternionRef.current);
    box.getWorldScale(boxWorldScaleRef.current);
    boxWorldRotationRef.current.setFromQuaternion(
      boxWorldQuaternionRef.current,
      box.rotation.order,
    );
    updateShadowSceneMesh(1, {
      kind: "cube",
      position: [
        boxWorldPositionRef.current.x,
        boxWorldPositionRef.current.y,
        boxWorldPositionRef.current.z,
      ],
      rotation: [
        boxWorldRotationRef.current.x,
        boxWorldRotationRef.current.y,
        boxWorldRotationRef.current.z,
      ],
      scale: [
        boxWorldScaleRef.current.x,
        boxWorldScaleRef.current.y,
        boxWorldScaleRef.current.z,
      ],
      color: [84, 214, 44, 220],
      wireColor: [160, 255, 132, 255],
    });
  });

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
      <RoomWireBox color={roomLineColor} />
      {cubes.map((seed, index) => (
        <BouncingCube key={index} seed={seed} />
      ))}

      {/*
        The cube lives inside the VRC-origin group so its local
        position [0.35, 1.2, -1.45] is interpreted in VRChat world
        space rather than raw SteamVR absolute space. The group's
        matrix is updated each frame in useFrame above.
      */}
      <group ref={vrcOriginGroupRef}>
        <Handle handleRef={boxRef} multitouch>
          <mesh ref={boxRef} position={[0.35, 1.2, -1.45]} scale={[0.18, 0.18, 0.18]}>
            <boxGeometry args={[1, 1, 1]} />
            <meshBasicNodeMaterial colorNode={TSL.color(0x54d62c)} />
          </mesh>
        </Handle>
      </group>
    </>
  );
}
