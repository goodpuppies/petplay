/**
 * The overlay UI vocabulary, as uikit components.
 *
 * Everything here is sized from {@link tokens}: nothing takes a raw pixel
 * value, so the whole panel re-proportions from `UNIT` and `GAP` alone. Where
 * the sandbox used CSS grid, these compute explicit sizes instead — uikit's
 * layout is flexbox only, and the system is arithmetic anyway.
 *
 * The rules, in the order they win when they collide:
 *   1. spacing rhythm (padding == gap)
 *   2. concentric radius (each level is its parent's minus that level's inset)
 *   3. shape (pill / circle) — an outcome of an over-large radius, not a rule
 *
 * **Nothing here sets `overflow: "hidden"`.** In this renderer it does not clip
 * a child to the parent's rounded box, it removes the child's panel from the
 * draw entirely — text still renders, since it takes a different path, so a
 * clipped container looks like bare floating labels rather than like clipping.
 * Every pill and circle was invisible until this came off.
 *
 * The cost is that the design's "text that does not fit is clipped rather than
 * pushing the pill off-grid" is currently unenforced: overlong text will spill
 * past its pill instead. Pills are sized in whole slots regardless, so the grid
 * still holds; only the ellipsis behaviour is missing.
 */
import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { useFacingOpacity } from "../facingVisibility.tsx";
import type { AllowedPointerEventsType } from "@pmndrs/pointer-events";
import { Container } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Text } from "./text.tsx";
import {
  clampRadius,
  COLOR,
  FOOTER_HEIGHT,
  GAP,
  GRID_WIDTH,
  INNER_GAP,
  LAST_ROW_HEIGHT,
  OUTLINE_WIDTH,
  RADIUS,
  slotSize,
  slotSpan,
  UNIT,
  unitSpan,
} from "./tokens.ts";
import { pulseForPointerEvent } from "../haptics.ts";

/**
 * Pill / circle intent, resolved to a real number by {@link clampRadius}.
 *
 * CSS silently clamps `border-radius` at half the smaller side, which is what
 * lets "pill" and "circle" be outcomes rather than separate rules. uikit has no
 * such clamp, and the panel shader packs the four corners into one integer with
 * each limited to `0..49`:
 *
 *   borderRadius = vec4(p / 125000 % 50, p / 2500 % 50, p / 50 % 50, p % 50) * 0.01
 *
 * so a value this large cannot survive the encoding. Clamping is therefore ours
 * to do rather than the renderer's.
 */
const FULL_ROUND = 999;

/** Hover handlers for a button: highlight state plus a haptic tick on the pointing hand. */
/**
 * Tooltips. Icon-only controls name themselves in the shell's footer while hovered, in place of
 * the status line, rather than in a floating label that could land under the other hand's laser.
 * Each hover takes an owner token, so a control that unmounts while hovered clears only its own.
 */
type TooltipStore = {
  tooltip: string | null;
  show(owner: object, text: string): void;
  hide(owner: object): void;
};
const TooltipContext = createContext<TooltipStore | null>(null);

function useTooltipStore(): TooltipStore {
  const [state, setState] = useState<{ owner: object; text: string } | null>(null);
  return {
    tooltip: state?.text ?? null,
    show: (owner, text) => setState({ owner, text }),
    hide: (owner) => setState((current) => current?.owner === owner ? null : current),
  };
}

/**
 * Pointer handlers for a control: hover highlight and haptic only while `enabled`, the tooltip
 * always, so a disabled control still says what it is.
 */
function useHoverHandlers(
  enabled: boolean,
  setHovered: (hovered: boolean) => void,
  tooltip?: string,
) {
  const store = useContext(TooltipContext);
  const owner = useRef({}).current;
  const storeRef = useRef(store);
  storeRef.current = store;
  const hoveredRef = useRef(false);
  useEffect(() => () => storeRef.current?.hide(owner), [owner]);
  // Follows a label that changes while hovered, such as play turning into pause.
  useEffect(() => {
    if (hoveredRef.current && tooltip != null) storeRef.current?.show(owner, tooltip);
  }, [owner, tooltip]);
  if (!enabled && tooltip == null) return { onPointerOver: undefined, onPointerOut: undefined };
  return {
    onPointerOver: (event: unknown) => {
      hoveredRef.current = true;
      if (tooltip != null) store?.show(owner, tooltip);
      if (!enabled) return;
      setHovered(true);
      pulseForPointerEvent(event, "hover");
    },
    onPointerOut: () => {
      hoveredRef.current = false;
      store?.hide(owner);
      setHovered(false);
    },
  };
}

/** A click handler that also pulses the clicking hand. */
function withClickHaptic(onClick: (() => void) | undefined) {
  if (onClick == null) return undefined;
  return (event: unknown) => {
    pulseForPointerEvent(event, "click");
    onClick();
  };
}

export type PillTone = "outline" | "accent" | "solid" | "danger";

