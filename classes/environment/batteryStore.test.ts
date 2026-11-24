import { assertEquals } from "@std/assert";
import type { ToastInput } from "./toastStore.ts";
import { createBatteryStore } from "./batteryStore.ts";

Deno.test("low battery toasts once per crossing, re-armed by charging or recovery", () => {
  const toasts: ToastInput[] = [];
  const store = createBatteryStore((toast) => toasts.push(toast));
  const left = (percent: number, charging = false) => ({ left: { percent, charging } });

  store.publish(left(40));
  store.publish(left(14));
  store.publish(left(13));
  store.publish(left(16)); // wobble above the threshold but below the re-arm level
  store.publish(left(12));
  assertEquals(toasts.map((t) => t.title), ["Left controller battery low"]);
  assertEquals(toasts[0].content, "14%");

  store.publish(left(12, true)); // charging re-arms
  store.publish(left(11));
  assertEquals(toasts.length, 2);
  // A charging device below the line never warns.
  store.publish({ right: { percent: 5, charging: true } });
  assertEquals(toasts.length, 2);
});

Deno.test("subscribers hear only real changes", () => {
  const store = createBatteryStore(() => {});
  let emits = 0;
  store.subscribe(() => emits++);
  store.publish({ hmd: { percent: 80, charging: false } });
  store.publish({ hmd: { percent: 80, charging: false } });
  store.publish({ hmd: { percent: 79, charging: false } });
  assertEquals(emits, 2);
});
