/**
 * Compact window taskbar integrated into the top of the VR keyboard UI.
 *
 * Renders as a pure uikit row inside `KeyboardFromJson` (inheriting the keyboard's `pixelSize`,
 * `opacity`, `GrabBox` bounds, and hinge spacing). Lists only windows (`kind === "window"`):
 * clicking an active window selects its VR display and focuses it; clicking an inactive window
 * spawns a window-backed `DisplayInstance` for it.
 */
import React, { useMemo, useState } from "react";
import { Container } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Text } from "../ui/text.tsx";
import { COLOR, GAP, INNER_GAP, RADIUS } from "../ui/tokens.ts";
import { pulseForPointerEvent } from "../haptics.ts";
import type { WorkspaceOutput } from "../workspaceDisplays.ts";

/** Taskbar height and gap above the key trays, in keyboard uikit layout units. */
export const KEYBOARD_TASKBAR_HEIGHT = 60;
export const KEYBOARD_TASKBAR_GAP = 10;

const ITEM_HEIGHT = 44;
const PAGE_SIZE = 5;

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

function shortLabel(name: string, max = 16): string {
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
      paddingX={12}
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
      <Text color={ink} fontSize={17}>{label}</Text>
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
  const visibleItems = sorted.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

  return (
    <Container
      width={widthUnits}
      height={KEYBOARD_TASKBAR_HEIGHT}
      padding={INNER_GAP}
      gap={INNER_GAP}
      flexDirection="row"
      alignItems="center"
      borderRadius={RADIUS.shell - GAP}
      backgroundColor={COLOR.ground}
      backgroundOpacity={1}
    >
      {pageCount > 1 && (
        <Container
          width={40}
          height={ITEM_HEIGHT}
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
        flexDirection="row"
        alignItems="center"
        gap={INNER_GAP}
        backgroundOpacity={0}
      >
        {visibleItems.map((win) => (
          <TaskbarButton
            key={win.id}
            label={shortLabel(win.name)}
            active={activeOutputIds.has(win.id)}
            selected={selectedOutputId === win.id}
            onClick={() => onActivateWindow(win)}
          />
        ))}
      </Container>

      {pageCount > 1 && (
        <Container
          width={40}
          height={ITEM_HEIGHT}
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
