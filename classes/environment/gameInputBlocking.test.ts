import { assertEquals } from "@std/assert";
import { GameInputBlocking, OVERLAY_INPUT_PRIORITY } from "./gameInputBlocking.ts";

function fixture() {
  const root = { parent: null, userData: { blockGameInput: true }, visible: true };
  const child = { parent: root, userData: {} };
  const state = {
    enabled: true,
    hit: child as typeof child | undefined,
    capture: undefined as { object: typeof child } | undefined,
  };
  const pointer = {
    getEnabled: () => state.enabled,
    getIntersection: () => state.hit == null ? undefined : { object: state.hit },
    getPointerCapture: () => state.capture,
  };
  const blocking = new GameInputBlocking();
  const unregister = blocking.register(pointer, "left");
  return { blocking, state, root, child, unregister };
}

Deno.test("display children block only the interacting hand", () => {
  const { blocking, root } = fixture();
  assertEquals(blocking.priority("left", false), OVERLAY_INPUT_PRIORITY);
  assertEquals(blocking.priority("right", false), 0);
  root.userData.blockGameInput = false;
  assertEquals(blocking.priority("left", false), 0);
});

Deno.test("capture keeps blocking off-surface and held controls wait for release", () => {
  const { blocking, state, child } = fixture();
  assertEquals(blocking.priority("left", false), OVERLAY_INPUT_PRIORITY);
  state.hit = undefined;
  state.capture = { object: child };
  assertEquals(blocking.priority("left", false), OVERLAY_INPUT_PRIORITY);
  state.capture = undefined;
  assertEquals(blocking.priority("left", true), OVERLAY_INPUT_PRIORITY);
  assertEquals(blocking.priority("left", false), 0);
  assertEquals(blocking.priority("left", true), 0);
});

Deno.test("hidden or disabled pointers cannot acquire blocking", () => {
  const { blocking, state, root } = fixture();
  root.visible = false;
  assertEquals(blocking.priority("left", false), 0);
  root.visible = true;
  state.enabled = false;
  assertEquals(blocking.priority("left", false), 0);
});

Deno.test("multiple pointers retain blocking until all leave; unmount and reset release", () => {
  const { blocking, state, child, unregister } = fixture();
  const unregisterSecond = blocking.register({
    getEnabled: () => true,
    getIntersection: () => ({ object: child }),
    getPointerCapture: () => undefined,
  }, "left");
  state.hit = undefined;
  assertEquals(blocking.priority("left", false), OVERLAY_INPUT_PRIORITY);
  unregisterSecond();
  assertEquals(blocking.priority("left", true), OVERLAY_INPUT_PRIORITY);
  blocking.reset();
  assertEquals(blocking.priority("left", true), 0);
  state.hit = child;
  assertEquals(blocking.priority("left", false), OVERLAY_INPUT_PRIORITY);
  unregister();
  assertEquals(blocking.priority("left", true), 0);
});
