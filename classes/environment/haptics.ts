/**
 * Controller haptics for UI feedback: a faint tick when a ray enters a button, a firmer pulse on
 * click.
 *
 * UI handlers only know the pmndrs `pointerId` of the event, so the ray pointers register which
 * hand they belong to ({@link registerPointerHand}), and the OpenVR input source installs the sink
 * that actually vibrates ({@link setHapticSink}). Without a sink (`--novr`, or before IVRInput is
 * up) pulses are counted and dropped, which is what the playtests assert against.
 */
import { getSetting } from "../settings.ts";

export type HapticHand = "left" | "right";
export type HapticKind = "hover" | "click" | "notify";

export type HapticPulse = { durationS: number; frequency: number; amplitude: number };

export const HAPTIC_PULSES: Record<HapticKind, HapticPulse> = {
  hover: { durationS: 0.012, frequency: 180, amplitude: 0.15 },
  click: { durationS: 0.03, frequency: 160, amplitude: 0.5 },
  notify: { durationS: 0.055, frequency: 180, amplitude: 0.6 },
};

/** Second, longer beat of the "da-daaa" notification haptic pattern. */
const NOTIFY_SECOND_BEAT: HapticPulse = { durationS: 0.16, frequency: 135, amplitude: 0.8 };
const NOTIFY_SECOND_DELAY_MS = 115;

/** Sweeping a ray across a row of buttons should feel like texture, not a buzz. */
export const HOVER_MIN_INTERVAL_MS = 50;

export type HapticSink = (hand: HapticHand, pulse: HapticPulse) => void;

const pointerHands = new Map<number, HapticHand>();
const lastHoverAt: Record<HapticHand, number> = { left: -Infinity, right: -Infinity };
let sink: HapticSink | null = null;

/** Pulses requested since start, sink or not; read by playtests. */
export const hapticStats = { hover: 0, click: 0, notify: 0, dropped: 0 };

export function setHapticSink(next: HapticSink | null): void {
  sink = next;
}

export function registerPointerHand(pointerId: number, hand: HapticHand): () => void {
  pointerHands.set(pointerId, hand);
  return () => {
    if (pointerHands.get(pointerId) === hand) pointerHands.delete(pointerId);
  };
}

export function pulseHand(hand: HapticHand, kind: HapticKind, now = performance.now()): boolean {
  if (!getSetting("haptics")) return false;
  if (kind === "hover") {
    if (now - lastHoverAt[hand] < HOVER_MIN_INTERVAL_MS) return false;
    lastHoverAt[hand] = now;
  }
  hapticStats[kind]++;
  if (sink == null) {
    hapticStats.dropped++;
    return false;
  }
  try {
    sink(hand, HAPTIC_PULSES[kind]);
    if (kind === "notify") {
      setTimeout(() => {
        if (!getSetting("haptics") || sink == null) return;
        try {
          sink(hand, NOTIFY_SECOND_BEAT);
        } catch { /* ignore */ }
      }, NOTIFY_SECOND_DELAY_MS);
    }
  } catch {
    hapticStats.dropped++;
    return false;
  }
  return true;
}

/** For UI event handlers: pulses the hand that owns the event's pointer, if it is a ray. */
export function pulseForPointerEvent(event: unknown, kind: HapticKind): boolean {
  const pointerId = (event as { pointerId?: unknown } | null)?.pointerId;
  if (typeof pointerId !== "number") return false;
  const hand = pointerHands.get(pointerId);
  return hand == null ? false : pulseHand(hand, kind);
}
