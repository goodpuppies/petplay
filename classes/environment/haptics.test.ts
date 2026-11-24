import { assertEquals } from "@std/assert";
import { resetSettings, setSetting } from "../settings.ts";
import {
  HAPTIC_PULSES,
  type HapticHand,
  type HapticPulse,
  HOVER_MIN_INTERVAL_MS,
  pulseForPointerEvent,
  pulseHand,
  registerPointerHand,
  setHapticSink,
} from "./haptics.ts";

Deno.test("pointer events pulse the hand that owns the pointer", () => {
  resetSettings();
  const sent: [HapticHand, HapticPulse][] = [];
  setHapticSink((hand, pulse) => sent.push([hand, pulse]));
  const unregister = registerPointerHand(7, "left");

  assertEquals(pulseForPointerEvent({ pointerId: 7 }, "click"), true);
  assertEquals(pulseForPointerEvent({ pointerId: 8 }, "click"), false);
  assertEquals(pulseForPointerEvent({}, "click"), false);
  assertEquals(sent, [["left", HAPTIC_PULSES.click]]);

  unregister();
  assertEquals(pulseForPointerEvent({ pointerId: 7 }, "click"), false);
  setHapticSink(null);
});

Deno.test("hover pulses are rate limited per hand; the setting turns them off", () => {
  resetSettings();
  let count = 0;
  setHapticSink(() => count++);
  assertEquals(pulseHand("right", "hover", 1000), true);
  assertEquals(pulseHand("right", "hover", 1000 + HOVER_MIN_INTERVAL_MS - 1), false);
  assertEquals(pulseHand("left", "hover", 1000), true);
  assertEquals(pulseHand("right", "hover", 1000 + HOVER_MIN_INTERVAL_MS), true);
  // Clicks are never rate limited.
  assertEquals(pulseHand("right", "click", 1000 + HOVER_MIN_INTERVAL_MS), true);
  assertEquals(count, 4);

  setSetting("haptics", false);
  assertEquals(pulseHand("right", "click"), false);
  assertEquals(count, 4);
  setHapticSink(null);
  resetSettings();
});
