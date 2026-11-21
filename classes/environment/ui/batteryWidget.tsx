/**
 * Battery widget for a 2×1 wrist tile: a recursive grid of level gauges (no "BATTERY" title).
 *
 * Adapts smoothly to any device count (headset + controllers + full-body trackers):
 *   - 1–4 devices: 1 row (4 columns), tall vertical gauges filling bottom-to-top (3 devices = 2+1+1).
 *   - 5–8 devices: 2 rows (3–4 columns), compact vertical or horizontal bars depending on aspect.
 *   - 9+ devices:  3 rows (3–4 columns), compact horizontal bars filling left-to-right.
 */
import React from "react";
import { Container } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Text } from "./text.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { Cell, Grid, useCellRect } from "./grid.tsx";
import { COLOR, INNER_GAP, RADIUS, UNIT, unitSpan } from "./tokens.ts";
import { type BatteryReading, type BatteryReadings, LOW_BATTERY_PERCENT } from "../batteryStore.ts";

const TRACK_COLOR = "#141418";
const NORMAL_FILL = "#4a4d5c";

export type BatteryDeviceItem = {
  id: string;
  label: string;
  icon: IconName;
  reading: BatteryReading;
};

export type BatteryCellPlacement = BatteryDeviceItem & {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  tooltip: string;
};

export type BatteryGridPlan = {
  cols: number;
  rows: number;
  gap: number;
  padding: number;
  cells: BatteryCellPlacement[];
};

/** Converts the standard 3-device `BatteryReadings` map into an ordered list of device items. */
export function batteryReadingsToItems(batteries: BatteryReadings): BatteryDeviceItem[] {
  const items: BatteryDeviceItem[] = [];
  if (batteries.hmd) {
    items.push({ id: "hmd", label: "Headset", icon: "headset", reading: batteries.hmd });
  }
  if (batteries.left) {
    items.push({
      id: "left",
      label: "Left controller",
      icon: "videogame_asset",
      reading: batteries.left,
    });
  }
  if (batteries.right) {
    items.push({
      id: "right",
      label: "Right controller",
      icon: "videogame_asset",
      reading: batteries.right,
    });
  }
  return items;
}

