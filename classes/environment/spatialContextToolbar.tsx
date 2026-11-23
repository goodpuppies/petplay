/**
 * Contextual toolbar for a selected spatial node.
 *
 * Uses the same vocabulary as the wrist overlay — black card, white outlines,
 * one accent, text in pills — but not its 4x4 tile grid. The grid is the wrist
 * panel's *frame*; this is a floating contextual surface whose content varies
 * with the node in focus, so it takes the tokens and the recursive spacing and
 * radius rules without the fixed layout.
 *
 * Widths still snap to the slot grid: actions span a whole number of slots and
 * two fit per row, so the card's right edge is straight no matter how long the
 * labels are. That is the rule that keeps an otherwise rigid system from
 * reading as loose.
 */
import React, { useEffect, useRef, useState } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { useFrame } from "@react-three/fiber/webgpu";
import type { AllowedPointerEventsType } from "@pmndrs/pointer-events";
import { Container } from "../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Text } from "./ui/text.tsx";
import { Pill } from "./ui/primitives.tsx";
import { Icon, type IconName } from "./ui/icons.tsx";
import {
  COLOR,
  GAP,
  INNER_GAP,
  OUTLINE_WIDTH,
  RADIUS,
  slotSize,
  UNIT,
  unitSpan,
} from "./ui/tokens.ts";
import { pulseForPointerEvent } from "./haptics.ts";
import { GrabBox, type GrabBoxManipulationOptions } from "./grabbox.tsx";
import { useToolEditMode } from "./toolEditMode.ts";
import { getSetting, setSetting } from "../settings.ts";
import { defaultApply, type HandleState } from "@pmndrs/handle";
import { recordPress } from "./pressLog.ts";

/**
 * Action id -> glyph.
 *
 * Icons rather than words, the way XSO's toolbar works. It also fits this
 * system better: a single-unit element *inside a card* is a circle, so a row of
 * actions becomes a row of circles in a card sized to hold them — rule 4
 * exactly ("a 3-button menu is a 3-wide card holding 3 circles").
 *
 * An action with no mapping falls back to a generic glyph rather than
 * disappearing, so adding one to the scene never silently produces a blank
 * button.
 */
const ACTION_ICONS: Record<string, IconName> = {
  "add-display": "add",
  // `link`, not `link_off`: the button reports that the node *is* linked. The
  // icon names the state, the accent says it is on, and pressing it ends it.
  detach: "link",
  delete: "delete",
  lock: "lock",
  reset: "refresh",
  settings: "settings",
};

const FALLBACK_ACTION_ICON: IconName = "more_horiz";

export type SpatialContextAction = {
  id: string;
  label: string;
  icon?: IconName;
  tone?: "normal" | "danger" | "accent";
  disabled?: boolean;
  run: () => void;
};

export type SpatialContextToolbarProps = {
  title: string;
  actions: SpatialContextAction[];
  /** Legacy inline settings children (wrapped in the toolbar's default settings shell). */
  settings?: React.ReactNode;
  /** Self-contained recursive-grid settings panel (e.g. `DisplaySettingsPanel`), rendered directly. */
  settingsPanel?: React.ReactNode;
  /**
   * Where the card attaches, in the node's space: the middle of the bottom edge, which the card
   * hangs below; with `side: "above"` the middle of the top edge, which it stands on; with
   * `"left"`/`"right"` that side's top corner, which it hangs beside.
   */
  position: [number, number, number];
  /**
   * "above" when something hangs from the node's bottom edge (a hinged keyboard): below, the card
   * would sit behind it and every button would lose the ray to the keys in front. "left"/"right"
   * when both edges are taken (a window between another window and a keyboard): the card turns
   * into a narrow column beside the node.
   */
  side?: "below" | "above" | "left" | "right";
  /**
   * With `side: "above"`, the node-space corner the settings card hangs from by its top-left
   * corner (a window's top-right corner). Growing up from a raised card would put the settings
   * far above eye level, and hanging them over the window would reach down behind the keyboard,
   * so they open beside it.
   */
  settingsPosition?: [number, number, number];
  /**
   * The node's place in its hierarchy, shown as a badge at the start of the title row. The card
   * covers the space the floating badge would take, so it carries the badge while it is open.
   */
  role?: HierarchyRole;
  /** World size, independent of how far the node is scaled. */
  scale?: number;
  /**
   * Whether the card shows. Keep it mounted and flip this rather than mounting it on selection:
   * uikit builds the icons a couple of frames after mount, so a fresh card popped in half-drawn.
   */
  open?: boolean;
  /** Initial state of the settings sub-panel (default false; useful in UI previews). */
  defaultSettingsOpen?: boolean;
  /** When true, displays a wifi/signal icon next to the display name. */
  sharing?: boolean;
  pointerEventsType?: AllowedPointerEventsType;
};

