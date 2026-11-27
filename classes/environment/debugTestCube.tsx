/**
 * Test cubes for comparing how 3D content holds its place (Settings → Debug).
 *
 * The orange cube is ordinary scene geometry: it is drawn into the eye image, which SteamVR shows
 * glued to the head, so it shares that image's latency. The teal cube is marked `nativeStereo`:
 * the renderer takes it out of the eye image and shows it on a SteamVR quad carrying one picture
 * per eye, drawn through the quad's rectangle from each eye's position
 * (docs/NATIVE_OVERLAYS.md). Bounce or sway while looking at both to compare.
 */
import React, { useEffect, useRef } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { useThree } from "@react-three/fiber/webgpu";
import { useDebugCube } from "./debugCubeStore.ts";
import { NATIVE_STEREO_CENTER, type NativeStereoUserData } from "../nativeOverlayContent.ts";

const CUBE_SIZE = 0.14;
const STUD_SIZE = 0.035;
/** Sphere around a cube's centre that holds the tilted cube and its studs. */
const CUBE_RADIUS = 0.19;
const SPAWN_DISTANCE_M = 0.85;
const SPAWN_DROP_M = 0.2;
const PAIR_SPACING_M = 0.42;
/** Tilted so three faces show: a face-on cube looks like a flat square. */
const CUBE_TILT: [number, number, number] = [0.5, 0.65, 0];
const NO_POINTER = { pointerEvents: "none" } as Record<string, unknown>;

const _headPos = new THREE.Vector3();
const _headQuat = new THREE.Quaternion();
const _forward = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _look = new THREE.Matrix4();

function TestCube(
  { x, color, native }: { x: number; color: string; native: boolean },
) {
  const mark: { nativeStereo?: NativeStereoUserData } = native
    ? { nativeStereo: { key: "debug-cube", radius: CUBE_RADIUS } }
    : {};
  const stud = CUBE_SIZE / 2 + STUD_SIZE / 2;
  return (
    <group position={[x, 0, 0]} userData={native ? { [NATIVE_STEREO_CENTER]: true } : {}}>
      <group rotation={CUBE_TILT}>
        <mesh userData={mark} {...NO_POINTER}>
          <boxGeometry args={[CUBE_SIZE, CUBE_SIZE, CUBE_SIZE]} />
          <meshStandardMaterial color={color} roughness={0.55} metalness={0} />
        </mesh>
        {/* One stud per axis, so depth and orientation read at a glance. */}
        <mesh position={[stud, 0, 0]} userData={mark} {...NO_POINTER}>
          <boxGeometry args={[STUD_SIZE, STUD_SIZE, STUD_SIZE]} />
          <meshBasicMaterial color="#ff4d4d" />
        </mesh>
        <mesh position={[0, stud, 0]} userData={mark} {...NO_POINTER}>
          <boxGeometry args={[STUD_SIZE, STUD_SIZE, STUD_SIZE]} />
          <meshBasicMaterial color="#5dff7a" />
        </mesh>
        <mesh position={[0, 0, stud]} userData={mark} {...NO_POINTER}>
          <boxGeometry args={[STUD_SIZE, STUD_SIZE, STUD_SIZE]} />
          <meshBasicMaterial color="#5aa2ff" />
        </mesh>
      </group>
    </group>
  );
}

export function DebugTestCubes() {
  const { mode, placement } = useDebugCube();
  const groupRef = useRef<THREE.Group>(null);
  const camera = useThree((state) => state.camera);
  const renderer = useThree((state) => state.renderer);
  const shown = mode !== "off";

  // In front of the head, a little below eye level, each time they are switched on or re-placed.
  useEffect(() => {
    const node = groupRef.current;
    if (!shown || !node) return;
    const xr = (renderer as unknown as {
      xr?: { getCamera?: (cam: THREE.Camera) => THREE.Camera };
    }).xr;
    const head = Deno.args.includes("--desktop")
      ? camera
      : xr?.getCamera?.(camera as unknown as THREE.Camera) ?? camera;
    head.updateWorldMatrix(true, false);
    head.getWorldPosition(_headPos);
    head.getWorldQuaternion(_headQuat);
    _forward.set(0, 0, -1).applyQuaternion(_headQuat);
    _forward.y = 0;
    if (_forward.lengthSq() < 1e-4) _forward.set(0, 0, -1);
    else _forward.normalize();
    node.position.copy(_headPos).addScaledVector(_forward, SPAWN_DISTANCE_M);
    node.position.y -= SPAWN_DROP_M;
    _headPos.y = node.position.y;
    _look.lookAt(_headPos, node.position, _up);
    node.quaternion.setFromRotationMatrix(_look);
    node.updateMatrixWorld(true);
  }, [shown, placement, camera, renderer]);

  if (!shown) return null;
  const pair = mode === "both";
  return (
    <group ref={groupRef} userData={{ debugTestCubes: true }}>
      {mode !== "native" && (
        <TestCube x={pair ? -PAIR_SPACING_M / 2 : 0} color="#ff8a3d" native={false} />
      )}
      {mode !== "layer" && <TestCube x={pair ? PAIR_SPACING_M / 2 : 0} color="#2fd3c2" native />}
    </group>
  );
}
