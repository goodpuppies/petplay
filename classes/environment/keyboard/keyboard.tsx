import React, { useEffect, useMemo, useRef, useState } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { extend, type ThreeToJSXElements } from "@react-three/fiber/webgpu";
import { Handle } from "@react-three/handle";
import { DEFAULT_GRABBOX_LINE_COLOR, GrabBox } from "../grabbox.tsx";
import {
  getDefaultKeyboardLayoutSync,
  isDefaultKeyboardLayoutUrl,
} from "./defaultLayoutPreload.ts";
import {
  DEFAULT_KEYBOARD_JSON_URL,
  DEFAULT_KEYBOARD_PIXEL_SIZE,
  DEFAULT_KEYBOARD_LAYOUT_MODE,
  KeyboardFromJson,
} from "./keyboardUi.tsx";
import { keyboardContentBoundsUnits } from "./keyboardLayout.ts";
import { stripJsonComments } from "./parseJsonComments.ts";
import type { KeyboardLayoutJson, WorldKeyboardPanelProps } from "./types.ts";

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

export {
  DEFAULT_KEYBOARD_JSON_URL,
  DEFAULT_KEYBOARD_PIXEL_SIZE,
  DEFAULT_KEYBOARD_LAYOUT_MODE,
} from "./keyboardUi.tsx";

const FALLBACK_GRAB: readonly [number, number, number] = [0.5, 0.2, 0.04];

/**
 * World-space shell: R3F `group` + `Handle` + [GrabBox](grabbox.tsx) + [KeyboardFromJson](keyboardUi.tsx).
 */
export function KeyboardPanel(
  {
    position = DEFAULT_KEYBOARD_POSITION,
    rotation = DEFAULT_KEYBOARD_ROTATION,
    scale = DEFAULT_KEYBOARD_SCALE,
    onKey,
    layoutUrl = DEFAULT_KEYBOARD_JSON_URL,
    layoutFormat = "ansi",
    contentOffset = [0, 0, 0],
    grabLineColor = DEFAULT_GRABBOX_LINE_COLOR,
    layoutMode = DEFAULT_KEYBOARD_LAYOUT_MODE,
  }: WorldKeyboardPanelProps = {},
) {
  const handleRef = useRef<THREE.Group | null>(null);
  const [layoutReady, setLayoutReady] = useState<KeyboardLayoutJson | null>(() => {
    if (isDefaultKeyboardLayoutUrl(layoutUrl)) {
      return getDefaultKeyboardLayoutSync();
    }
    return null;
  });

  useEffect(() => {
    if (isDefaultKeyboardLayoutUrl(layoutUrl)) {
      setLayoutReady(getDefaultKeyboardLayoutSync());
      return;
    }
    setLayoutReady(null);
    let cancel = false;
    void (async () => {
      const text = await Deno.readTextFile(layoutUrl);
      if (cancel) return;
      setLayoutReady(JSON.parse(stripJsonComments(text)) as KeyboardLayoutJson);
    })();
    return () => {
      cancel = true;
    };
  }, [layoutUrl]);

  const boundsUnits = useMemo(
    () =>
      (layoutReady != null ? keyboardContentBoundsUnits(layoutReady, layoutFormat, layoutMode) : null),
    [layoutReady, layoutFormat, layoutMode],
  );

  const pixel = DEFAULT_KEYBOARD_PIXEL_SIZE;

  const grabSize = useMemo((): [number, number, number] => {
    if (boundsUnits == null) return [FALLBACK_GRAB[0], FALLBACK_GRAB[1], FALLBACK_GRAB[2]];
    return [
      Math.max(0.04, boundsUnits.width * pixel),
      Math.max(0.04, boundsUnits.height * pixel),
      Math.max(0.01, boundsUnits.depth * pixel),
    ];
  }, [boundsUnits, pixel]);

  return (
    <group
      position={position}
      rotation={new THREE.Euler(...rotation, "XYZ")}
      scale={scale}
      userData={{ keyboard: true, worldKeyboard: true }}
    >
      {layoutReady != null
        ? (
          <Handle
            handleRef={handleRef as unknown as React.RefObject<import("three").Object3D | null>}
            multitouch
            scale={{ uniform: true }}
            filter={(e) => e.pointerType !== "ray"}
          >
            <GrabBox
              ref={handleRef}
              width={grabSize[0]}
              height={grabSize[1]}
              depth={grabSize[2]}
              lineColor={grabLineColor}
              shellRayPickable={false}
            >
              <group
                position={contentOffset}
                {...({ pointerEventsType: { deny: "grab" } } as Record<string, unknown>)}
              >
                <KeyboardFromJson
                  preloadedLayout={layoutReady}
                  onKey={onKey}
                  layoutFormat={layoutFormat}
                  layoutMode={layoutMode}
                  pixelSize={pixel}
                />
              </group>
            </GrabBox>
          </Handle>
        )
        : null}
    </group>
  );
}

export {
  createWindowsSystemKeyboardSink,
  releaseWindowsSyntheticKeyboardState,
  releaseWindowsSyntheticKeyboardStateWithKm,
  windowsSystemKeyboardSink,
} from "./win32SystemKeyboard.ts";