/**
 * Icon button: a **rounded square**, not a circle.
 *
 * The circle rule is about what an element sits *on*, not how deep it is: this
 * card's background is the same pure black ground the wrist shell uses, so its
 * children are top-level elements and take the tile shape. A circle would only
 * be right one level further in, sitting on a grey tile.
 *
 * The label is the tooltip: while the tile is hovered it replaces the title in
 * the card's pill — an icon-only control still has to say what it is somewhere.
 */
function ActionTile(
  { action, onHover }: {
    action: SpatialContextAction;
    onHover: (id: string | null) => void;
  },
) {
  const [hovered, setHovered] = useState(false);
  const hover = (next: boolean) => {
    // A disabled tile still says what it is; it just doesn't light up.
    setHovered(next && !action.disabled);
    onHover(next ? action.id : null);
  };
  const danger = action.tone === "danger";
  const accent = action.tone === "accent";
  const filled = (danger || accent) && !action.disabled;
  const fill = danger
    ? (hovered ? COLOR.dangerBright : COLOR.danger)
    : accent
    ? (hovered ? COLOR.accentBright : COLOR.accent)
    : hovered
    ? COLOR.tileHi
    : COLOR.tile;
  const ink = action.disabled
    ? COLOR.inkDim
    : danger
    ? COLOR.onDanger
    : accent
    ? COLOR.onAccent
    : COLOR.ink;
  return (
    <Container
      width={UNIT}
      height={UNIT}
      // Concentric with the card: its radius minus the padding it sits inside.
      borderRadius={RADIUS.shell - GAP}
      alignItems="center"
      justifyContent="center"
      backgroundColor={filled ? fill : hovered ? COLOR.tileHi : COLOR.tile}
      backgroundOpacity={1}
      onPointerOver={(event: unknown) => {
        hover(true);
        if (!action.disabled) pulseForPointerEvent(event, "hover");
      }}
      onPointerOut={() => hover(false)}
      onClick={action.disabled ? undefined : (event: unknown) => {
        pulseForPointerEvent(event, "click");
        recordPress(`toolbar:${action.id}`, event);
        action.run();
      }}
    >
      <Icon
        name={action.icon ?? ACTION_ICONS[action.id] ?? FALLBACK_ACTION_ICON}
        size={40}
        color={ink}
      />
    </Container>
  );
}

/** Metres between the node's edge and the near side of the card. */
const EDGE_GAP = 0.015;
/** The card's default world scale (`scale` prop). */
const DEFAULT_TOOLBAR_SCALE = 0.72;

/**
 * The card's size in its own units (uikit pixels × 0.001): shell padding, the title pill and rows
 * of tiles, with the settings closed. Two tiles wide beside a window, one row of them otherwise.
 */
function cardSize(tileCount: number, vertical: boolean): [number, number] {
  const units = vertical ? 2 : Math.max(2, tileCount);
  const rows = vertical ? Math.max(1, Math.ceil(tileCount / 2)) : 1;
  const width = unitSpan(units) + GAP * 2;
  const height = GAP * 2 + slotSize(units) + GAP + rows * UNIT + (rows - 1) * GAP;
  return [width * 0.001, height * 0.001];
}

/**
 * The menu's world footprint for choosing a side clear of other windows
 * (`displayToolbarSide`). `tileCount` counts the actions and the settings button.
 */
export function contextToolbarFootprint(
  tileCount: number,
  scale = DEFAULT_TOOLBAR_SCALE,
): { horizontal: [number, number]; vertical: [number, number]; gap: number } {
  const k = scale * getSetting("contextToolbarScale");
  const [hw, hh] = cardSize(tileCount, false);
  const [vw, vh] = cardSize(tileCount, true);
  return { horizontal: [hw * k, hh * k], vertical: [vw * k, vh * k], gap: EDGE_GAP };
}
/** The `contextToolbarScale` setting's range. */
const MIN_USER_SCALE = 0.5;
const MAX_USER_SCALE = 2;