/** Places a list of devices onto a recursive grid for a 2×1 tile. */
export function layoutBatteryGrid(items: readonly BatteryDeviceItem[]): BatteryGridPlan {
  const n = items.length;
  if (n === 0) return { cols: 4, rows: 1, gap: INNER_GAP, padding: INNER_GAP, cells: [] };

  const withTooltip = (
    item: BatteryDeviceItem,
    col: number,
    row: number,
    colSpan: number,
    rowSpan = 1,
  ): BatteryCellPlacement => ({
    ...item,
    col,
    row,
    colSpan,
    rowSpan,
    tooltip: `${item.label} ${Math.round(item.reading.percent)}%${
      item.reading.charging ? " (charging)" : ""
    }`,
  });

  if (n === 1) {
    return { cols: 4, rows: 1, gap: INNER_GAP, padding: INNER_GAP, cells: [withTooltip(items[0], 0, 0, 4)] };
  }
  if (n === 2) {
    return {
      cols: 4,
      rows: 1,
      gap: INNER_GAP,
      padding: INNER_GAP,
      cells: [withTooltip(items[0], 0, 0, 2), withTooltip(items[1], 2, 0, 2)],
    };
  }
  if (n === 3) {
    // 2 + 1 + 1: wide square-ish headset on the left, two vertical controllers on the right.
    return {
      cols: 4,
      rows: 1,
      gap: INNER_GAP,
      padding: INNER_GAP,
      cells: [
        withTooltip(items[0], 0, 0, 2),
        withTooltip(items[1], 2, 0, 1),
        withTooltip(items[2], 3, 0, 1),
      ],
    };
  }
  if (n === 4) {
    return {
      cols: 4,
      rows: 1,
      gap: INNER_GAP,
      padding: INNER_GAP,
      cells: items.map((item, i) => withTooltip(item, i, 0, 1)),
    };
  }
  if (n === 5) {
    // Row 0: 2 + 1 + 1; Row 1: 2 + 2.
    return {
      cols: 4,
      rows: 2,
      gap: 6,
      padding: INNER_GAP,
      cells: [
        withTooltip(items[0], 0, 0, 2),
        withTooltip(items[1], 2, 0, 1),
        withTooltip(items[2], 3, 0, 1),
        withTooltip(items[3], 0, 1, 2),
        withTooltip(items[4], 2, 1, 2),
      ],
    };
  }
  if (n === 6) {
    return {
      cols: 3,
      rows: 2,
      gap: 6,
      padding: INNER_GAP,
      cells: items.map((item, i) => withTooltip(item, i % 3, Math.floor(i / 3), 1)),
    };
  }
  if (n === 7) {
    // Row 0: 2 + 1 + 1 (HMD + L + R); Row 1: 1 + 1 + 1 + 1 (4 trackers).
    return {
      cols: 4,
      rows: 2,
      gap: 6,
      padding: INNER_GAP,
      cells: [
        withTooltip(items[0], 0, 0, 2),
        withTooltip(items[1], 2, 0, 1),
        withTooltip(items[2], 3, 0, 1),
        withTooltip(items[3], 0, 1, 1),
        withTooltip(items[4], 1, 1, 1),
        withTooltip(items[5], 2, 1, 1),
        withTooltip(items[6], 3, 1, 1),
      ],
    };
  }
  if (n === 8) {
    return {
      cols: 4,
      rows: 2,
      gap: 6,
      padding: INNER_GAP,
      cells: items.map((item, i) => withTooltip(item, i % 4, Math.floor(i / 4), 1)),
    };
  }
  // 9 devices -> 3x3 horizontal bars; 10+ -> 4x3 horizontal bars.
  const cols = n <= 9 ? 3 : 4;
  const rows = Math.ceil(n / cols);
  return {
    cols,
    rows,
    gap: 4,
    padding: 6,
    cells: items.map((item, i) => withTooltip(item, i % cols, Math.floor(i / cols), 1)),
  };
}

/** Backwards-compatible helper for 3-device `BatteryReadings`. */
export function layoutBatteryEntries(batteries: BatteryReadings): BatteryCellPlacement[] {
  return layoutBatteryGrid(batteryReadingsToItems(batteries)).cells;
}

