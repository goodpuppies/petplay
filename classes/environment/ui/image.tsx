/**
 * Image primitive.
 *
 * An image here is a **panel fill**, not an element placed inside a panel. That
 * is what makes it clip to a rounded corner: ancestor clipping in the panel
 * shader is four half-space planes — an axis-aligned rectangle with no notion of
 * corner radius — so a child sitting in a rounded corner would fill the area the
 * curve cuts away. Drawn as the fill, the image goes through the very same
 * rounded-rect SDF the flat background uses, and gets the identical corner.
 *
 * It also cannot be a textured mesh: the wrist menu subtree is marked
 * `bridge: { kind: "skip" }`, so raythree never extracts anything beneath it and
 * a mesh would silently never draw. The UI snapshot is the only route in.
 *
 * Scope is deliberately small — a named texture from the renderer's registry,
 * sized by uikit layout. Full uikit/raythree image support (arbitrary sources,
 * dynamic pixels) can come later; this covers the static cases.
 */
import React, { useMemo } from "react";
import { Content } from "../../../submodules/threewebxrwebgpudeno/uikit-r3f.tsx";
import type { WebXRRaythreeUiImageUserData } from "../../webxrRaythreeUi.ts";
import { clampRadius } from "./tokens.ts";

export type UiImageProps = {
  /** Key into the renderer's texture registry (`UI_TEXTURE_PATHS`). */
  texture: string;
  width: number;
  height: number;
  /** Uniform corner radius; clamped to half the smaller side, as everywhere else. */
  radius?: number;
  fit?: "cover" | "stretch";
  /**
   * Focal point for `cover`, 0..1. `[1, 0.5]` keeps the right edge — which is
   * what the clock wallpaper wants.
   */
  focus?: [number, number];
  opacity?: number;
};

export function UiImage(
  { texture, width, height, radius = 0, fit = "cover", focus = [0.5, 0.5], opacity = 1 }:
    UiImageProps,
) {
  const userData = useMemo(() => {
    const r = clampRadius(radius, width, height);
    const data: WebXRRaythreeUiImageUserData = {
      texture,
      width,
      height,
      borderRadius: [r, r, r, r],
      fit,
      focus,
      opacity,
    };
    return { raythreeUiImage: data };
  }, [texture, width, height, radius, fit, focus[0], focus[1], opacity]);

  // `Content` measures its child's bounding box and scales it to fill the
  // content box, so the child must be a **unit** quad: its `matrixWorld` then
  // maps a 1x1 quad exactly onto the laid-out box, and the renderer needs no
  // scale of its own. An empty object has no bounding box to measure and yields
  // a meaningless scale instead (observed: 120000).
  //
  // Nothing here is drawn by three — the mesh exists to be measured and to
  // carry the metadata the UI snapshot collects.
  // Absolutely positioned: a fill covers its parent rather than taking a slot
  // in the parent's flex flow, so siblings lay out as if it were not there.
  return (
    <Content
      width={width}
      height={height}
      flexShrink={0}
      positionType="absolute"
      positionLeft={0}
      positionTop={0}
    >
      <mesh userData={userData} raycast={() => null}>
        <planeGeometry args={[1, 1]} />
      </mesh>
    </Content>
  );
}
