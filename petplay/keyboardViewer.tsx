import React from "react";
import {
  KeyboardPanel,
  windowsSystemKeyboardSink,
} from "../classes/environment/keyboard/keyboard.tsx";
import type { KeyboardSink } from "../classes/environment/keyboard/types.ts";
import {
  OrbitHandlesView,
  type RaylibR3FViewerSceneProps,
  runRaylibR3FViewerApp,
  SceneCameraAim,
} from "./raylibR3FViewerApp.tsx";

const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 900;
const DEFAULT_TITLE = "PetPlay Keyboard Viewer";
const KEYB_LOG = "[keybViewer]";
const ENABLE_WINDOWS_KEYS_ARG = "--send-windows-keys";
/**
 * Orbit / pan focus — matches [KeyboardPanel](keyboard.tsx) default placement so pan/zoom stay centered on the keys.
 * Camera sits in front, slightly above the home row.
 */
const KEYB_AIM_ORIGIN: [number, number, number] = [0.45, 0.72, -1.32];
const KEYB_CAMERA: [number, number, number] = [0, 0.88, 0.42];

function KeyboardViewerScene(
  { controlsStore, logPrefix }: RaylibR3FViewerSceneProps,
) {
  const keyboardSink = React.useMemo<KeyboardSink>(() => {
    if (Deno.args.includes(ENABLE_WINDOWS_KEYS_ARG)) {
      return windowsSystemKeyboardSink;
    }
    return (ev) => {
      console.log(`${logPrefix} keyboard event`, ev);
    };
  }, [logPrefix]);

  return (
    <>
      <SceneCameraAim controlsStore={controlsStore} logPrefix={logPrefix} />
      <React.Suspense fallback={null}>
        <OrbitHandlesView controlsStore={controlsStore} logPrefix={logPrefix} />
      </React.Suspense>
      <color attach="background" args={[0x0a0f16]} />
      <ambientLight intensity={1.35} />
      <directionalLight intensity={2.4} position={[1.8, 3.5, 1.2]} />
      <pointLight intensity={9} position={[0.4, 1.4, 0.2]} color="#e8c8a0" />
      <mesh position={[0, 1.35, -2.4]}>
        <planeGeometry args={[4.2, 2.8]} />
        <meshStandardMaterial color="#121a2a" roughness={0.92} metalness={0.04} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.55, -1.2]} receiveShadow>
        <planeGeometry args={[4.5, 4.5]} />
        <meshStandardMaterial color="#0e1522" roughness={1} metalness={0} />
      </mesh>
      <KeyboardPanel onKey={keyboardSink} />
    </>
  );
}

if (import.meta.main) {
  await runRaylibR3FViewerApp({
    defaultTitle: DEFAULT_TITLE,
    logPrefix: KEYB_LOG,
    defaultWidth: DEFAULT_WIDTH,
    defaultHeight: DEFAULT_HEIGHT,
    aim: {
      aimOrigin: KEYB_AIM_ORIGIN,
      cameraPosition: KEYB_CAMERA,
      fov: 55,
    },
    renderExtractionId: "desktop-keyboard-viewer",
    Scene: KeyboardViewerScene,
    logDependencyVersions: false,
  }).catch((error) => {
    console.error(error);
    Deno.exit(1);
  });
}