function BatteryGaugeContent({
  icon,
  reading,
}: {
  icon: IconName;
  reading: BatteryReading;
}) {
  const rect = useCellRect();
  if (!rect) return null;

  const pct = Math.max(0, Math.min(100, Math.round(reading.percent)));
  const r = rect.radius;
  const isLow = !reading.charging && pct <= LOW_BATTERY_PERCENT;
  const fillColor = reading.charging ? COLOR.accent : isLow ? COLOR.danger : NORMAL_FILL;

  // Bar-like (horizontal) when noticeably wider than tall; vertical gauge otherwise.
  const horizontal = rect.width > rect.height * 1.35;

  if (horizontal) {
    const fillW = Math.round((rect.width * pct) / 100);
    const leftR = Math.min(r, rect.height / 2, fillW / 2);
    const rightRemaining = rect.width - fillW;
    const rightR = rightRemaining < r ? Math.min(r - rightRemaining, rect.height / 2, fillW / 2) : 0;
    const compact = rect.height < 36;
    const iconInk = reading.charging && pct >= 25 ? COLOR.onAccent : COLOR.ink;
    const textInk = reading.charging && pct >= 75 ? COLOR.onAccent : COLOR.ink;

    return (
      <Container
        width={rect.width}
        height={rect.height}
        borderRadius={r}
        backgroundColor={TRACK_COLOR}
        backgroundOpacity={1}
        positionType="relative"
        flexDirection="row"
        alignItems="center"
        justifyContent="space-between"
        paddingX={compact ? 8 : 12}
      >
        {fillW > 0 && (
          <Container
            positionType="absolute"
            positionLeft={0}
            positionTop={0}
            width={fillW}
            height={rect.height}
            borderTopLeftRadius={leftR}
            borderBottomLeftRadius={leftR}
            borderTopRightRadius={rightR}
            borderBottomRightRadius={rightR}
            backgroundColor={fillColor}
            backgroundOpacity={1}
          />
        )}
        <Icon name={icon} size={compact ? 16 : 20} color={iconInk} />
        <Text color={textInk} fontSize={compact ? 15 : 18}>{String(pct)}</Text>
      </Container>
    );
  }

  // Vertical bottom-to-top gauge.
  const fillH = Math.round((rect.height * pct) / 100);
  const bottomR = Math.min(r, rect.width / 2, fillH / 2);
  const topRemaining = rect.height - fillH;
  const topR = topRemaining < r ? Math.min(r - topRemaining, rect.width / 2, fillH / 2) : 0;
  const compact = rect.height < 60;
  const wide = rect.width >= 90;

  const iconInk = reading.charging && pct >= 55 ? COLOR.onAccent : COLOR.ink;
  const textInk = reading.charging && pct >= 25 ? COLOR.onAccent : COLOR.ink;

  return (
    <Container
      width={rect.width}
      height={rect.height}
      borderRadius={r}
      backgroundColor={TRACK_COLOR}
      backgroundOpacity={1}
      positionType="relative"
      flexDirection="column"
      alignItems="center"
      justifyContent={compact ? "center" : "space-between"}
      gap={compact ? 1 : 0}
      paddingY={compact ? 3 : 8}
    >
      {fillH > 0 && (
        <Container
          positionType="absolute"
          positionLeft={0}
          positionTop={rect.height - fillH}
          width={rect.width}
          height={fillH}
          borderBottomLeftRadius={bottomR}
          borderBottomRightRadius={bottomR}
          borderTopLeftRadius={topR}
          borderTopRightRadius={topR}
          backgroundColor={fillColor}
          backgroundOpacity={1}
        />
      )}
      {!compact && <Container height={4} backgroundOpacity={0} />}
      <Icon name={icon} size={compact ? 16 : wide ? 30 : 24} color={iconInk} />
      <Text color={textInk} fontSize={compact ? 14 : wide ? 22 : 18}>{String(pct)}</Text>
    </Container>
  );
}

export function BatteryWidget({
  batteries,
  items: itemsProp,
  width = unitSpan(2),
  height = UNIT,
  radius = RADIUS.tile,
  showGuides = false,
  onHoverTooltip,
}: {
  batteries?: BatteryReadings;
  /** Optional arbitrary list of devices (e.g. headset + controllers + trackers). */
  items?: readonly BatteryDeviceItem[];
  /** Explicit dimensions when used outside a `<Cell>`; inherited inside a `<Cell>`. */
  width?: number;
  height?: number;
  radius?: number;
  showGuides?: boolean;
  onHoverTooltip?: (text: string | null) => void;
}) {
  const parentCell = useCellRect();
  const items = itemsProp ?? (batteries ? batteryReadingsToItems(batteries) : []);
  const plan = layoutBatteryGrid(items);
  if (plan.cells.length === 0) return null;

  return (
    <Grid
      cols={plan.cols}
      rows={plan.rows}
      width={parentCell ? undefined : width}
      height={parentCell ? undefined : height}
      gap={plan.gap}
      padding={plan.padding}
      radius={parentCell ? undefined : radius}
      backgroundColor={COLOR.tile}
      backgroundOpacity={1}
      showGuides={showGuides}
    >
      {plan.cells.map((entry) => (
        <Cell
          key={entry.id}
          col={entry.col}
          row={entry.row}
          colSpan={entry.colSpan}
          rowSpan={entry.rowSpan}
          surface="none"
          onHover={onHoverTooltip
            ? (hovered) => onHoverTooltip(hovered ? entry.tooltip : null)
            : undefined}
        >
          <BatteryGaugeContent icon={entry.icon} reading={entry.reading} />
        </Cell>
      ))}
    </Grid>
  );
}
