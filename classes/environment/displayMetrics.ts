/**
 * Single source of truth for the rendered display panel's size.
 *
 * The scene geometry ([displayInstance/ui.tsx](displayInstance/ui.tsx)) and the spatial attachment
 * geometry ([spatialGraph.ts](spatialGraph.ts)) both describe the same 16:9 panel. When the two
 * disagree, a hinge places the child by one size while the child is drawn at another and the panels
 * separate with a visible gap. Both sides therefore read these constants instead of restating them.
 */

/** 16:9 content aspect (width = height × this value). */
export const DISPLAY_ASPECT_WIDTH_OVER_HEIGHT = 16 / 9;

/** Most display curvature we offer (OpenVR accepts up to 1, a closed cylinder). */
export const MAX_DISPLAY_CURVATURE = 0.5;

/** Default full-height of the display frame in scene units (meters). */
export const DEFAULT_DISPLAY_HEIGHT = 0.5;

/** Default depth of the thin box “screen” volume. */
export const DEFAULT_DISPLAY_DEPTH = 0.04;

/** Rendered panel width. Attachment pivots must sit on this edge, not on a stale constant. */
export const DISPLAY_PANEL_WIDTH = DEFAULT_DISPLAY_HEIGHT * DISPLAY_ASPECT_WIDTH_OVER_HEIGHT;

/**
 * A panel showing a picture `aspect` (width / height) wide. Every panel keeps the default width,
 * so side-by-side hinges stay flush, and stands on the default panel's bottom edge, like monitors
 * on a desk, so a keyboard hinged below stays put. A portrait picture would tower over its
 * neighbours: it stops at a square and narrows instead. `centerY` is where its centre sits on
 * the default panel's.
 */
export function displayPanelSize(aspect: number): { width: number; height: number; centerY: number } {
  const valid = Number.isFinite(aspect) && aspect > 0 ? aspect : DISPLAY_ASPECT_WIDTH_OVER_HEIGHT;
  const height = Math.min(DISPLAY_PANEL_WIDTH / valid, DISPLAY_PANEL_WIDTH);
  const width = height * valid;
  return { width, height, centerY: (height - DEFAULT_DISPLAY_HEIGHT) / 2 };
}