/**
 * All text lives in a pill, and a pill is a **whole number of slots wide** —
 * never sized to its text.
 *
 * A pill that hugs its content lands its right edge at an arbitrary offset,
 * which is precisely what makes an otherwise rigid grid read as loose. Text that
 * does not fit is clipped rather than pushing the pill off-grid.
 */
export function Pill(
  { children, slots, units = 2, tone = "outline", fontSize = 15, height, onClick, disabled }: {
    children: React.ReactNode;
    /** Width in whole slots. */
    slots: number;
    /** Units spanned by the tile this pill sits in, which sets the slot size. */
    units?: number;
    tone?: PillTone;
    fontSize?: number;
    /** Defaults to one slot tall, so the pill is a true pill. */
    height?: number;
    /** A pill with a handler is a button; without one it is a label. */
    onClick?: () => void;
    disabled?: boolean;
  },
) {
  const [hovered, setHovered] = useState(false);
  const handlers = useHoverHandlers(onClick != null && !disabled, setHovered);
  const width = slotSpan(slots, units);
  const pillHeight = height ?? slotSize(units);
  const filled = tone === "accent" || tone === "danger" || tone === "solid";
  const fill = tone === "danger"
    ? (hovered && !disabled ? COLOR.dangerBright : COLOR.danger)
    : tone === "accent"
    ? (hovered && !disabled ? COLOR.accentBright : COLOR.accent)
    : COLOR.tile;
  const ink = disabled
    ? COLOR.inkDim
    : tone === "accent"
    ? COLOR.onAccent
    : tone === "danger"
    ? COLOR.onDanger
    : COLOR.ink;
  return (
    <Container
      width={width}
      height={pillHeight}
      borderRadius={clampRadius(FULL_ROUND, width, pillHeight)}
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      backgroundColor={fill}
      backgroundOpacity={filled && !disabled ? 1 : 0}
      borderWidth={filled && !disabled ? 0 : OUTLINE_WIDTH}
      borderColor={disabled ? COLOR.inkDim : hovered && onClick ? COLOR.accent : COLOR.outline}
      {...handlers}
      onClick={disabled ? undefined : withClickHaptic(onClick)}
    >
      <Text color={ink} fontSize={fontSize}>
        {children}
      </Text>
    </Container>
  );
}

/**
 * A single slot's worth of content. Square by construction, so by rule 3 it is
 * a circle rather than a small square — the rule is about nesting depth, not
 * absolute size, which is why tiles stay rounded squares and these do not.
 */
export function Slot(
  { children, units = 2, active = false, onClick, empty = false, disabled = false, tooltip }: {
    children?: React.ReactNode;
    units?: number;
    active?: boolean;
    onClick?: () => void;
    /** Shown in the shell's footer while hovered. */
    tooltip?: string;
    /** Renders nothing but still occupies its cell, keeping the grid honest. */
    empty?: boolean;
    /**
     * Present but not currently usable. Drawn with dimmed ink rather than
     * hidden, so the control's existence — and the fact that something else
     * has to be turned on first — stays visible.
     */
    disabled?: boolean;
  },
) {
  const [hovered, setHovered] = useState(false);
  const handlers = useHoverHandlers(onClick != null && !disabled, setHovered, tooltip);
  const size = slotSize(units);
  if (empty) {
    return <Container width={size} height={size} backgroundOpacity={0} />;
  }
  return (
    <Container
      width={size}
      height={size}
      borderRadius={clampRadius(FULL_ROUND, size, size)}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      gap={2}
      backgroundColor={active ? COLOR.accent : COLOR.tile}
      backgroundOpacity={active && !disabled ? 1 : 0}
      borderWidth={active && !disabled ? 0 : OUTLINE_WIDTH}
      borderColor={disabled ? COLOR.inkDim : hovered ? COLOR.accent : COLOR.outline}
      {...handlers}
      onClick={disabled ? undefined : withClickHaptic(onClick)}
    >
      {children}
    </Container>
  );
}

/**
 * A tile: a rounded square spanning whole units, with no padding of its own.
 * The slot grid has to meet the tile edge, so breathing room comes from the
 * pills' own padding instead.
 */
export function Tile(
  { children, units = 1, rows = 1, height, active = false, onClick, fill = true, tooltip }: {
    children?: React.ReactNode;
    /** Shown in the shell's footer while hovered. */
    tooltip?: string;
    units?: number;
    rows?: number;
    /** Overrides the derived height, for the squeezed last row. */
    height?: number;
    active?: boolean;
    onClick?: () => void;
    fill?: boolean;
  },
) {
  const [hovered, setHovered] = useState(false);
  const handlers = useHoverHandlers(onClick != null, setHovered, tooltip);
  return (
    <Container
      width={unitSpan(units)}
      height={height ?? unitSpan(rows)}
      borderRadius={RADIUS.tile}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      gap={INNER_GAP}
      backgroundColor={active ? COLOR.accent : hovered ? COLOR.tileHi : COLOR.tile}
      backgroundOpacity={fill ? 1 : 0}
      {...handlers}
      onClick={withClickHaptic(onClick)}
    >
      {children}
    </Container>
  );
}

