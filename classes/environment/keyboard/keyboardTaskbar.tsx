/**
 * Compact taskbar docked along the top edge of the VR keyboard.
 *
 * Lists available screens and windows (`WorkspaceOutput[]`), highlighting those currently shown
 * on a VR `DisplayInstance`. Clicking an active item selects its display (and focuses a window
 * on the host); clicking an inactive item spawns a `DisplayInstance` for it.
 */
import React, { useMemo, useState } from "react";
import { Container } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Text } from "../ui/text.tsx";
import { COLOR, GAP, INNER_GAP, RADIUS } from "../ui/tokens.ts";
import { pulseForPointerEvent } from "../haptics.ts";
import { DEFAULT_KEYBOARD_PIXEL_SIZE } from "./keyboardUi.tsx";
import type { WorkspaceOutput } from "../workspaceDisplays.ts";

export type KeyboardTaskbarProps = {
  /** Keyboard panel width in local meters (`node.snapSource.size[0]`). */
  widthMeters: number;
  /** Position of the taskbar's bottom-center anchor in keyboard local space. */
  position: [number, number, number];
  outputs: ReadonlyArray<WorkspaceOutput>;
  /** Output ids currently assigned to a `DisplayInstance`. */
  activeOutputIds: ReadonlySet<string>;
  /** Output id of the currently selected `DisplayInstance`, if any. */
  selectedOutputId?: string | null;
  onActivateOutput: (output: WorkspaceOutput) => void;
  opacity?: number;
};

const BAR_HEIGHT_PX = 56;
const ITEM_HEIGHT_PX = 40;
const PAGE_SIZE = 5;

function shortLabel(name: string, max = 14): string {
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
      height={ITEM_HEIGHT_PX}
      paddingX={10}
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
      <Text color={ink} fontSize={16}>{label}</Text>
    </Container>
  );
}

export function KeyboardTaskbar({
  widthMeters,
  position,
  outputs,
  activeOutputIds,
  selectedOutputId,
  onActivateOutput,
  opacity = 1,
}: KeyboardTaskbarProps) {
  const [filter, setFilter] = useState<"all" | "windows">("all");
  const [page, setPage] = useState(0);

  const hasWindows = useMemo(() => outputs.some((o) => o.kind === "window"), [outputs]);
  const filtered = useMemo(() => {
    const base = filter === "windows" && hasWindows
      ? outputs.filter((o) => o.kind === "window")
      : [...outputs];
    // Keep active displays first, then monitors before windows.
    base.sort((a, b) => {
      const aActive = activeOutputIds.has(a.id) ? 0 : 1;
      const bActive = activeOutputIds.has(b.id) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      const aWin = a.kind === "window" ? 1 : 0;
      const bWin = b.kind === "window" ? 1 : 0;
      if (aWin !== bWin) return aWin - bWin;
      return a.name.localeCompare(b.name);
    });
    return base;
  }, [outputs, filter, hasWindows, activeOutputIds]);

  if (outputs.length === 0) return null;

  const pixelSize = DEFAULT_KEYBOARD_PIXEL_SIZE;
  const barWidthPx = Math.max(520, Math.round(widthMeters / pixelSize));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const visibleItems = filtered.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

  return (
    <group
      position={position}
      userData={{ keyboardTaskbar: true }}
      {...({ pointerEventsOrder: 20 } as Record<string, unknown>)}
    >
      <Container
        pixelSize={pixelSize}
        width={barWidthPx}
        height={BAR_HEIGHT_PX}
        padding={INNER_GAP}
        gap={INNER_GAP}
        flexDirection="row"
        alignItems="center"
        anchorX="center"
        anchorY="bottom"
        borderRadius={RADIUS.shell - GAP}
        backgroundColor={COLOR.ground}
        backgroundOpacity={Math.max(0.2, Math.min(1, opacity))}
        pointerEventsType={{ deny: "grab" }}
      >
        {hasWindows && (
          <Container
            height={ITEM_HEIGHT_PX}
            paddingX={12}
            flexShrink={0}
            borderRadius={RADIUS.slot}
            backgroundColor={filter === "windows" ? COLOR.accent : COLOR.tile}
            backgroundOpacity={1}
            alignItems="center"
            justifyContent="center"
            onClick={(event: unknown) => {
              pulseForPointerEvent(event, "click");
              setFilter((f) => f === "all" ? "windows" : "all");
              setPage(0);
            }}
          >
            <Text color={filter === "windows" ? COLOR.onAccent : COLOR.ink} fontSize={15}>
              {filter === "windows" ? "Wins" : "All"}
            </Text>
          </Container>
        )}

        {pageCount > 1 && (
          <Container
            width={36}
            height={ITEM_HEIGHT_PX}
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
          {visibleItems.map((output) => (
            <TaskbarButton
              key={output.id}
              label={shortLabel(output.name)}
              active={activeOutputIds.has(output.id)}
              selected={selectedOutputId === output.id}
              onClick={() => onActivateOutput(output)}
            />
          ))}
        </Container>

        {pageCount > 1 && (
          <Container
            width={36}
            height={ITEM_HEIGHT_PX}
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
    </group>
  );
}
