import {
  ONE_HAND_SCALE_MAX_WIDTH,
  ONE_HAND_SCALE_MIN_WIDTH,
  ONE_HAND_SCALE_RATE,
  oneHandScaledWidth,
} from "./oneHandScale.ts";

function assertClose(actual: number, expected: number, message: string): void {
  if (Math.abs(actual - expected) > 1e-9) throw new Error(`${message}: ${actual} != ${expected}`);
}

Deno.test("pulling the hand away shrinks the window and bringing it closer grows it", () => {
  assertClose(oneHandScaledWidth(1, 0.3, 0.3), 1, "no change");
  if (!(oneHandScaledWidth(1, 0.3, 0.4) < 1)) throw new Error("further should be smaller");
  if (!(oneHandScaledWidth(1, 0.3, 0.2) > 1)) throw new Error("closer should be larger");
});

Deno.test("the same pull scales a small and a large window by the same factor", () => {
  const halving = Math.log(2) / ONE_HAND_SCALE_RATE;
  assertClose(oneHandScaledWidth(0.2, 0.3, 0.3 + halving), 0.1, "small halves");
  assertClose(oneHandScaledWidth(2, 0.3, 0.3 + halving), 1, "large halves");
  assertClose(oneHandScaledWidth(0.5, 1, 1 - halving), 1, "closer doubles");
});

Deno.test("only the distance counts, wherever the grab started", () => {
  // A laser grab from 2 m and a grab at the window behave alike for the same change in distance.
  assertClose(oneHandScaledWidth(1, 2, 2.1), oneHandScaledWidth(1, 0.05, 0.15), "same pull");
});

Deno.test("the width stays within its limits", () => {
  assertClose(oneHandScaledWidth(1, 0.3, 10), ONE_HAND_SCALE_MIN_WIDTH, "min");
  assertClose(oneHandScaledWidth(1, 10, 0), ONE_HAND_SCALE_MAX_WIDTH, "max");
});
