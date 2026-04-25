import React from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber/webgpu";
import { NativeHudPanel } from "../classes/environment/nativeFrontend.tsx";
import { KeyboardPanel } from "../classes/environment/keyboard/keyboard.tsx";
import {
  OrbitHandlesView,
  type RaylibR3FViewerSceneProps,
  runRaylibR3FViewerApp,
  SceneCameraAim,
} from "./raylibR3FViewerApp.tsx";

const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 900;
const DEFAULT_TITLE = "PetPlay UI Viewer";
const UI_LOG = "[uiViewer]";
/** Orbit / pan target — HUD + keyboard cluster */
const UI_AIM_ORIGIN: [number, number, number] = [0, 1.28, -1.45];
const UI_CAMERA: [number, number, number] = [0, 1.35, 0.65];

function UiViewerScene(
  { controlsStore, logPrefix }: RaylibR3FViewerSceneProps,
) {
  console.log(
    `${logPrefix} UiViewerScene rendering, controlsStore state:`,
    controlsStore.getState(),
  );
  React.useEffect(() => {
    console.log(`${logPrefix} UiViewerScene mounted`);
    const unsubscribe = controlsStore.subscribe((state) => {
      console.log(`${logPrefix} controlsStore state changed:`, state);
    });
    return () => {
      console.log(`${logPrefix} UiViewerScene unmounting`);
      unsubscribe();
    };
  }, [controlsStore, logPrefix]);

  return (
    <>
      <SceneCameraAim controlsStore={controlsStore} logPrefix={logPrefix} />
      <React.Suspense fallback={null}>
        <OrbitHandlesView controlsStore={controlsStore} logPrefix={logPrefix} />
      </React.Suspense>
      <color attach="background" args={[0x0b1018]} />
      <ambientLight intensity={1.25} />
      <directionalLight intensity={2.2} position={[2.5, 4, 2]} />
      <pointLight intensity={10} position={[0, 1.8, -1.2]} color="#ffd08a" />
      <Backdrop />
      <UiStand />
      <group>
        <NativeHudPanel
          transform={{
            position: [0, 1.32, -1.45],
            rotation: [0, 0, 0],
            scale: [1.4, 1.4, 1.4],
          }}
        />
        <KeyboardPanel
          position={[0.55, 0.95, -1.38]}
          rotation={[0, -0.32, 0]}
          scale={[0.4, 0.4, 0.4]}
        />
      </group>
    </>
  );
}

function Backdrop() {
  return (
    <>
      <mesh position={[0, 1.4, -2.6]}>
        <planeGeometry args={[5.5, 3.5]} />
        <meshStandardMaterial color="#162235" roughness={0.9} metalness={0.05} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.7, -1.5]} receiveShadow>
        <planeGeometry args={[5.5, 5.5]} />
        <meshStandardMaterial color="#111927" roughness={1} metalness={0} />
      </mesh>
    </>
  );
}

function UiStand() {
  const groupRef = React.useRef<THREE.Object3D | null>(null);
  const clock = useThree((s) => s.clock);

  useFrame(() => {
    if (groupRef.current === null) {
      return;
    }
    const group = groupRef.current as THREE.Object3D & {
      position: THREE.Vector3;
      rotation: THREE.Euler;
    };
    const t = clock.getElapsedTime();
    group.position.y = 1.02 + Math.sin(t * 0.8) * 0.015;
    group.rotation.y = Math.sin(t * 0.35) * 0.08;
  });

  return (
    <group ref={groupRef} position={[0, 1.02, -1.45]}>
      <mesh position={[0, -0.3, -0.01]}>
        <cylinderGeometry args={[0.018, 0.022, 0.62, 18]} />
        <meshStandardMaterial color="#475569" roughness={0.65} metalness={0.25} />
      </mesh>
      <mesh position={[0, -0.63, -0.02]}>
        <cylinderGeometry args={[0.2, 0.24, 0.06, 24]} />
        <meshStandardMaterial color="#1e293b" roughness={0.88} metalness={0.08} />
      </mesh>
    </group>
  );
}

if (import.meta.main) {
  await runRaylibR3FViewerApp({
    defaultTitle: DEFAULT_TITLE,
    logPrefix: UI_LOG,
    defaultWidth: DEFAULT_WIDTH,
    defaultHeight: DEFAULT_HEIGHT,
    aim: {
      aimOrigin: UI_AIM_ORIGIN,
      cameraPosition: UI_CAMERA,
      fov: 55,
    },
    renderExtractionId: "desktop-ui-viewer",
    Scene: UiViewerScene,
    logDependencyVersions: true,
  }).catch((error) => {
    console.error(error);
    Deno.exit(1);
  });
}