export function SpatialContextToolbar({
  title,
  actions,
  settings,
  settingsPanel,
  position,
  side = "below",
  settingsPosition,
  role,
  scale = DEFAULT_TOOLBAR_SCALE,
  pointerEventsType = "all",
  open = true,
  defaultSettingsOpen = false,
  sharing = false,
}: SpatialContextToolbarProps) {
  const [settingsOpen, setSettingsOpen] = useState(defaultSettingsOpen);
  const hasSettings = settingsPanel != null || settings != null;
  // By id, so the tooltip follows a label that changes on click (Lock -> "Locked — unlock") and
  // goes away with a tile that a click removed, which never gets its pointer-out.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // Closing used to unmount the card, which reset these; reopen it the same way.
  useEffect(() => {
    if (open) return;
    setSettingsOpen(false);
    setHoveredId(null);
  }, [open]);

  // Rule 4: the card is sized in whole element units to what it holds — a
  // 3-button menu is a 3-wide card holding 3 buttons. Two is the floor, or the
  // title pill has no room to say anything useful.
  const tileCount = actions.length + (hasSettings ? 1 : 0);
  const units = Math.max(2, tileCount);
  // Beside the node the card is a column two tiles wide, the narrowest the title pill reads at;
  // the tiles wrap into rows of two.
  const vertical = side === "left" || side === "right";
  const cardUnits = vertical ? 2 : units;
  const settingsAction: SpatialContextAction = {
    id: "settings",
    label: settingsOpen ? "Hide settings" : "Settings",
    tone: settingsOpen ? "accent" : "normal",
    run: () => setSettingsOpen((open) => !open),
  };
  const hoverLabel = hoveredId == null
    ? null
    : [...actions, ...(hasSettings ? [settingsAction] : [])]
      .find((action) => action.id === hoveredId)?.label ?? null;

  // The card is a control, not part of the window: it stays the same size and the same distance
  // below the edge however far the window is scaled, so counter the parent's world scale each
  // frame. It appears at full size: a scale-in pop read as motion and was nauseating in VR.
  const group = useRef<THREE.Group>(null);
  const settingsGroup = useRef<THREE.Group>(null);
  const scratch = useRef({ parentScale: new THREE.Vector3() });
  // Edit layout mode resizes the card (never moves it): the trigger resize or a two-hand pinch
  // scales this inner group, and letting go folds that into the shared `contextToolbarScale`.
  const editing = useToolEditMode();
  const resizeRef = useRef<THREE.Group>(null);
  const resizeFolded = useRef(false);
  const resizeOptions = React.useMemo((): GrabBoxManipulationOptions => ({
    // Resize only: one hand by trigger, two hands by pinch, about the docked edge.
    translate: false,
    rotate: false,
    scale: { uniform: true },
    multitouch: true,
    triggerResize: {},
    apply: (state: HandleState<unknown>, target: import("three").Object3D) => {
      defaultApply(state, target);
      if (!state.last) return;
      const k = target.scale.x;
      if (Math.abs(k - 1) < 1e-4) return;
      const current = getSetting("contextToolbarScale");
      setSetting(
        "contextToolbarScale",
        Math.min(MAX_USER_SCALE, Math.max(MIN_USER_SCALE, current * k)),
      );
      resizeFolded.current = true;
    },
  }), []);
  useFrame(() => {
    const node = group.current;
    if (node?.parent == null) return;
    const s = scratch.current;
    node.parent.getWorldScale(s.parentScale);
    const k = scale * getSetting("contextToolbarScale");
    // The setting now carries the resize: drop it from the inner group in the same frame.
    if (resizeFolded.current) {
      resizeFolded.current = false;
      resizeRef.current?.scale.setScalar(1);
    }
    node.scale.set(k / s.parentScale.x, k / s.parentScale.y, k / s.parentScale.z);
    if (vertical) {
      const gap = (side === "right" ? EDGE_GAP : -EDGE_GAP) / s.parentScale.x;
      node.position.set(position[0] + gap, position[1], position[2]);
      return;
    }
    const gap = (side === "above" ? EDGE_GAP : -EDGE_GAP) / s.parentScale.y;
    node.position.set(position[0], position[1] + gap, position[2]);
    // Inside the counter-scaled group, a node-space offset d is d * parentScale / k.
    const card = settingsGroup.current;
    if (card != null && settingsPosition != null) {
      card.position.set(
        (settingsPosition[0] - position[0]) * s.parentScale.x / k + EDGE_GAP / k,
        (settingsPosition[1] - position[1] - gap) * s.parentScale.y / k,
        (settingsPosition[2] - position[2]) * s.parentScale.z / k,
      );
    }
  });
  // Self-contained `settingsPanel` (e.g. `DisplaySettingsPanel`) always pops up right at the
  // hover menu, attached to the menu's outer edge so it never gets clipped by a narrower toolbar
  // shell or teleported to a distant display corner. Legacy `settings` stays inline unless the
  // toolbar is vertical or explicitly positioned.
  const detachedSettings = settingsPanel != null || vertical ||
    (side === "above" && settingsPosition != null);
  const shellFor = (n: number) => ({
    pixelSize: 0.001,
    width: unitSpan(n) + GAP * 2,
    padding: GAP,
    gap: GAP,
    alignItems: "stretch",
    borderRadius: RADIUS.shell,
    backgroundColor: COLOR.ground,
    backgroundOpacity: 1,
    pointerEventsType,
  } as const);
  // The settings panel is a fixed 4-unit card (528px, same width as the wrist shell) so sliders,
  // toggles, and 20px labels fill the card edge-to-edge cleanly.
  const settingsShell = shellFor(4);
  const toolbarShell = shellFor(cardUnits);
  // uikit pixels are 0.001 group units (`pixelSize`).
  const besideCard = (toolbarShell.width + GAP) * 0.001;
  // The card's outline for edit mode's grab box: shell padding, title pill, rows of tiles.
  const [cardWidth, cardHeight] = cardSize(tileCount, vertical);
  const cardCenter: [number, number, number] = [
    side === "right" ? cardWidth / 2 : side === "left" ? -cardWidth / 2 : 0,
    side === "above" ? cardHeight / 2 : -cardHeight / 2,
    0,
  ];

  return (
    <group
      ref={group}
      position={position}
      scale={[scale, scale, scale]}
      visible={open}
      userData={{ spatialContextToolbar: true }}
      {
        // Pointer events ignore `visible`, so a closed card must also stop rays from reaching it.
        ...({ pointerEventsOrder: 20, intersectChildren: open } as Record<string, unknown>)
      }
    >
      {
        /*
        A small shell rather than a tile: black ground, the shell's radius, and
        the shell's padding-equals-gap rhythm. Everything inside is therefore a
        top-level element on the same terms as the wrist panel's tiles.
      */
      }
      {
        /*
        Anchored on the window's side, so opening settings grows the card away from the window.
        Above the window it mirrors: the title stays next to the edge.
      */
      }
      {
        /*
        Beside the window it hangs from the top corner and grows down, alongside the window
        rather than into the stack above or below it.
      */
      }
      <group ref={resizeRef}>
        {editing && open && (
          <group position={cardCenter}>
            <GrabBox
              width={cardWidth}
              height={cardHeight}
              depth={0.02}
              // Grab only: trigger presses go through to the buttons.
              shellRayPickable={false}
              manipulationTargetRef={resizeRef}
              manipulationOptions={resizeOptions}
              grabFilter={(event) => event.pointerType !== "ray" && event.pointerType !== "poker"}
              userData={{ contextToolbarResize: true }}
            />
          </group>
        )}
        <Container
          {...toolbarShell}
          anchorX={side === "right" ? "left" : side === "left" ? "right" : undefined}
          anchorY={side === "above" ? "bottom" : "top"}
          flexDirection={side === "above" ? "column-reverse" : "column"}
        >
          {
            /*
          The one piece of text left: the icons say what the actions do, but
          nothing else says which node they act on. Spans the full card width,
          so its edges land on the grid like every other pill.

          Outlined, not accented: a node's name is not a state. Accent is
          reserved for "this is on", so on a detached node nothing in this card
          is lit at all — which is the point.
        */
          }
          <Container flexDirection="row" alignItems="center" gap={INNER_GAP}>
            {role != null && <HierarchyBadge role={role} size={slotSize(cardUnits)} />}
            <Container
              flexGrow={1}
              height={slotSize(cardUnits)}
              flexDirection="row"
              alignItems="center"
              justifyContent="flex-start"
              gap={INNER_GAP}
              paddingX={INNER_GAP}
              backgroundOpacity={0}
            >
              <Text color={COLOR.ink} fontSize={32}>
                {hoverLabel ?? title}
              </Text>
              {sharing && hoverLabel == null && (
                <Icon name="wifi" size={26} color={COLOR.accent} />
              )}
            </Container>
          </Container>

          <Container flexDirection="row" flexWrap="wrap" gap={GAP}>
            {actions.map((action) => (
              <ActionTile key={action.id} action={action} onHover={setHoveredId} />
            ))}
            {hasSettings && <ActionTile action={settingsAction} onHover={setHoveredId} />}
          </Container>
          {settingsOpen && !detachedSettings && (settingsPanel ?? settings)}
        </Container>
        {settingsOpen && detachedSettings && (
          <group
            ref={vertical || settingsPosition == null ? undefined : settingsGroup}
            position={vertical
              ? [side === "right" ? besideCard : -besideCard, 0, 0]
              : settingsPosition == null
              ? [
                0,
                side === "above" ? cardHeight + GAP * 0.001 : -(cardHeight + GAP * 0.001),
                0,
              ]
              : undefined}
          >
            {settingsPanel != null
              ? (
                <Container
                  pixelSize={0.001}
                  anchorX={side === "left" ? "right" : side === "right" ? "left" : "center"}
                  anchorY={side === "above" && settingsPosition == null ? "bottom" : "top"}
                  backgroundOpacity={0}
                >
                  {settingsPanel}
                </Container>
              )
              : (
                <Container
                  {...settingsShell}
                  anchorX={side === "left" ? "right" : side === "right" ? "left" : "center"}
                  anchorY={side === "above" && settingsPosition == null ? "bottom" : "top"}
                  flexDirection="column"
                >
                  {settings}
                </Container>
              )}
          </group>
        )}
      </group>
    </group>
  );
}

