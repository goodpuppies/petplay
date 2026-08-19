import { computeCursorQuad } from "./cursorComposite.ts";

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  if (actual !== expected) {
    throw new Error(`${message ?? "assertEquals"}: got ${actual}, expected ${expected}`);
  }
}

function assertAlmostEquals(actual: number, expected: number, tolerance: number): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`assertAlmostEquals: got ${actual}, expected ~${expected}`);
  }
}

const W = 1920;
const H = 1080;
const SIZE = 12;
const SQUARE = 1; // 32x32 sprite

Deno.test("cursor centre maps to the middle of the frame in both orientations", () => {
  for (const bottomUp of [true, false]) {
    const quad = computeCursorQuad(W / 2, H / 2, SIZE, W, H, SQUARE, bottomUp);
    assertAlmostEquals(quad.ndcX, 0, 1e-6);
    assertAlmostEquals(quad.ndcY, 0, 1e-6);
  }
});

Deno.test("a cursor near the top of the screen lands on the correct texture edge", () => {
  // Bottom-up texture: screen top is the +Y end of NDC.
  const flipped = computeCursorQuad(W / 2, 0, SIZE, W, H, SQUARE, true);
  assertAlmostEquals(flipped.ndcY, 1, 1e-6);
  // Top-down texture: screen top is the -Y end instead.
  const topDown = computeCursorQuad(W / 2, 0, SIZE, W, H, SQUARE, false);
  assertAlmostEquals(topDown.ndcY, -1, 1e-6);
});

Deno.test("screen X is unaffected by row order", () => {
  const left = computeCursorQuad(0, H / 2, SIZE, W, H, SQUARE, true);
  const right = computeCursorQuad(W, H / 2, SIZE, W, H, SQUARE, false);
  assertAlmostEquals(left.ndcX, -1, 1e-6);
  assertAlmostEquals(right.ndcX, 1, 1e-6);
});

Deno.test("the dirty rect covers the drawn sprite and stays inside the frame", () => {
  const quad = computeCursorQuad(W / 2, H / 2, SIZE, W, H, SQUARE, true);
  const rect = quad.rect!;
  assertEquals(rect.x <= W / 2 - SIZE, true);
  assertEquals(rect.x + rect.width >= W / 2 + SIZE, true);
  assertEquals(rect.y + rect.height <= H, true);

  // Hard against a corner the rect must clamp rather than go negative.
  const corner = computeCursorQuad(0, 0, SIZE, W, H, SQUARE, true)!;
  assertEquals(corner.rect!.x, 0);
  assertEquals(corner.rect!.y + corner.rect!.height <= H, true);
});

Deno.test("dirty rect follows the flipped row order", () => {
  // Cursor near screen top: bottom-up rows put it at high row indices,
  // top-down rows put it at low ones.
  const flipped = computeCursorQuad(W / 2, 100, SIZE, W, H, SQUARE, true).rect!;
  const topDown = computeCursorQuad(W / 2, 100, SIZE, W, H, SQUARE, false).rect!;
  assertEquals(flipped.y > H / 2, true);
  assertEquals(topDown.y < H / 2, true);
});

Deno.test("half extents scale the sprite by its aspect", () => {
  const quad = computeCursorQuad(W / 2, H / 2, SIZE, W, H, 2, true);
  assertAlmostEquals(quad.halfW, SIZE / W, 1e-9);
  assertAlmostEquals(quad.halfH, (SIZE * 2) / H, 1e-9);
});
