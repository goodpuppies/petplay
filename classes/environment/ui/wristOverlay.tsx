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
 *   |   clock   +-----------+    2x1 tiles to the same height (media, or the
 *   |           |  battery  |    display count when nothing is playing)
 *   +--+--+--+--+--+--+--+--+
 *   | 1| 1| 1| 1|              four 1x1 toggles
 *   +-----+-----+-----+-----+
 *   |  artist · title       |   squeezed row, one sub-unit tall
 *   +-----------------------+
 *
 * uikit has no grid, so the "spanning" tile is expressed as a row of two
 * columns. The heights still add up to a square panel — asserted in
 * `tokens.test.ts`.
 */
import React, { useEffect, useState } from "react";
import type { AllowedPointerEventsType } from "@pmndrs/pointer-events";
import { Container } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Text } from "./text.tsx";
import { measureMsdfText } from "../../../submodules/threewebxrwebgpudeno/msdf-text.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { UiImage } from "./image.tsx";
import { type BatteryDeviceItem, BatteryWidget } from "./batteryWidget.tsx";
import { Footer, Pill, Shell, Slot, SlotRow, Tile, TileRow } from "./primitives.tsx";
import { COLOR, GAP, GRID_WIDTH, INNER_GAP, RADIUS, unitSpan } from "./tokens.ts";
import type { BatteryReadings } from "../batteryStore.ts";
import { type MediaCommand, type NowPlaying, nowPlayingLabel } from "../mediaStore.ts";
import { truncateText } from "./wrapText.ts";

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
  /** Move the layout in front of the head. */
  onRecenter?: () => void;
  status?: string;
  /** Displays currently in the spatial graph, for the readout. */
  displayCount?: number;
  batteries?: BatteryReadings;
  /** Optional arbitrary list of battery devices (overrides `batteries` when provided). */
  batteryItems?: readonly BatteryDeviceItem[];
  /** The active media player, if any: swaps the displays readout for transport controls. */
  nowPlaying?: NowPlaying | null;
  onMedia?: (command: MediaCommand) => void;
  opacity?: number;
  pointerEventsType?: AllowedPointerEventsType;
};

/**
 * Clock tile, 2x2 -> a 4x4 slot grid. Time takes the accent, because it is the
 * one readout you glance at rather than read, and the accent pairing is the
 * system's strongest contrast.
 */
