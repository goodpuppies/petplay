import { assertEquals } from "@std/assert";
import { computeCellRect, computeGridMetrics } from "./grid.tsx";
import {
  type BatteryDeviceItem,
  layoutBatteryEntries,
  layoutBatteryGrid,
} from "./batteryWidget.tsx";
import { GAP, RADIUS, SHELL_SIZE, slotSize, UNIT, unitSpan } from "./tokens.ts";

Deno.test("root 4x4 grid reproduces exact PetPlay shell and tile dimensions", () => {
  const root = computeGridMetrics({
    width: SHELL_SIZE,
    height: SHELL_SIZE,
    cols: 4,
    rows: 4,
    gap: GAP,
    padding: GAP,
    radius: RADIUS.shell,
    depth: 0,
  });

  assertEquals(root.colWidth, UNIT);
  assertEquals(root.rowHeight, UNIT);
  assertEquals(root.childRadius, RADIUS.tile);

  const clock = computeCellRect(root, 0, 0, 2, 2);
  assertEquals(clock.x, GAP);
  assertEquals(clock.y, GAP);
  assertEquals(clock.width, unitSpan(2));
  assertEquals(clock.height, unitSpan(2));
  assertEquals(clock.radius, RADIUS.tile);

  const footer = computeCellRect(root, 0, 3, 4, 1);
  assertEquals(footer.width, unitSpan(4));
  assertEquals(footer.height, UNIT);
  assertEquals(footer.radius, RADIUS.tile);
});

Deno.test("nested 4x2 sub-grid inside a 2x1 tile matches slotSize(2) and concentric radii", () => {
  const root = computeGridMetrics({
    width: SHELL_SIZE,
    height: SHELL_SIZE,
    cols: 4,
    rows: 4,
    gap: GAP,
    padding: GAP,
    radius: RADIUS.shell,
    depth: 0,
  });
  const mediaTile = computeCellRect(root, 2, 0, 2, 1);

  const sub = computeGridMetrics({
    width: mediaTile.width,
    height: mediaTile.height,
    cols: 4,
    rows: 2,
    gap: root.gap / 2,
    padding: 0,
    radius: mediaTile.radius,
    depth: 1,
  });

  assertEquals(sub.colWidth, slotSize(2));
  assertEquals(sub.childRadius, RADIUS.slot);

  const slot = computeCellRect(sub, 0, 1, 1, 1);
  assertEquals(slot.width, 54);
  assertEquals(slot.height, 52);
  assertEquals(slot.radius, 20);

  const roundSlot = computeCellRect(sub, 0, 1, 1, 1, "round");
  assertEquals(roundSlot.radius, 26); // clamped to min(54, 52) / 2
});

Deno.test("deep recursion halves gap and clamps radius automatically to circles", () => {
  const d0 = computeGridMetrics({
    width: SHELL_SIZE,
    height: SHELL_SIZE,
    cols: 2,
    rows: 2,
    gap: 16,
    padding: 16,
    radius: 44,
    depth: 0,
  });
  const c0 = computeCellRect(d0, 0, 0, 1, 1);
  assertEquals(c0.radius, 28);

  const d1 = computeGridMetrics({
    width: c0.width,
    height: c0.height,
    cols: 2,
    rows: 2,
    gap: d0.gap / 2,
    padding: 0,
    radius: c0.radius,
    depth: 1,
  });
  const c1 = computeCellRect(d1, 0, 0, 1, 1);
  assertEquals(c1.radius, 20);

  const d2 = computeGridMetrics({
    width: c1.width,
    height: c1.height,
    cols: 2,
    rows: 2,
    gap: d1.gap / 2,
    padding: 0,
    radius: c1.radius,
    depth: 2,
  });
  const c2 = computeCellRect(d2, 0, 0, 1, 1);
  assertEquals(c2.radius, 16);

  const d3 = computeGridMetrics({
    width: c2.width,
    height: c2.height,
    cols: 2,
    rows: 2,
    gap: d2.gap / 2,
    padding: 0,
    radius: c2.radius,
    depth: 3,
  });
  const c3 = computeCellRect(d3, 0, 0, 1, 1);
  // At depth 3, cell is ~26.5px; derived radius 14 > 26.5/2 so it clamps to a true circle.
  assertEquals(c3.radius, Math.min(c3.width, c3.height) / 2);
});

Deno.test("battery widget lays out 3 devices as 2+1+1 and adapts to 1 or 2 devices", () => {
  const three = layoutBatteryEntries({
    hmd: { percent: 86, charging: false },
    left: { percent: 74, charging: false },
    right: { percent: 92, charging: true },
  });
  assertEquals(three.map((e) => [e.id, e.col, e.colSpan]), [
    ["hmd", 0, 2],
    ["left", 2, 1],
    ["right", 3, 1],
  ]);

  const two = layoutBatteryEntries({
    left: { percent: 50, charging: false },
    right: { percent: 60, charging: false },
  });
  assertEquals(two.map((e) => [e.id, e.col, e.colSpan]), [
    ["left", 0, 2],
    ["right", 2, 2],
  ]);

  const one = layoutBatteryEntries({ hmd: { percent: 99, charging: false } });
  assertEquals(one.map((e) => [e.id, e.col, e.colSpan]), [["hmd", 0, 4]]);
});

Deno.test("battery widget scales cleanly to 6, 7, 8, and 9 devices", () => {
  const makeItems = (n: number): BatteryDeviceItem[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `d${i}`,
      label: `Device ${i}`,
      icon: "battery_full",
      reading: { percent: 50, charging: false },
    }));

  const six = layoutBatteryGrid(makeItems(6));
  assertEquals([six.cols, six.rows, six.cells.length], [3, 2, 6]);

  const seven = layoutBatteryGrid(makeItems(7));
  assertEquals([seven.cols, seven.rows, seven.cells.length], [4, 2, 7]);
  assertEquals(seven.cells[0].colSpan, 2);

  const eight = layoutBatteryGrid(makeItems(8));
  assertEquals([eight.cols, eight.rows, eight.cells.length], [4, 2, 8]);

  const nine = layoutBatteryGrid(makeItems(9));
  assertEquals([nine.cols, nine.rows, nine.cells.length], [3, 3, 9]);
});