export function SpatialSettingsSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Container flexDirection="column" gap={INNER_GAP} paddingTop={INNER_GAP}>
      <Text color={COLOR.inkDim} fontSize={20}>{label}</Text>
      <Container flexDirection="row" flexWrap="wrap" gap={INNER_GAP}>
        {children}
      </Container>
    </Container>
  );
}

export function SpatialSettingsButton({
  label,
  selected = false,
  tone,
  onClick,
}: {
  label: string;
  selected?: boolean;
  tone?: "normal" | "danger";
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const isDanger = tone === "danger";
  const bg = isDanger
    ? (hovered ? COLOR.dangerBright : COLOR.danger)
    : selected
    ? (hovered ? COLOR.accentBright : COLOR.accent)
    : (hovered ? COLOR.tileHi : COLOR.tile);
  const ink = isDanger
    ? COLOR.onDanger
    : selected
    ? COLOR.onAccent
    : COLOR.ink;
  return (
    <Container
      paddingX={20}
      height={58}
      borderRadius={RADIUS.slot}
      alignItems="center"
      justifyContent="center"
      backgroundColor={bg}
      backgroundOpacity={1}
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
      <Text color={ink} fontSize={20}>{label}</Text>
    </Container>
  );
}

/** Full-width interactive toggle row for boolean display settings. */
export function SpatialSettingsToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Container
      width={unitSpan(4)}
      height={62}
      paddingX={GAP}
      borderRadius={RADIUS.slot}
      backgroundColor={hovered ? COLOR.tileHi : COLOR.tile}
      backgroundOpacity={1}
      flexDirection="row"
      alignItems="center"
      justifyContent="space-between"
      onPointerOver={(event: unknown) => {
        setHovered(true);
        pulseForPointerEvent(event, "hover");
      }}
      onPointerOut={() => setHovered(false)}
      onClick={(event: unknown) => {
        pulseForPointerEvent(event, "click");
        onChange(!value);
      }}
    >
      <Text color={COLOR.ink} fontSize={20}>{label}</Text>
      <Container
        width={80}
        height={40}
        borderRadius={20}
        alignItems="center"
        justifyContent="center"
        backgroundColor={value ? COLOR.accent : COLOR.ground}
        backgroundOpacity={1}
      >
        <Text color={value ? COLOR.onAccent : COLOR.inkDim} fontSize={18}>
          {value ? "ON" : "OFF"}
        </Text>
      </Container>
    </Container>
  );
}

