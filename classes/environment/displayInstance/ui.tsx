import React, { forwardRef, useMemo } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { extend, type ThreeToJSXElements } from "@react-three/fiber/webgpu";
import { DEFAULT_GRABBOX_LINE_COLOR, GrabBox } from "../grabbox.tsx";

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
    },
    ref,
  ) {
    const width = useMemo(
      () => height * DISPLAY_ASPECT_WIDTH_OVER_HEIGHT,
      [height],
    );
    return (
      <GrabBox
        ref={ref}
        width={width}
        height={height}
        depth={depth}
        lineColor={lineColor}
        shellRayPickable={shellRayPickable}
      />
    );
  },
);
