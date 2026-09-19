/**
 * The primary wrist overlay.
 *
 * One black square holding a 4x4 tile grid plus a footer. Square deliberately:
 * a wrist overlay's job is a set of buttons and readouts reachable by pointing
 * at it with the other hand, which is a two-dimensional problem. The horizontal
 * convention elsewhere is inherited from sizing the panel around a clock
 * readout — a form factor derived from one piece of content rather than from
 * the interaction.
 *
 * Layout, in units:
 *
 *   +-----------+-----------+
 *   |           |   media   |    clock spans 2x2; the right column stacks two
 *   |   clock   +-----------+    2x1 tiles to the same height
 *   |           |  battery  |
 *   +--+--+--+--+--+--+--+--+
 *   | 1| 1| 1| 1|              four 1x1 toggles
 *   +-----+-----+-----+-----+
 *   |  settings |   exit    |   squeezed row, one sub-unit tall
 *   +-----------+-----------+
 *
 * uikit has no grid, so the "spanning" tile is expressed as a row of two
 * columns. The heights still add up to a square panel — asserted in
 * `tokens.test.ts`.
 */
import React from "react";
import type { AllowedPointerEventsType } from "@pmndrs/pointer-events";
import { Container, Text } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { UiImage } from "./image.tsx";
import { Footer, Pill, Shell, Slot, SlotRow, Tile, TileRow } from "./primitives.tsx";
import { COLOR, GAP, LAST_ROW_HEIGHT, RADIUS, unitSpan } from "./tokens.ts";

/** Glyph ink: dark on an accent fill, light at rest. One fixed pairing. */
function glyphInk(active: boolean): string {
  return active ? COLOR.onAccent : COLOR.ink;
}

/**
 * PetPlay's two modes. See `wristMenu/types.ts` for why they are related rather
 * than independent.
 */
export type WristOverlayToggleId = "layout" | "edit";

export type WristOverlayProps = {
  clock?: string;
  dateLabel?: string;
  active?: Partial<Record<WristOverlayToggleId, boolean>>;
  onToggle?: (id: WristOverlayToggleId) => void;
  onOpenSettings?: () => void;
  status?: string;
  /** Displays currently in the spatial graph, for the readout. */
  displayCount?: number;
  pointerEventsType?: AllowedPointerEventsType;
};

/**
 * Clock tile, 2x2 -> a 4x4 slot grid. Time takes the accent, because it is the
 * one readout you glance at rather than read, and the accent pairing is the
 * system's strongest contrast.
 */
function ClockTile(
  { clock, dateLabel }: { clock: string; dateLabel: string },
) {
  const size = unitSpan(2);
  return (
    <Tile units={2} rows={2}>
      {/*
        The wallpaper is the tile's surface, not an element inside it, so it
        takes the tile's own corner radius. `focus` keeps the right edge of a
        wide image, matching the crop the design called for.
      */}
      <UiImage
        texture="wallpaper"
        width={size}
        height={size}
        radius={RADIUS.tile}
        focus={[1, 0.5]}
      />
      <Pill slots={4} units={2} tone="accent" fontSize={44}>{clock}</Pill>
      {/*
        Time and date only. There was a third pill here showing a session
        counter that read "496509:25:18" — the value was wrong and, working or
        not, an uptime figure is not something you glance at a wrist for.
      */}
      <Pill slots={4} units={2} fontSize={14}>{dateLabel}</Pill>
    </Tile>
  );
}

/**
 * The generic 2x1 tile: a label pill across the top slot row, four slots across
 * the bottom. A slot's content is arbitrary — a glyph, a readout, or nothing —
 * so the same shape covers media, battery, and whatever is added later.
 */
