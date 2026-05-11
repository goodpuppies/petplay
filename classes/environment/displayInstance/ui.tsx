import type { PointerEvent as PenPointerEvent } from "@pmndrs/pointer-events";
import React, { forwardRef, useCallback, useEffect, useMemo, useRef } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { extend, type ThreeToJSXElements } from "@react-three/fiber/webgpu";
import { DEFAULT_GRABBOX_LINE_COLOR, GrabBox } from "../grabbox.tsx";
import type { DisplayMouseButton, DisplayMouseSink } from "./mouse.ts";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

declare module "@react-three/fiber/webgpu" {
  // deno-lint-ignore no-empty-interface
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

/** 16:9 content aspect (width = height × this value). */
export const DISPLAY_ASPECT_WIDTH_OVER_HEIGHT = 16 / 9;

/** Default full-height of the display frame in scene units (meters). */
export const DEFAULT_DISPLAY_HEIGHT = 0.5;

/** Default depth of the thin box “screen” volume. */
export const DEFAULT_DISPLAY_DEPTH = 0.04;

/** @deprecated Use [DEFAULT_GRABBOX_LINE_COLOR](grabbox.tsx). */
export const DEFAULT_LINE_COLOR = DEFAULT_GRABBOX_LINE_COLOR;

const STABLE_CLICK_HOLD_MS = 180;

export type DisplayInstanceFrameProps = {
  /** Full height of the 16:9 frame. Width = height × `DISPLAY_ASPECT_WIDTH_OVER_HEIGHT`. */
  height?: number;
  depth?: number;
  /** Albedo / tint; same prop name as before. */
  lineColor?: number;
  /**
   * When `false` (default), the trigger **ray** ignores the wire hull; squeeze `grab` still collides — same
   * pattern as the keyboard `GrabBox` so you can aim with the laser and squeeze to move the display.
   */
  shellRayPickable?: boolean;
  /**
   * Native OpenVR overlays are not part of the Three.js scene, so ray beams need a local invisible
   * proxy surface to stop on the display instead of extending through it.
   */
  rayHitSurface?: boolean;
  /** Optional display-space mouse sink; receives normalized 0..1 coordinates on the screen plane. */
  onMouse?: DisplayMouseSink;
};

function pointerButton(button: number | undefined): DisplayMouseButton {
  switch (button) {
    case 1:
      return "middle";
    case 2:
      return "right";
    default:
      return "left";
  }
}

function displayCoordsFromPointerEvent(e: PenPointerEvent): { x: number; y: number } | null {
  const uv = e.uv;
  if (uv == null) return null;
  return {
    x: Math.min(1, Math.max(0, uv.x)),
    y: Math.min(1, Math.max(0, 1 - uv.y)),
  };
}

type DisplayMousePoint = { x: number; y: number };

type PendingDisplayClick = {
  pointerId: number;
  button: DisplayMouseButton;
  start: DisplayMousePoint;
  latest: DisplayMousePoint;
  timer: number;
  dragStarted: boolean;
};

/**
 * Visual-only 16:9 thin box — a [GrabBox](grabbox.tsx) with fixed aspect. Wireframe and raylib
 * mirroring are documented on `GrabBox`.
 */
export const DisplayInstanceFrame = forwardRef<THREE.Group, DisplayInstanceFrameProps>(
  function DisplayInstanceFrame(
    {
      height = DEFAULT_DISPLAY_HEIGHT,
      depth = DEFAULT_DISPLAY_DEPTH,
      lineColor = DEFAULT_LINE_COLOR,
      shellRayPickable = false,
      rayHitSurface = true,
      onMouse,
    },
    ref,
  ) {
    const width = useMemo(
      () => height * DISPLAY_ASPECT_WIDTH_OVER_HEIGHT,
      [height],
    );
    const pendingClickRef = useRef<PendingDisplayClick | null>(null);

    const clearPendingTimer = useCallback((pending: PendingDisplayClick) => {
      clearTimeout(pending.timer);
    }, []);

    const beginDrag = useCallback((pending: PendingDisplayClick) => {
      if (onMouse == null || pending.dragStarted) return;
      pending.dragStarted = true;
      onMouse({ kind: "move", ...pending.start });
      onMouse({ kind: "button", button: pending.button, pressed: true, ...pending.start });
      onMouse({ kind: "move", ...pending.latest });
    }, [onMouse]);

    useEffect(() => {
      return () => {
        const pending = pendingClickRef.current;
        if (pending == null) return;
        clearPendingTimer(pending);
        if (pending.dragStarted) {
          onMouse?.({ kind: "button", button: pending.button, pressed: false, ...pending.latest });
        }
        pendingClickRef.current = null;
      };
    }, [clearPendingTimer, onMouse]);

    const emitMove = useCallback((e: PenPointerEvent) => {
      if (onMouse == null) return;
      const coords = displayCoordsFromPointerEvent(e);
      if (coords == null) return;
      e.stopPropagation();
      const pending = pendingClickRef.current;
      if (pending != null && pending.pointerId === e.pointerId) {
        pending.latest = coords;
        if (pending.dragStarted) {
          onMouse({ kind: "move", ...coords });
        }
        return;
      }
      onMouse({ kind: "move", ...coords });
    }, [onMouse]);

    const emitButton = useCallback((e: PenPointerEvent, pressed: boolean, cancelled = false) => {
      if (onMouse == null) return;
      const coords = displayCoordsFromPointerEvent(e);
      if (coords == null) return;
      e.stopPropagation();
      const object = e.currentTarget as unknown as THREE.Object3D & {
        setPointerCapture?: (pointerId: number) => void;
        releasePointerCapture?: (pointerId: number) => void;
      };
      if (pressed) {
        object.setPointerCapture?.(e.pointerId);
        const previous = pendingClickRef.current;
        if (previous != null) {
          clearPendingTimer(previous);
          if (previous.dragStarted) {
            onMouse({
              kind: "button",
              button: previous.button,
              pressed: false,
              ...previous.latest,
            });
          }
        }
        const pending: PendingDisplayClick = {
          pointerId: e.pointerId,
          button: pointerButton(e.nativeEvent.button),
          start: coords,
          latest: coords,
          timer: 0,
          dragStarted: false,
        };
        pending.timer = setTimeout(() => beginDrag(pending), STABLE_CLICK_HOLD_MS);
        pendingClickRef.current = pending;
      } else {
        object.releasePointerCapture?.(e.pointerId);
        const pending = pendingClickRef.current;
        if (pending != null && pending.pointerId === e.pointerId) {
          pendingClickRef.current = null;
          clearPendingTimer(pending);
          if (pending.dragStarted) {
            onMouse({ kind: "move", ...coords });
            onMouse({ kind: "button", button: pending.button, pressed: false, ...coords });
          } else if (!cancelled) {
            onMouse({ kind: "move", ...pending.start });
            onMouse({ kind: "button", button: pending.button, pressed: true, ...pending.start });
            onMouse({ kind: "button", button: pending.button, pressed: false, ...pending.start });
          }
          return;
        }
        onMouse({
          kind: "button",
          button: pointerButton(e.nativeEvent.button),
          pressed: false,
          ...coords,
        });
      }
    }, [beginDrag, clearPendingTimer, onMouse]);

    return (
      <GrabBox
        ref={ref}
        width={width}
        height={height}
        depth={depth}
        lineColor={lineColor}
        shellRayPickable={shellRayPickable}
      >
        {rayHitSurface
          ? (
            <mesh
              renderOrder={-100}
              userData={{ displayInstanceRayHitSurface: true }}
              onPointerMove={emitMove}
              onPointerDown={(e: PenPointerEvent) => emitButton(e, true)}
              onPointerUp={(e: PenPointerEvent) => emitButton(e, false)}
              onPointerCancel={(e: PenPointerEvent) => emitButton(e, false, true)}
              {...({
                pointerEvents: "auto",
                pointerEventsType: { allow: "ray" },
              } as Record<string, unknown>)}
            >
              <planeGeometry args={[width, height]} />
              <meshBasicMaterial
                depthTest
                depthWrite
                colorWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
          )
          : null}
      </GrabBox>
    );
  },
);
