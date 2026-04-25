import React, { useRef } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { extend, type ThreeToJSXElements } from "@react-three/fiber/webgpu";
import { Handle } from "@react-three/handle";
import {
  DEFAULT_KEYBOARD_JSON_URL,
  DEFAULT_KEYBOARD_PIXEL_SIZE,
  KeyboardFromJson,
} from "./keyboardUi.tsx";
import type { WorldKeyboardPanelProps } from "./types.ts";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

declare module "@react-three/fiber/webgpu" {
  // deno-lint-ignore no-empty-interface
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

/** Meters. In front and slightly to the right of the default [DisplayInstance](displayInstance) frame. */
export const DEFAULT_KEYBOARD_POSITION: [number, number, number] = [0.45, 0.72, -1.32];
export const DEFAULT_KEYBOARD_ROTATION: [number, number, number] = [0, -0.38, 0];
export const DEFAULT_KEYBOARD_SCALE: [number, number, number] = [0.38, 0.38, 0.38];

export { DEFAULT_KEYBOARD_JSON_URL, DEFAULT_KEYBOARD_PIXEL_SIZE } from "./keyboardUi.tsx";

/**
 * World-space shell: R3F `group` + `Handle` + [KeyboardFromJson](keyboardUi.tsx) (JSON layout, modifiers, uikit).
 */
export function KeyboardPanel(
  {
    position = DEFAULT_KEYBOARD_POSITION,
    rotation = DEFAULT_KEYBOARD_ROTATION,
    scale = DEFAULT_KEYBOARD_SCALE,
    onKey,
    layoutUrl = DEFAULT_KEYBOARD_JSON_URL,
  }: WorldKeyboardPanelProps = {},
) {
  const handleRef = useRef<THREE.Object3D | null>(null);

  return (
    <group
      position={position}
      rotation={new THREE.Euler(...rotation, "XYZ")}
      scale={scale}
      userData={{ keyboard: true, worldKeyboard: true }}
    >
      {/* ref matches runtime object; `never` bridges conflicting Object3D typings in deps */}
      <Handle handleRef={handleRef as never} multitouch>
        <group ref={handleRef}>
          <KeyboardFromJson
            layoutUrl={layoutUrl}
            onKey={onKey}
            pixelSize={DEFAULT_KEYBOARD_PIXEL_SIZE}
          />
        </group>
      </Handle>
    </group>
  );
}