/** A row of slots inside a tile, edge to edge. */
export function SlotRow(
  { children, justify = "flex-start" }: {
    children?: React.ReactNode;
    justify?: "flex-start" | "center" | "space-between";
  },
) {
  return (
    <Container flexDirection="row" alignItems="center" gap={INNER_GAP} justifyContent={justify}>
      {children}
    </Container>
  );
}

/**
 * A control states its options in full and highlights the one in effect —
 * `((follow head) dont follow head)`. There is no separate title: the phrasing
 * of each option *is* the label, so what it does and what state it is in are one
 * object rather than two sitting beside each other.
 *
 * Two options reads as a toggle, more than two as a mode picker; same component.
 * The track is an outline rather than a filled step, so nesting never has to
 * spend another value step against a pure-black ground.
 */
export function Control<T extends string>(
  { options, value, onChange, units = 2, fontSize = 14 }: {
    options: ReadonlyArray<{ value: T; label: string }>;
    value: T;
    onChange?: (next: T) => void;
    units?: number;
    fontSize?: number;
  },
) {
  const height = slotSize(units);
  const inset = OUTLINE_WIDTH + 2;
  return (
    <Container
      flexDirection="row"
      alignItems="center"
      gap={4}
      padding={inset}
      height={height}
      borderRadius={clampRadius(FULL_ROUND, height, height)}
      backgroundOpacity={0}
      borderWidth={OUTLINE_WIDTH}
      borderColor={COLOR.outline}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Container
            key={option.value}
            paddingX={14}
            height={height - inset * 2}
            borderRadius={clampRadius(FULL_ROUND, height - inset * 2, height - inset * 2)}
            alignItems="center"
            justifyContent="center"
            backgroundColor={COLOR.accent}
            backgroundOpacity={selected ? 1 : 0}
            onClick={withClickHaptic(onChange ? () => onChange(option.value) : undefined)}
          >
            <Text color={selected ? COLOR.onAccent : COLOR.inkDim} fontSize={fontSize}>
              {option.label}
            </Text>
          </Container>
        );
      })}
    </Container>
  );
}

/**
 * Edge-to-edge status strip along the bottom of the shell. White on black,
 * inverting the panel so it reads as a separate register from the tiles.
 */
export function Footer({ children }: { children?: React.ReactNode }) {
  const tooltip = useContext(TooltipContext)?.tooltip;
  return (
    <Container
      width={GRID_WIDTH}
      height={FOOTER_HEIGHT}
      borderRadius={RADIUS.footer}
      flexDirection="row"
      alignItems="center"
      paddingX={GAP + INNER_GAP}
      backgroundColor={COLOR.ink}
      backgroundOpacity={1}
    >
      <Text color={COLOR.ground} fontSize={36}>{tooltip ?? children}</Text>
    </Container>
  );
}

/**
 * The panel itself: one black square holding the tile grid and the footer.
 *
 * The bottom corners use a smaller radius than the top. A child sitting at a
 * container's corner must be at least `2 * (parentRadius - inset)` tall to
 * carry the radius its position requires; the footer is one sub-unit tall and
 * cannot carry 44, so the shell yields rather than the footer growing. Which
 * lever you reach for depends on whether the container's shape or the child's
 * size is the free one — here the footer height is load-bearing elsewhere.
 */
export function Shell(
  { children, footer, pointerEventsType, pointerEventsOrder = 100, opacity = 1 }: {
    children?: React.ReactNode;
    footer?: React.ReactNode;
    pointerEventsType?: AllowedPointerEventsType;
    /** Inherited by every uikit Container inside the shell so displays behind it (order 1) never steal hits. */
    pointerEventsOrder?: number;
    /** Whole-panel opacity; uikit's `opacity` is inherited by everything inside. */
    opacity?: number;
  },
) {
  const tooltips = useTooltipStore();
  const effectiveOpacity = useFacingOpacity(opacity);
  return (
    <TooltipContext.Provider value={tooltips}>
      <Container
        pixelSize={0.001}
        pointerEventsType={pointerEventsType}
        pointerEventsOrder={pointerEventsOrder}
        opacity={effectiveOpacity}
        width={GRID_WIDTH + GAP * 2}
        padding={GAP}
        flexDirection="column"
        alignItems="center"
        gap={GAP}
        backgroundColor={COLOR.ground}
        backgroundOpacity={1}
        borderTopLeftRadius={RADIUS.shell}
        borderTopRightRadius={RADIUS.shell}
        borderBottomLeftRadius={RADIUS.shellBottom}
        borderBottomRightRadius={RADIUS.shellBottom}
      >
        <Container flexDirection="column" gap={GAP} alignItems="flex-start">
          {children}
        </Container>
        {footer}
      </Container>
    </TooltipContext.Provider>
  );
}

/** A row of the tile grid. The last row is squeezed to make the panel square. */
export function TileRow({ children }: { children?: React.ReactNode }) {
  return (
    <Container flexDirection="row" gap={GAP} alignItems="flex-start">
      {children}
    </Container>
  );
}

export { GAP, LAST_ROW_HEIGHT, UNIT };
