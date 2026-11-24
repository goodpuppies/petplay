/**
 * World-space floating Settings Window for VR (`SettingsWindow` inside a standard `GrabBox`).
 *
 * Opens in front of the user's head (~1.15 m out, level yaw, +Z facing the user) whenever the
 * Settings button on the wrist menu is pressed, uses the same `GrabBox` system as displays and
 * the keyboard (grab/reposition/scale with squeeze, trigger rays press UI controls), and includes
 * a depth-only occluder plane so background geometry stays behind it.
 */
import React, { useEffect, useRef } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { useThree } from "@react-three/fiber/webgpu";
import { GrabBox, GRABBOX_CHROME_THICKNESS } from "./grabbox.tsx";
import {
  SETTINGS_WINDOW_HEIGHT,
  SETTINGS_WINDOW_WIDTH,
  SettingsWindow,
} from "./ui/settingsWindow.tsx";
import { setSettingsWindowOpen, useSettingsWindowOpen } from "./settingsWindowStore.ts";

/** Metres per uikit pixel in VR (~0.88 m × 0.56 m floating window). */
const VR_PIXEL_SIZE = 0.00085;
const WINDOW_WIDTH_M = SETTINGS_WINDOW_WIDTH * VR_PIXEL_SIZE;
const WINDOW_HEIGHT_M = SETTINGS_WINDOW_HEIGHT * VR_PIXEL_SIZE;
const WINDOW_DEPTH_M = 0.025;
const SPAWN_DISTANCE_M = 1.15;
const SPAWN_DROP_M = -0.05;

const _headPos = new THREE.Vector3();
const _headQuat = new THREE.Quaternion();
const _forward = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _lookMatrix = new THREE.Matrix4();

export function SettingsWindowOverlay() {
  const open = useSettingsWindowOpen();
  const groupRef = useRef<THREE.Group>(null);
  const camera = useThree((state) => state.camera);
  const renderer = useThree((state) => state.renderer);

  // Place cleanly in front of the user's gaze each time the window is opened.
  useEffect(() => {
    if (!open) return;
    const node = groupRef.current;
    if (!node) return;

    const xr = (renderer as unknown as {
      xr?: { getCamera?: (cam: THREE.Camera) => THREE.Camera };
    }).xr;
    const head = Deno.args.includes("--desktop")
      ? camera
      : xr?.getCamera?.(camera as unknown as THREE.Camera) ?? camera;
    head.updateWorldMatrix(true, false);
    head.getWorldPosition(_headPos);
    head.getWorldQuaternion(_headQuat);

    // Flatten forward vector onto XZ plane so the window stands upright facing the user.
    _forward.set(0, 0, -1).applyQuaternion(_headQuat);
    _forward.y = 0;
    if (_forward.lengthSq() < 1e-4) _forward.set(0, 0, -1);
    else _forward.normalize();

    node.position.copy(_headPos)
      .addScaledVector(_forward, SPAWN_DISTANCE_M);
    node.position.y += SPAWN_DROP_M;

    // `Matrix4.lookAt(eye, target, up)` aims -Z from eye to target, so passing
    // `(_headPos, node.position)` points local +Z (the front of the UI) straight at the user.
    _lookMatrix.lookAt(_headPos, node.position, _up);
    node.quaternion.setFromRotationMatrix(_lookMatrix);
    node.scale.setScalar(1);
    node.updateMatrixWorld(true);
  }, [open, camera, renderer]);

  if (!open) return null;

  const dismiss = () => setSettingsWindowOpen(false);

  return (
    <group
      ref={groupRef}
      userData={{ settingsWindowOverlay: true }}
      {...({ pointerEventsOrder: 20 } as Record<string, unknown>)}
    >
      <GrabBox
        manipulationTargetRef={groupRef}
        manipulationOptions={{ triggerResize: { carryWithController: true } }}
        width={WINDOW_WIDTH_M}
        height={WINDOW_HEIGHT_M}
        depth={WINDOW_DEPTH_M}
        shellRayPickable={false}
        onDismiss={dismiss}
        grabFilter={(event) => event.pointerType !== "ray" && event.pointerType !== "poker"}
      >
        <group
          userData={{ bridge: { kind: "skip" } }}
          {...({ pointerEventsType: { deny: "grab" } } as Record<string, unknown>)}
        >
          <SettingsWindow
            pixelSize={VR_PIXEL_SIZE}
            onClose={dismiss}
          />
        </group>
        {/* Depth-only occluder so rear grab-box bars and world geometry stay behind the window. */}
        <mesh
          position={[0, 0, -WINDOW_DEPTH_M / 2 + GRABBOX_CHROME_THICKNESS]}
          renderOrder={-100}
          {...({ pointerEvents: "none" } as Record<string, unknown>)}
        >
          <planeGeometry args={[WINDOW_WIDTH_M, WINDOW_HEIGHT_M]} />
          <meshBasicMaterial
            depthTest
            depthWrite
            colorWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      </GrabBox>
    </group>
  );
}
