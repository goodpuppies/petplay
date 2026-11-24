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

Deno.test("focus target follows hits on UI without its own SteamVR overlay", () => {
  const { blocking, state, root, child } = fixture();
  const hit = {
    object: child,
    point: { x: 1, y: 2, z: 3 },
    pointerPosition: { x: 0, y: 1, z: 0 },
  };
  const pointer = {
    getEnabled: () => true,
    getIntersection: () => hit,
    getPointerCapture: () => undefined,
  };
  state.enabled = false;
  blocking.register(pointer, "right");
  blocking.priority("right", false);
  assertEquals(blocking.focusTarget("right"), { point: [1, 2, 3], origin: [0, 1, 0] });
  // Held off the UI: blocking and the overlay stay where they were.
  hit.object = { parent: null, userData: {} } as unknown as typeof child;
  blocking.priority("right", true);
  assertEquals(blocking.focusTarget("right")?.point, [1, 2, 3]);
  blocking.priority("right", false);
  assertEquals(blocking.focusTarget("right"), null);
  // Displays carry their own overlay.
  hit.object = child;
  (root.userData as Record<string, unknown>).steamVrInputOverlay = true;
  assertEquals(blocking.priority("right", false), OVERLAY_INPUT_PRIORITY);
  assertEquals(blocking.focusTarget("right"), null);
});

Deno.test("the nearest blockGameInput flag decides", () => {
  const { blocking, child, root } = fixture();
  (child.userData as Record<string, unknown>).blockGameInput = false;
  assertEquals(blocking.priority("left", false), 0);
  (child.userData as Record<string, unknown>).blockGameInput = true;
  (root.userData as Record<string, unknown>).blockGameInput = false;
  assertEquals(blocking.priority("left", false), OVERLAY_INPUT_PRIORITY);
});