function ClockTile({ clock }: { clock: string }) {
  const size = unitSpan(2);
  return (
    <Tile units={2} rows={2}>
      {
        /*
        The wallpaper is the tile's surface, not an element inside it, so it
        takes the tile's own corner radius. `focus` keeps the right edge of a
        wide image, matching the crop the design called for.
      */
      }
      <UiImage
        texture="wallpaper"
        width={size}
        height={size}
        radius={RADIUS.tile}
        focus={[1, 0.5]}
      />
      <Pill slots={4} units={2} tone="accent" fontSize={52} height={72}>{clock}</Pill>
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
        tooltip?: string;
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
          const ink = slot.disabled ? COLOR.inkDim : glyphInk(slot.active ?? false);
          return (
            <Slot
              key={index}
              units={2}
              active={slot.active}
              disabled={slot.disabled}
              tooltip={slot.tooltip}
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

const FOOTER_FONT_SIZE = 36;

/** Truncates a string to fit inside the footer's single-line pill. */
function useFooterLabel(label: string): string {
  const [fitted, setFitted] = useState(label);
  useEffect(() => {
    let cancelled = false;
    const maxWidth = GRID_WIDTH - 2 * (GAP + INNER_GAP);
    truncateText(
      label,
      maxWidth,
      async (line) => (await measureMsdfText(line, FOOTER_FONT_SIZE)).width,
    ).then((next) => {
      if (!cancelled) setFitted(next);
    });
    return () => {
      cancelled = true;
    };
  }, [label]);
  return fitted;
}

/** A 1x1 tile is a rounded square, not a circle — rule 3 is about nesting depth. */
function GlyphTile(
  { icon, tooltip, active, disabled, onClick }: {
    icon: IconName;
    tooltip: string;
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
      tooltip={tooltip}
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
    onRecenter,
    status = "Native module active",
    displayCount = 0,
    batteries = {},
    batteryItems,
    nowPlaying = null,
    onMedia,
    opacity,
    pointerEventsType,
  }: WristOverlayProps,
) {
  const on = (id: WristOverlayToggleId) => active[id] ?? false;
  const infoText = useFooterLabel(nowPlaying != null ? nowPlayingLabel(nowPlaying) : status);

  return (
    <Shell
      pointerEventsType={pointerEventsType}
      opacity={opacity}
      footer={<Footer>{infoText}</Footer>}
    >
      {/* Rows 1-2: the 2x2 clock beside a stack of two 2x1 tiles. */}
      <Container flexDirection="row" gap={GAP} alignItems="flex-start">
        <ClockTile clock={clock} />
        <Container flexDirection="column" gap={GAP}>
          {
            /*
            The 2x1 tiles hold *readouts*: a label pill over a row of small
            circles. Actions live in the big 1x1 tiles below, where they are
            easier to hit with a pointer from the other hand.
          */
          }
          {
            /*
            Media takes the top slot while a player is running: skipping a
            track is a wrist job, the display count is not. Transport buttons
            are small for actions, but they sit where the panel was designed
            to hold them.
          */
          }
          {nowPlaying != null
            ? (
              <SlotTile
                label="MEDIA"
                labelSlots={3}
                slots={[
                  {
                    icon: "skip_previous",
                    tooltip: "Previous track",
                    onClick: () => onMedia?.("previous"),
                  },
                  {
                    icon: nowPlaying.playing ? "pause" : "play_arrow",
                    tooltip: nowPlaying.playing ? "Pause" : "Play",
                    active: nowPlaying.playing,
                    onClick: () => onMedia?.("play-pause"),
                  },
                  { icon: "skip_next", tooltip: "Next track", onClick: () => onMedia?.("next") },
                  null,
                ]}
              />
            )
            : (
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
            )}
          {
            /*
            Battery: left, right, headset, from OpenVR. Charging takes the
            accent. With no readings (no SteamVR, or a tethered headset and
            controllers still waking) it stays a plain tile rather than a
            label over empty circles.
          */
          }
          {(batteryItems && batteryItems.length > 0) || batteries.left || batteries.right ||
              batteries.hmd
            ? <BatteryWidget batteries={batteries} items={batteryItems} />
            : <Tile units={2} />}
        </Container>
      </Container>

      {
        /*
        Row 3: the primary actions, as full tiles. Edit is dimmed while layout
        is off — it manipulates the spatial layer, and with layout off there is
        nothing on screen for it to act on.

        Recenter is an action, not a mode, so it never takes the accent. It is
        dimmed with Edit: with layout off there is no layout to move.
      */
      }
      <TileRow>
        <GlyphTile
          icon="grid_view"
          tooltip={on("layout") ? "Hide windows" : "Show windows"}
          active={on("layout")}
          onClick={() => onToggle?.("layout")}
        />
        <GlyphTile
          icon="tune"
          tooltip={on("layout")
            ? (on("edit") ? "Stop editing layout" : "Edit layout")
            : "Edit layout (show windows first)"}
          active={on("edit")}
          disabled={!on("layout")}
          onClick={() => onToggle?.("edit")}
        />
        <GlyphTile icon="settings" tooltip="Settings" onClick={onOpenSettings} />
        <GlyphTile
          icon="open_with"
          tooltip={on("layout") ? "Recenter windows" : "Recenter (show windows first)"}
          disabled={!on("layout")}
          onClick={onRecenter}
        />
      </TileRow>
    </Shell>
  );
}
