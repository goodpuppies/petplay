import { isPointerBlockedByHost } from "./pointerFilter.ts";

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message ?? "mismatch"}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const left = { inputSource: { handedness: "left" } };
const right = { inputSource: { handedness: "right" } };
const unattributed = { inputSource: {} };

Deno.test("the host controller can never touch its own menu", () => {
  for (const type of ["poker", "grab", "ray"]) {
    assertEquals(isPointerBlockedByHost(type, left, "left", true), true, type);
  }
});

Deno.test("the other hand operates the menu normally", () => {
  for (const type of ["poker", "grab", "ray"]) {
    assertEquals(isPointerBlockedByHost(type, right, "left", true), false, type);
  }
});

Deno.test("fails closed: unattributed near-field pointers are refused", () => {
  // The bug this guards: a runtime reporting handedness as "none", or a source
  // carrying none at all, used to pass straight through and let the host
  // controller poke its own panel.
  for (const state of [unattributed, null, {}, { inputSource: { handedness: "none" } }]) {
    assertEquals(isPointerBlockedByHost("poker", state, "left", true), true, "poker");
    assertEquals(isPointerBlockedByHost("grab", state, "left", true), true, "grab");
    // A ray still gets through — aiming one at your own wrist is deliberate.
    assertEquals(isPointerBlockedByHost("ray", state, "left", true), false, "ray");
  }
});

Deno.test("fails closed even when the host hand itself is unknown", () => {
  assertEquals(isPointerBlockedByHost("poker", unattributed, undefined, true), true);
});

Deno.test("an unattached panel guards nothing", () => {
  // The desktop HUD floats in front of the camera; there is no host controller
  // to protect against, so every pointer type must reach it.
  for (const type of ["poker", "grab", "ray"]) {
    assertEquals(isPointerBlockedByHost(type, left, "left", false), false, type);
    assertEquals(isPointerBlockedByHost(type, unattributed, undefined, false), false, type);
  }
});
