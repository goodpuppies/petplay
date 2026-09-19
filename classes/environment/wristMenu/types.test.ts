import { isLayoutVisibilityAction } from "./types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("layout visibility action accepts the current and legacy actor IDs", () => {
  assert(isLayoutVisibilityAction("layout"), "current layout action should drive overlays");
  assert(isLayoutVisibilityAction("layers"), "legacy layers action should remain compatible");
  assert(!isLayoutVisibilityAction("edit"), "edit should not change overlay visibility");
});
