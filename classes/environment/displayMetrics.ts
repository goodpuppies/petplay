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

/** Default full-height of the display frame in scene units (meters). */
export const DEFAULT_DISPLAY_HEIGHT = 0.5;

/** Default depth of the thin box “screen” volume. */
export const DEFAULT_DISPLAY_DEPTH = 0.04;

/** Rendered panel width. Attachment pivots must sit on this edge, not on a stale constant. */
export const DISPLAY_PANEL_WIDTH = DEFAULT_DISPLAY_HEIGHT * DISPLAY_ASPECT_WIDTH_OVER_HEIGHT;