/**
 * Full-width interactive slider bar (click or drag anywhere along the track).
 * Uses the same horizontal progress-fill visual language as the battery bars.
 */
export function SpatialSettingsSlider({
  label,
  value,
  min,
  max,
  step = 0.05,
  formatValue,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  formatValue: (value: number) => string;
  onChange: (next: number) => void;
}) {
  const dragging = useRef(false);
  const trackWidth = unitSpan(4);
  const trackHeight = 66;
  const r = RADIUS.slot;

  const fraction = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;
  const fillW = Math.round(trackWidth * fraction);
  const leftR = Math.min(r, trackHeight / 2, fillW / 2);
  const rightRem = trackWidth - fillW;
  const rightR = rightRem < r ? Math.min(r - rightRem, trackHeight / 2, fillW / 2) : 0;

  const updateFromEvent = (event: unknown) => {
    const uvX = (event as { uv?: { x?: number } } | null)?.uv?.x;
    if (typeof uvX !== "number" || !Number.isFinite(uvX)) return;
    const t = Math.max(0, Math.min(1, uvX));
    const raw = min + t * (max - min);
    const snapped = Math.round(raw / step) * step;
    const clamped = Math.max(min, Math.min(max, Math.round(snapped * 1000) / 1000));
    if (Math.abs(clamped - value) > 1e-4) onChange(clamped);
  };

  return (
    <Container
      width={trackWidth}
      height={trackHeight}
      borderRadius={r}
      backgroundColor="#141418"
      backgroundOpacity={1}
      positionType="relative"
      flexDirection="row"
      alignItems="center"
      justifyContent="space-between"
      paddingX={GAP}
      onPointerDown={(event: unknown) => {
        dragging.current = true;
        const e = event as {
          pointerId?: number;
          target?: { setPointerCapture?: (id: number) => void };
        };
        if (typeof e.pointerId === "number") e.target?.setPointerCapture?.(e.pointerId);
        pulseForPointerEvent(event, "click");
        updateFromEvent(event);
      }}
      onPointerMove={(event: unknown) => {
        if (!dragging.current) return;
        updateFromEvent(event);
      }}
      onPointerUp={(event: unknown) => {
        dragging.current = false;
        const e = event as {
          pointerId?: number;
          target?: { releasePointerCapture?: (id: number) => void };
        };
        if (typeof e.pointerId === "number") e.target?.releasePointerCapture?.(e.pointerId);
      }}
    >
      {fillW > 0 && (
        <Container
          positionType="absolute"
          positionLeft={0}
          positionTop={0}
          width={fillW}
          height={trackHeight}
          borderTopLeftRadius={leftR}
          borderBottomLeftRadius={leftR}
          borderTopRightRadius={rightR}
          borderBottomRightRadius={rightR}
          backgroundColor="#4a4d5c"
          backgroundOpacity={1}
        />
      )}
      <Text color={COLOR.ink} fontSize={20}>{label}</Text>
      <Text color={COLOR.accent} fontSize={22}>{formatValue(value)}</Text>
    </Container>
  );
}

