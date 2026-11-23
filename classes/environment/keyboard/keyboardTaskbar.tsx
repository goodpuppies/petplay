/**
 * Compact window taskbar integrated into the top of the VR keyboard UI.
 *
 * Renders as a pure uikit block inside `KeyboardFromJson` (inheriting the keyboard's `pixelSize`,
 * `opacity`, `GrabBox` bounds, and hinge spacing). Lists only windows (`kind === "window"`):
 * automatically expands up to 2 rows (up to 16 windows visible at once, with `‹`/`›` paging if
 * more are open). Clicking a window spawns a new `DisplayInstance` showing just that window (or
 * focuses its display if already open).
 */
import React, { useMemo, useState } from "react";
import { Container } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Text } from "../ui/text.tsx";
import { COLOR, GAP, INNER_GAP, RADIUS } from "../ui/tokens.ts";
import { pulseForPointerEvent } from "../haptics.ts";
import type { WorkspaceOutput } from "../workspaceDisplays.ts";

/** Gap above the key trays in keyboard uikit layout units. */
export const KEYBOARD_TASKBAR_GAP = 10;

const PER_ROW = 8;
const MAX_ROWS = 2;
const PAGE_SIZE = PER_ROW * MAX_ROWS;
const ITEM_HEIGHT = 36;
const ROW_GAP = 6;
const PAD = INNER_GAP;

/** Exact taskbar height in keyboard uikit layout units for `windowCount` windows. */
export function keyboardTaskbarHeight(windowCount: number): number {
  if (windowCount <= 0) return 0;
  const rows = Math.min(MAX_ROWS, Math.max(1, Math.ceil(windowCount / PER_ROW)));
  return PAD * 2 + rows * ITEM_HEIGHT + (rows - 1) * ROW_GAP;
}

export type KeyboardTaskbarProps = {
  /** Total keyboard width in uikit layout units (from `keyboardContentBoundsUnits`). */
  widthUnits: number;
  windows: ReadonlyArray<WorkspaceOutput>;
  /** Output ids currently assigned to a `DisplayInstance`. */
  activeOutputIds: ReadonlySet<string>;
  /** Output id of the currently selected `DisplayInstance`, if any. */
  selectedOutputId?: string | null;
  onActivateWindow: (output: WorkspaceOutput) => void;
};

function shortLabel(name: string, max = 13): string {
  const trimmed = name.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function TaskbarButton({
  label,
  active,
  selected,
  onClick,
}: {
  label: string;
  active: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const bg = selected
    ? COLOR.accent
    : active
    ? (hovered ? COLOR.tileHi : "#262833")
    : (hovered ? COLOR.tileHi : COLOR.tile);
  const ink = selected ? COLOR.onAccent : active ? COLOR.ink : COLOR.inkDim;
  return (
    <Container
      flexGrow={1}
      flexBasis={0}
      height={ITEM_HEIGHT}
      paddingX={8}
      borderRadius={RADIUS.slot}
      borderWidth={active && !selected ? 1 : 0}
      borderColor={COLOR.accent}
      backgroundColor={bg}
      backgroundOpacity={1}
      alignItems="center"
      justifyContent="center"
      onPointerOver={(event: unknown) => {
        setHovered(true);
        pulseForPointerEvent(event, "hover");
      }}
      onPointerOut={() => setHovered(false)}
      onClick={(event: unknown) => {
        pulseForPointerEvent(event, "click");
        onClick();
      }}
    >
      <Text color={ink} fontSize={14}>{label}</Text>
    </Container>
  );
}

export function KeyboardTaskbar({
  widthUnits,
  windows,
  activeOutputIds,
  selectedOutputId,
  onActivateWindow,
}: KeyboardTaskbarProps) {
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    const list = [...windows];
    list.sort((a, b) => {
      const aActive = activeOutputIds.has(a.id) ? 0 : 1;
      const bActive = activeOutputIds.has(b.id) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [windows, activeOutputIds]);

  if (sorted.length === 0) return null;

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageItems = sorted.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);
  const rowCount = Math.min(MAX_ROWS, Math.max(1, Math.ceil(sorted.length / PER_ROW)));
  const rows: WorkspaceOutput[][] = [];
  for (let r = 0; r < rowCount; r++) {
    rows.push(pageItems.slice(r * PER_ROW, (r + 1) * PER_ROW));
  }
  const totalHeight = keyboardTaskbarHeight(sorted.length);

  return (
    <Container
      width={widthUnits}
      height={totalHeight}
      padding={PAD}
      gap={INNER_GAP}
      flexDirection="row"
      alignItems="center"
      borderRadius={RADIUS.shell - GAP}
      backgroundColor={COLOR.ground}
      backgroundOpacity={1}
    >
      {pageCount > 1 && (
        <Container
          width={36}
          height={totalHeight - PAD * 2}
          flexShrink={0}
          borderRadius={RADIUS.slot}
          backgroundColor={COLOR.tile}
          backgroundOpacity={1}
          alignItems="center"
          justifyContent="center"
          onClick={(event: unknown) => {
            pulseForPointerEvent(event, "click");
            setPage((p) => (p - 1 + pageCount) % pageCount);
          }}
        >
          <Text color={COLOR.ink} fontSize={18}>‹</Text>
        </Container>
      )}

      <Container
        flexGrow={1}
        flexDirection="column"
        gap={ROW_GAP}
        backgroundOpacity={0}
      >
        {rows.map((row, rowIdx) => (
          <Container
            key={rowIdx}
            flexDirection="row"
            alignItems="center"
            gap={ROW_GAP}
            height={ITEM_HEIGHT}
            backgroundOpacity={0}
          >
            {row.map((win) => (
              <TaskbarButton
                key={win.id}
                label={shortLabel(win.name)}
                active={activeOutputIds.has(win.id)}
                selected={selectedOutputId === win.id}
                onClick={() => onActivateWindow(win)}
              />
            ))}
          </Container>
        ))}
      </Container>

      {pageCount > 1 && (
        <Container
          width={36}
          height={totalHeight - PAD * 2}
          flexShrink={0}
          borderRadius={RADIUS.slot}
          backgroundColor={COLOR.tile}
          backgroundOpacity={1}
          alignItems="center"
          justifyContent="center"
          onClick={(event: unknown) => {
            pulseForPointerEvent(event, "click");
            setPage((p) => (p + 1) % pageCount);
          }}
        >
          <Text color={COLOR.ink} fontSize={18}>›</Text>
        </Container>
      )}
    </Container>
  );
}
