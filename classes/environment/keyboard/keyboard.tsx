import React, { useEffect, useMemo, useRef, useState } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { extend, type ThreeToJSXElements } from "@react-three/fiber/webgpu";
import type { HandleOptions, HandleStore } from "@pmndrs/handle";
import { GRABBOX_CHROME_THICKNESS, GrabBox } from "../grabbox.tsx";
import {
  getDefaultKeyboardLayoutSync,
  isDefaultKeyboardLayoutUrl,
} from "./defaultLayoutPreload.ts";
import {
  DEFAULT_KEYBOARD_JSON_URL,
  getKeyboardLayoutMode,
  DEFAULT_KEYBOARD_PIXEL_SIZE,
  KeyboardFromJson,
} from "./keyboardUi.tsx";
import { keyboardContentBoundsUnits } from "./keyboardLayout.ts";
import { keyboardFormatFor, resolveKeyboardLocale, useKeyboardLocale } from "./keyboardLocale.ts";
import { stripJsonComments } from "./parseJsonComments.ts";
import type { KeyboardLayoutJson, WorldKeyboardPanelProps } from "./types.ts";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

declare module "@react-three/fiber/webgpu" {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

/** Meters. In front and slightly to the right of the default [DisplayInstance](displayInstance) frame. */
export const DEFAULT_KEYBOARD_POSITION: [number, number, number] = [0.45, 0.72, -1.32];
export const DEFAULT_KEYBOARD_ROTATION: [number, number, number] = [0, -0.38, 0];
export const DEFAULT_KEYBOARD_SCALE: [number, number, number] = [0.38, 0.38, 0.38];

export {
  DEFAULT_KEYBOARD_JSON_URL,
  getKeyboardLayoutMode,
  DEFAULT_KEYBOARD_PIXEL_SIZE,
} from "./keyboardUi.tsx";

const FALLBACK_GRAB: readonly [number, number, number] = [0.5, 0.2, 0.04];
/** Keyboard chrome reads magenta so it is never mistaken for a display's box. */
const KEYBOARD_GRABBOX_LINE_COLOR = 0xff00ff;

export type KeyboardPanelProps = WorldKeyboardPanelProps & {
  manipulationTargetRef?: React.RefObject<THREE.Object3D | null>;
  manipulationOptions?: Omit<HandleOptions<unknown>, "filter">;
  manipulationStoreRef?: React.Ref<HandleStore<unknown>>;
  onGrabBoxSize?: (size: [number, number, number]) => void;
  onSpatialFocus?: () => void;
  children?: React.ReactNode;
};

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
    layoutFormat,
    locale: localeProp,
    contentOffset = [0, 0, 0],
    grabLineColor = KEYBOARD_GRABBOX_LINE_COLOR,
    layoutMode = getKeyboardLayoutMode(),
    manipulationTargetRef,
    manipulationOptions,
    manipulationStoreRef,
    onGrabBoxSize,
    onSpatialFocus,
    children,
  }: KeyboardPanelProps = {},
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

  const storeLocale = useKeyboardLocale();
  const locale = localeProp == null ? storeLocale : resolveKeyboardLocale(localeProp);
  const format = keyboardFormatFor(locale, layoutFormat);

  const boundsUnits = useMemo(
    () => (layoutReady != null
      ? keyboardContentBoundsUnits(layoutReady, format, layoutMode, locale)
      : null),
    [layoutReady, format, layoutMode, locale],
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

  useEffect(() => {
    onGrabBoxSize?.(grabSize);
  }, [grabSize, onGrabBoxSize]);

  return (
    <group
      position={position}
      rotation={new THREE.Euler(...rotation, "XYZ")}
      scale={scale}
      userData={{ keyboard: true, worldKeyboard: true }}
      {...({
        // Display ray-hit proxies use order 1. Keep the entire keyboard ahead
        // of them for interaction even when its surface is physically farther away.
        pointerEventsOrder: 2,
      } as Record<string, unknown>)}
    >
      {layoutReady != null
        ? (
          <GrabBox
            ref={handleRef}
            width={grabSize[0]}
            height={grabSize[1]}
            depth={grabSize[2]}
            lineColor={grabLineColor}
            shellRayPickable={false}
            manipulationTargetRef={manipulationTargetRef}
            manipulationOptions={manipulationOptions}
            manipulationStoreRef={manipulationStoreRef}
            onSpatialFocus={onSpatialFocus}
            grabFilter={(event) => event.pointerType !== "ray" && event.pointerType !== "poker"}
          >
            <group
              position={contentOffset}
              {...({ pointerEventsType: { deny: "grab" } } as Record<string, unknown>)}
            >
              <KeyboardFromJson
                preloadedLayout={layoutReady}
                onKey={onKey}
                layoutFormat={format}
                locale={locale.id}
                layoutMode={layoutMode}
                pixelSize={pixel}
              />
            </group>
            {
              /*
               * Depth-only occluder, the same trick a display's screen surface uses: it paints
               * nothing but depth, drawn first, so anything depth-tested later that sits behind the
               * board fails against it — other objects' chrome, and the box's own rear bars, which
               * makes the grab box read as a frame around the board instead of a wireframe cube.
               * Not pickable: the keys and the grab hull own pointer input here.
               */
            }
            <mesh
              position={[0, 0, -grabSize[2] / 2 + GRABBOX_CHROME_THICKNESS]}
              renderOrder={-100}
              {...({ pointerEvents: "none" } as Record<string, unknown>)}
            >
              <planeGeometry args={[grabSize[0], grabSize[1]]} />
              <meshBasicMaterial
                depthTest
                depthWrite
                colorWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
            {children}
          </GrabBox>
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