/**
 * Marks a node's place in the hierarchy.
 *
 * A rounded square, not a circle: it sits on the world rather than inside a
 * card, which makes it a top-level element. The circle shape belongs to
 * single-unit elements nested on a tile.
 */
type HierarchyRole = "parent" | "child" | "solo";

/** P, C or S in a circle: whether a window holds others, hangs from one, or stands alone. */
function HierarchyBadge(
  { role, size, pixelSize }: { role: HierarchyRole; size: number; pixelSize?: number },
) {
  const label = role === "parent" ? "P" : role === "child" ? "C" : "S";
  return (
    <Container
      pixelSize={pixelSize}
      width={size}
      height={size}
      flexShrink={0}
      alignItems="center"
      justifyContent="center"
      borderRadius={RADIUS.shell - GAP}
      borderWidth={OUTLINE_WIDTH}
      borderColor={COLOR.outline}
      backgroundColor={COLOR.ground}
      backgroundOpacity={1}
    >
      {
        /*
        Text directly, not wrapped in a pill: the circle already *is* the
        round container the text rule asks for (radius = half the smaller
        side), so nesting a pill inside it would be the same shape twice.
      */
      }
      <Text color={COLOR.ink} fontSize={18}>{label}</Text>
    </Container>
  );
}

export function SpatialHierarchyIndicator({
  role,
  position,
  visible = true,
}: {
  role: HierarchyRole;
  position: [number, number, number];
  visible?: boolean;
}) {
  return (
    <group
      position={position}
      visible={visible}
      userData={{ spatialHierarchyIndicator: role }}
      {...({ pointerEvents: "none", pointerEventsOrder: 30 } as Record<string, unknown>)}
    >
      <HierarchyBadge role={role} size={UNIT * 0.5} pixelSize={0.001} />
    </group>
  );
}
