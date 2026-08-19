import { createMainControllerGate, type ControllerHand } from "./mainController.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`Expected ${expected}, received ${actual}`);
}

function hand(handedness: ControllerHand) {
  return { inputSource: { handedness } };
}

function gateWithLocalState(initial: ControllerHand | null = null) {
  let current = initial;
  const gate = createMainControllerGate({
    getHand: () => current,
    setHand: (next) => {
      current = next;
    },
  });
  return { gate, hand: () => current };
}

Deno.test("first controller to aim claims the cursor", () => {
  const { gate, hand: main } = gateWithLocalState();
  assertEquals(gate.move(hand("right")), "emit");
  assertEquals(main(), "right");
});

Deno.test("only the main controller moves the cursor", () => {
  const { gate } = gateWithLocalState("right");
  assertEquals(gate.move(hand("right")), "emit");
  assertEquals(gate.move(hand("left")), "ignore");
});

Deno.test("off-hand trigger switches main hand without clicking", () => {
  const { gate, hand: main } = gateWithLocalState("right");
  assertEquals(gate.down(hand("left"), 7), "switch");
  assertEquals(main(), "left");
  // The matching release is swallowed too, so no stray button-up reaches the desktop.
  assertEquals(gate.up(hand("left"), 7), "switch");
  // Now that it is main, the next press is a real click.
  assertEquals(gate.down(hand("left"), 8), "emit");
  assertEquals(gate.up(hand("left"), 8), "emit");
});

Deno.test("main controller clicks pass straight through", () => {
  const { gate } = gateWithLocalState("right");
  assertEquals(gate.down(hand("right"), 1), "emit");
  assertEquals(gate.up(hand("right"), 1), "emit");
});

Deno.test("non-XR pointers bypass the gate", () => {
  const { gate } = gateWithLocalState("right");
  assertEquals(gate.move(undefined), "emit");
  assertEquals(gate.down({}, 3), "emit");
  assertEquals(gate.up(null, 3), "emit");
});

Deno.test("reset forgets in-flight switches", () => {
  const { gate } = gateWithLocalState("right");
  assertEquals(gate.down(hand("left"), 4), "switch");
  gate.reset();
  // Left is main after the switch, so a fresh release is treated as its own.
  assertEquals(gate.up(hand("left"), 4), "emit");
});
