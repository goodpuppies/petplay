/**
 * Design tokens for PetPlay's overlay UI.
 *
 * Ported from the `petplay-ui` sandbox (github: local `/home/ellie/git/petplay-ui`),
 * where the system was worked out against a browser and its invariants checked
 * numerically. The derivations are reproduced here rather than the final numbers
 * alone, so changing {@link UNIT} or {@link GAP} re-proportions the whole panel
 * instead of requiring every dependent value to be re-tuned by hand.
 *
 * The one structural difference from the sandbox: uikit's layout engine is
 * flexbox (yoga), with no CSS grid and no `min()`-style radius clamping. Both
 * are handled by computing sizes explicitly here — which the system permits,
 * because every size in it is arithmetic in the first place.
 */

/** One grid unit. A tile spans a whole number of these. */
export const UNIT = 112;

/**
 * The single spacing token. It is simultaneously the shell's padding, the gap
 * between tiles, and the basis for every radius — so the panel keeps one
 * rhythm no matter what this is set to.
 */
export const GAP = 16;

/**
 * Spacing halves with depth, the way radius steps down with depth. A tile
 * separates its own contents by half what the shell uses between tiles: uniform
 * spacing at every level reads as too loose inside a small tile, which has a
 * quarter of the area to spend it on.
 */
export const INNER_GAP = GAP / 2;

/**
 * Half-unit. Used for the footer height and the squeezed last row.
 *
 * Note this is *not* the slot pitch, despite the sandbox's stylesheet claiming
 * so — see {@link slotSize}. It is only the half-unit those two rows happen to
 * want.
 */
export const SUB_UNIT = (UNIT - GAP) / 2;

/** The panel is this many units wide, and square overall. */
export const COLUMNS = 4;

/** Footer height. One sub-unit, which also makes the squeezed last row one sub-unit. */
export const FOOTER_HEIGHT = SUB_UNIT;

/**
 * Radius is **extrinsic**: each level is its parent's minus the inset at that
 * level, so the band between two nested curves stays a constant width. Shell 44
 * -> tile 28 -> slot 20.
 *
 * "Pill" and "circle" are not separate rules in this system, they are outcomes:
 * a radius larger than half the smaller side resolves to a full round, so
 * anything short enough becomes a pill or a circle on its own. That dissolves
 * the conflict between intrinsic shape and concentric nesting instead of
 * arbitrating it. Use {@link clampRadius} wherever the renderer does not clamp
 * for us.
 *
 * Precedence when rules collide:
 *   1. spacing rhythm (padding == gap) — never violated
 *   2. concentric radius — derived from parent
 *   3. shape (pill / circle) — yields to 1 and 2
 */
export const RADIUS = {
  shell: 44,
  tile: 44 - GAP,
  slot: 44 - GAP - INNER_GAP,
  /** Half the footer's height, so the footer is a true pill. */
  footer: FOOTER_HEIGHT / 2,
  /**
   * The shell's *bottom* radius is derived back from the footer rather than
   * shared with the top. A child sitting at a container's corner must be at
   * least `2 * (parentRadius - inset)` tall or its corner cannot nest; the
   * footer is too short for a 44 radius, so the shell yields instead. Hence the
   * asymmetric shell.
   */
  shellBottom: FOOTER_HEIGHT / 2 + GAP,
} as const;

/**
 * Colour is three fixed relationships, with no ramps between them:
 *   - white outline on the tile fill — structure
 *   - accent + `onAccent` — the thing currently in effect
 *   - `ink` / `inkDim` — content
 *
 * Accent surfaces take their hierarchy from size and weight, never from tinting
 * the ink, which is why there is exactly one colour that ever sits on accent.
 */
export const COLOR = {
  /** The panel ground. Pure black by rule, not a dark grey. */
  ground: "#000000",
  tile: "#26262b",
  tileHi: "#34343a",
  ink: "#ffffff",
  inkDim: "#8a8a8a",
  outline: "#ffffff",
  accent: "#ffc300",
  accentBright: "#ffd84a",
  /** The only ink that ever sits on {@link COLOR.accent}. White on yellow is unreadable. */
  onAccent: "#000000",
  /**
   * Destructive actions — a deliberate fourth relationship.
   *
   * The palette is otherwise three fixed pairings with no ramps, and this is the
   * one case where that is not enough: "delete" and "detach" must not read as
   * merely another action, and the accent already means "in effect" rather than
   * "dangerous". Kept to a single value with its own ink so it stays a signal
   * and does not drift into being a second accent.
   */
  danger: "#e03c31",
  /** Hover state for {@link COLOR.danger}. */
  dangerBright: "#ef5a50",
  /** Ink on {@link COLOR.danger}. */
  onDanger: "#ffffff",
} as const;

/** Thick enough to read as a deliberate drawn line rather than a faint edge. */
export const OUTLINE_WIDTH = 3;

/** Size in px of a span of `n` whole units, including the gaps between them. */
export function unitSpan(n: number): number {
  return n * UNIT + (n - 1) * GAP;
}

/**
 * Slots divide a tile's own width, rather than continuing the panel grid.
 *
 * A tile spanning `units` subdivides into `2 * units` slots separated by
 * {@link INNER_GAP}, with no tile padding — the sub-grid meets the tile edge,
 * and breathing room comes from the pills' own padding instead ("all text lives
 * in a pill" doing structural work).
 *
 * **This subdivision is proportional, not a shared grid.** For slot edges to
 * line up across tiles of *different* widths, the sub-grid's pitch would have to
 * divide the panel's: `n * UNIT + (n-1) * GAP === 2n * pitch - innerGap` for
 * every `n`, which forces `pitch === (UNIT + GAP) / 2` and `innerGap === GAP`.
 * That is incompatible with {@link INNER_GAP} halving with depth. The two rules
 * genuinely conflict, and the sandbox resolved it in favour of the halved gap:
 * a slot is 52px inside a 1-unit tile and 54px inside a 2-unit tile.
 *
 * Slots therefore align *within* a tile, always — which is what the visible
 * alignment depends on — but not across tiles of unequal width.
 */
export function slotSize(units: number): number {
  const count = units * 2;
  return (unitSpan(units) - INNER_GAP * (count - 1)) / count;
}

/** Width of `n` adjacent slots inside a tile spanning `units`, including gaps. */
export function slotSpan(n: number, units: number): number {
  return n * slotSize(units) + (n - 1) * INNER_GAP;
}

/** Width of the tile grid, and therefore of the shell's content box. */
export const GRID_WIDTH = unitSpan(COLUMNS);

/**
 * Height of the last tile row. A 4x4 grid of square tiles *cannot* leave room
 * for a footer and stay square — it needs `(cols - rows) * (UNIT + GAP)` to
 * equal `GAP + FOOTER_HEIGHT`, which for `cols === rows` demands a negative
 * footer. Squeezing only the last row confines the distortion to the one row
 * that already holds wide labelled tiles rather than spreading it over all four.
 */
export const LAST_ROW_HEIGHT = UNIT - GAP - FOOTER_HEIGHT;

/** Outer size of the shell. Square by construction — asserted in the tests. */
export const SHELL_SIZE = GRID_WIDTH + GAP * 2;

/**
 * uikit does not clamp a radius to half the smaller side the way CSS does, so a
 * "pill" radius of 999 would otherwise render as a malformed corner. Clamping
 * here keeps `RADIUS.pill`-style intent working: ask for more than fits and you
 * get a full round.
 */
export function clampRadius(radius: number, width: number, height: number): number {
  return Math.min(radius, Math.min(width, height) / 2);
}
