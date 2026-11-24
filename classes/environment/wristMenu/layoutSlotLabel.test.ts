import { assertEquals } from "@std/assert";
import { layoutSlotLabel } from "./ui.tsx";

Deno.test("slot label: display count, then the time today or the date before", () => {
  const now = new Date(2026, 9, 11, 21, 0);
  assertEquals(
    layoutSlotLabel({ displays: 3, savedAt: new Date(2026, 9, 11, 20, 14).getTime() }, now),
    "3 displays · 08:14 PM",
  );
  assertEquals(
    layoutSlotLabel({ displays: 1, savedAt: new Date(2026, 9, 9, 20, 14).getTime() }, now),
    "1 display · 09/10",
  );
  assertEquals(layoutSlotLabel({ displays: 2, savedAt: null }, now), "2 displays");
});
