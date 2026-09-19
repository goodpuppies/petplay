/**
 * Wrist menu state.
 *
 * These are PetPlay's two real modes, and they are related rather than
 * independent: **layout** decides whether the spatial furniture — displays,
 * hinges, snap targets, the keyboard — is visible at all, and **edit** layers
 * extra manipulation on top of it. Edit is therefore only meaningful while
 * layout is on, and turning layout off turns edit off with it.
 *
 * (These were previously called `layers` and `music`. The wiring was always
 * mode wiring — `setWindowLayerVisible` and `setToolEditMode` — but the names
 * and icons were carried over from a media-player-shaped menu and described
 * nothing PetPlay does.)
 */
export type WristMenuButtonId = "layout" | "edit";

export type WristMenuStateSnapshot = {
  /** Is the spatial layer visible at all? */
  layoutActive: boolean;
  /** Extra manipulation on top of layout mode. Never on while layout is off. */
  editActive: boolean;
};

/** `layers` is retained at the actor boundary for pre-rename clients/snapshots. */
export function isLayoutVisibilityAction(id: unknown): id is "layout" | "layers" {
  return id === "layout" || id === "layers";
}