function SlotTile(
  { label, labelSlots = 4, slots }: {
    label: string;
    /** Label width in whole slots, so its edge lands on the grid. */
    labelSlots?: number;
    slots: ReadonlyArray<
      | {
        icon: IconName;
        active?: boolean;
        disabled?: boolean;
        value?: string;
        onClick?: () => void;
      }
      | null
    >;
  },
) {
  return (
    <Tile units={2}>
      <Container flexDirection="row" width={unitSpan(2)} justifyContent="flex-start">
        <Pill slots={labelSlots} units={2} fontSize={14}>{label}</Pill>
      </Container>
      <SlotRow>
        {slots.map((slot, index) => {
          if (slot == null) {
            // Occupies its cell rather than letting the others redistribute:
            // the absence is legible, and the room for a fourth is visible.
            return <Slot key={`empty-${index}`} units={2} empty />;
          }
          const ink = slot.disabled
            ? COLOR.inkDim
            : glyphInk(slot.active ?? false);
          return (
            <Slot
              key={index}
              units={2}
              active={slot.active}
              disabled={slot.disabled}
              onClick={slot.onClick}
            >
              <Icon name={slot.icon} size={slot.value ? 16 : 22} color={ink} />
              {slot.value ? <Text color={ink} fontSize={11}>{slot.value}</Text> : null}
            </Slot>
          );
        })}
      </SlotRow>
    </Tile>
  );
}

/** A 1x1 tile is a rounded square, not a circle — rule 3 is about nesting depth. */
function GlyphTile(
  { icon, active, disabled, onClick }: {
    icon: IconName;
    active?: boolean;
    /** Present but not usable yet — dimmed rather than hidden. */
    disabled?: boolean;
    onClick?: () => void;
  },
) {
  return (
    <Tile
      units={1}
      active={active && !disabled}
      onClick={disabled ? undefined : onClick}
    >
      <Icon
        name={icon}
        size={40}
        color={disabled ? COLOR.inkDim : glyphInk(active ?? false)}
      />
    </Tile>
  );
}

export function WristOverlay(
  {
    clock = "12:00",
    dateLabel = "FRI 24 APR",
    active = {},
    onToggle,
    onOpenSettings,
    status = "Native module active",
    displayCount = 0,
    pointerEventsType,
  }: WristOverlayProps,
) {
  const on = (id: WristOverlayToggleId) => active[id] ?? false;

  return (
    <Shell pointerEventsType={pointerEventsType} footer={<Footer>{status}</Footer>}>
      {/* Rows 1-2: the 2x2 clock beside a stack of two 2x1 tiles. */}
      <Container flexDirection="row" gap={GAP} alignItems="flex-start">
        <ClockTile clock={clock} dateLabel={dateLabel} />
        <Container flexDirection="column" gap={GAP}>
          {/*
            The 2x1 tiles hold *readouts*: a label pill over a row of small
            circles. Actions live in the big 1x1 tiles below, where they are
            easier to hit with a pointer from the other hand.
          */}
          <SlotTile
            label="DISPLAYS"
            labelSlots={3}
            slots={[
              { icon: "desktop_windows", value: String(displayCount) },
              null,
              null,
              null,
            ]}
          />
          {/*
            Reserved for battery. Left as a plain tile rather than a labelled
            one with empty circles: PetPlay has no battery source yet, so even
            the label would be a promise the panel cannot keep.
          */}
          <Tile units={2} />
        </Container>
      </Container>

      {/*
        Row 3: the primary actions, as full tiles. Edit is dimmed while layout
        is off — it manipulates the spatial layer, and with layout off there is
        nothing on screen for it to act on.

        The fourth tile is empty rather than filled with a plausible-looking
        control. Every remaining candidate has no state in PetPlay to read or
        write yet, and a button that does nothing is worse than a visible gap.
      */}
      <TileRow>
        <GlyphTile
          icon="grid_view"
          active={on("layout")}
          onClick={() => onToggle?.("layout")}
        />
        <GlyphTile
          icon="tune"
          active={on("edit")}
          disabled={!on("layout")}
          onClick={() => onToggle?.("edit")}
        />
        <GlyphTile icon="settings" onClick={onOpenSettings} />
        <Tile units={1} />
      </TileRow>

      {/*
        Row 4 is squeezed to one sub-unit so the panel comes out square, and is
        currently empty. It held SETTINGS (now a tile above) and EXIT, which was
        removed: the only shutdown path in the tree is a `Deno.exit(1)` in the
        desktop child's error handler, so the button did nothing.
      */}
      <TileRow>
        <Tile units={4} height={LAST_ROW_HEIGHT} />
      </TileRow>
    </Shell>
  );
}
