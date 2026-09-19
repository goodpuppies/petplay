import {
  COLUMNS,
  FOOTER_HEIGHT,
  GAP,
  GRID_WIDTH,
  INNER_GAP,
  LAST_ROW_HEIGHT,
  RADIUS,
  SHELL_SIZE,
  SUB_UNIT,
  UNIT,
  clampRadius,
  slotSize,
  slotSpan,
  unitSpan,
} from "./tokens.ts";

// Local, matching the other tests in this directory rather than pulling a
// registry dependency in for six assertions.
function assertEquals(actual: unknown, expected: unknown): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
  }
}

/**
 * These are the checks the browser sandbox ran against rendered geometry
 * (`measure.mjs`, `concentric.mjs`, `snap.mjs`). Several of the bugs they caught
 * were invisible by eye, so they travel with the port rather than being left
 * behind with the prototype.
 */

Deno.test("panel is square", () => {
  const gridHeight = UNIT * 3 + GAP * 3 + LAST_ROW_HEIGHT;
  const contentHeight = gridHeight + GAP + FOOTER_HEIGHT;
  assertEquals(contentHeight, GRID_WIDTH);
  assertEquals(SHELL_SIZE, contentHeight + GAP * 2);
});

Deno.test("slots exactly subdivide their own tile", () => {
  // All the slots plus their gaps fill the tile edge to edge, at any width.
  for (const units of [1, 2, 3, 4]) {
    assertEquals(slotSpan(units * 2, units), unitSpan(units));
  }
});

Deno.test("the halved inner gap costs cross-tile slot alignment", () => {
  // Documented as a deliberate trade, so a future change to INNER_GAP shows up
  // here rather than as a subtly misaligned panel.
  assertEquals(slotSize(1), 52);
  assertEquals(slotSize(2), 54);
  // Slots would align across tile widths only if the inner gap matched GAP.
  const sharedPitch = (UNIT + GAP) / 2;
  assertEquals(sharedPitch - GAP, SUB_UNIT);
});

Deno.test("radius is concentric: each level is its parent minus that level's inset", () => {
  assertEquals(RADIUS.tile, RADIUS.shell - GAP);
  assertEquals(RADIUS.slot, RADIUS.tile - INNER_GAP);
});

Deno.test("the footer can carry the shell's bottom radius", () => {
  // A child at a container's corner needs height >= 2 * (parentRadius - inset).
  const required = 2 * (RADIUS.shellBottom - GAP);
  assertEquals(FOOTER_HEIGHT >= required, true);
  // ...and the shell's top radius is exactly what the footer could *not* carry,
  // which is why the shell is asymmetric rather than the footer being grown.
  assertEquals(2 * (RADIUS.shell - GAP) > FOOTER_HEIGHT, true);
});

Deno.test("a square grid cannot host a footer without squeezing a row", () => {
  // (cols - rows) * (UNIT + GAP) === GAP + FOOTER_HEIGHT has no solution with
  // cols === rows and a positive footer, so the last row absorbs the difference.
  assertEquals(LAST_ROW_HEIGHT, UNIT - GAP - FOOTER_HEIGHT);
  assertEquals(LAST_ROW_HEIGHT, SUB_UNIT);
  assertEquals(COLUMNS, 4);
});

Deno.test("clampRadius resolves an over-large radius to a full round", () => {
  // The "pill" and "circle" shapes are this clamp, not separate rules.
  assertEquals(clampRadius(999, 200, 48), 24);
  assertEquals(clampRadius(999, 48, 48), 24);
  // A radius that already fits is left alone.
  assertEquals(clampRadius(RADIUS.slot, SUB_UNIT, SUB_UNIT), RADIUS.slot);
});
