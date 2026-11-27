/**
 * Scene content the decoupled renderer may hand to SteamVR as its own overlays instead of drawing
 * it into the head-locked eye image (`overlayPresentMode: "native"`, see
 * `docs/NATIVE_OVERLAYS.md`).
 *
 * Three kinds, all described here without any GL or OpenVR type, so the scene worker and the
 * renderer process can share this module:
 *
 * - a **native panel**: one uikit root. A root is flat by construction and its own world matrix
 *   frames it exactly, so every root is described automatically. The renderer draws it head-on
 *   into its own texture and shows that on a quad overlay, which SteamVR places in the room, or
 *   on the hand or head it belongs to, at display rate;
 * - a **native stereo group**: real 3D meshes, marked through `userData`. The renderer draws them
 *   once per eye through the rectangle of a quad overlay centred on them, and shows both images
 *   side by side on that quad;
 * - a **native quad mesh**: one mesh thin or flat enough to be a plain quad itself (a laser beam,
 *   a cursor dot), marked through `userData`.
 *
 * The scene always describes them; they cost nothing while no renderer uses them.
 */
import type { Anchored } from "./overlayRenderTracking.ts";

/**
 * `userData.nativePanel = false` on an object keeps the uikit roots under it in the eye image.
 * For UI that depends on what only the eye image has: depth against the 3D scene, or one side
 * that must stay hidden (a display's rear logo).
 */
export const NATIVE_PANEL_USERDATA = "nativePanel";

export type NativePanelSnapshot = Anchored & {
  /** Stable for the root's lifetime and unique in the scene: names the SteamVR overlay. */
  key: string;
  /** uikit roots (`rootIndex` of the UI snapshot's items) that lie on this panel. */
  rootIndices: number[];
  /**
   * Maps the unit square (-0.5..0.5 in X and Y, Z = 0) onto the panel's rectangle in the world:
   * +X right, +Y up, +Z towards the viewer. A uikit root's own world matrix is exactly this.
   */
  worldMatrix: Float32Array;
  /** uikit pixels across that square, for the texture's resolution. */
  pixelWidth: number;
  pixelHeight: number;
};

/** `userData.nativeStereo` on every mesh of a group; the group's centre comes from an ancestor. */
export type NativeStereoUserData = {
  key: string;
  /** Radius, in world metres, of a sphere around the centre that holds the whole group. */
  radius: number;
  /**
   * The group is the frame of a box of this size (width, height, depth, in the units of the
   * meshes' parent), centred on the group's centre with its faces along the meshes' axes: a grab
   * box's outline. A box is thin and sits around a flat panel, so the renderer shows it on a quad
   * in the box's nearer face instead of one turned to the head; see `nativeStereoBoxQuad`.
   */
  box?: [number, number, number];
  /**
   * Chrome that belongs to the UI panels: shown natively only when the panels are (the `native`
   * present mode). Without it a group is shown natively in every present mode.
   */
  withPanels?: true;
};

/** `userData.nativeStereoCenter = true` on the ancestor whose origin is the group's centre. */
export const NATIVE_STEREO_CENTER = "nativeStereoCenter";

/** What a lowered mesh instance carries for the renderer. */
export type NativeStereoInstance = {
  nativeStereo?: NativeStereoUserData & { center: [number, number, number] };
};

export function readNativeStereoUserData(value: unknown): NativeStereoUserData | null {
  const data = value as Partial<NativeStereoUserData> | null | undefined;
  if (data == null || typeof data.key !== "string" || data.key.length === 0) return null;
  if (!isPositive(data.radius)) return null;
  return data as NativeStereoUserData;
}

/**
 * `userData.nativeQuad` on a mesh that can be shown as one plain SteamVR quad while the UI panels
 * are native: what is left of the pointer once the panels have gone.
 *
 * - `beam`: long along its local Z (a laser). The quad holds that axis and turns about it to face
 *   the head. A beam in a hand's ray space is attached to that controller, so SteamVR moves it
 *   with the hand at display rate.
 * - `flat`: lies in its local XY plane (a cursor dot), and so does the quad.
 *
 * `extent` is the mesh's half size in its own units along X, Y and Z (a unit box: 0.5 each; a
 * circle of radius 1: 1, 1, 0). The mesh is centred on its origin.
 */
export type NativeQuadUserData = {
  key: string;
  shape: "beam" | "flat";
  extent: [number, number, number];
};

/** What a lowered mesh instance carries for the renderer. */
export type NativeQuadInstance = { nativeQuad?: NativeQuadUserData };

export function readNativeQuadUserData(value: unknown): NativeQuadUserData | null {
  const data = value as Partial<NativeQuadUserData> | null | undefined;
  if (data == null || typeof data.key !== "string" || data.key.length === 0) return null;
  if (data.shape !== "beam" && data.shape !== "flat") return null;
  const extent = data.extent;
  if (!Array.isArray(extent) || extent.length !== 3) return null;
  // A beam needs a thickness and a length, a flat mesh a width and a height.
  const needed = data.shape === "beam" ? [0, 2] : [0, 1];
  if (!needed.every((axis) => isPositive(extent[axis]))) return null;
  return data as NativeQuadUserData;
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
