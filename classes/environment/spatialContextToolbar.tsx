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
import React, { useState } from "react";
import type { AllowedPointerEventsType } from "@pmndrs/pointer-events";
import { Container, Text } from "../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Pill } from "./ui/primitives.tsx";
import { Icon, type IconName } from "./ui/icons.tsx";
import { COLOR, GAP, INNER_GAP, OUTLINE_WIDTH, RADIUS, UNIT, unitSpan } from "./ui/tokens.ts";

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
  reset: "refresh",
  settings: "settings",
};

const FALLBACK_ACTION_ICON: IconName = "more_horiz";

export type SpatialContextAction = {
  id: string;
  label: string;
  tone?: "normal" | "danger" | "accent";
  disabled?: boolean;
  run: () => void;
};

export type SpatialContextToolbarProps = {
  title: string;
  actions: SpatialContextAction[];
  settings?: React.ReactNode;
  position: [number, number, number];
  scale?: number;
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
 * The label survives as the hover title rather than being drawn — an icon-only
 * control still has to say what it is somewhere.
 */
function ActionTile(
  { action }: { action: SpatialContextAction },
) {
  const [hovered, setHovered] = useState(false);
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
      onPointerOver={action.disabled ? undefined : () => setHovered(true)}
      onPointerOut={action.disabled ? undefined : () => setHovered(false)}
      onClick={action.disabled ? undefined : action.run}
      {...({ title: action.label } as Record<string, unknown>)}
    >
      <Icon
        name={ACTION_ICONS[action.id] ?? FALLBACK_ACTION_ICON}
        size={40}
        color={ink}
      />
    </Container>
  );
}

export function SpatialContextToolbar({
  title,
  actions,
  settings,
  position,
  scale = 0.72,
  pointerEventsType = "all",
}: SpatialContextToolbarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Rule 4: the card is sized in whole element units to what it holds — a
  // 3-button menu is a 3-wide card holding 3 buttons. Two is the floor, or the
  // title pill has no room to say anything useful.
  const tileCount = actions.length + (settings != null ? 1 : 0);
  const units = Math.max(2, tileCount);

  return (
    <group
      position={position}
      scale={[scale, scale, scale]}
      userData={{ spatialContextToolbar: true }}
      {...({ pointerEventsOrder: 20 } as Record<string, unknown>)}
    >
      {
        /*
        A small shell rather than a tile: black ground, the shell's radius, and
        the shell's padding-equals-gap rhythm. Everything inside is therefore a
        top-level element on the same terms as the wrist panel's tiles.
      */
      }
      <Container
        pixelSize={0.001}
        width={unitSpan(units) + GAP * 2}
        padding={GAP}
        gap={GAP}
        flexDirection="column"
        alignItems="stretch"
        borderRadius={RADIUS.shell}
        backgroundColor={COLOR.ground}
        backgroundOpacity={1}
        pointerEventsType={pointerEventsType}
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
        <Pill slots={units * 2} units={units} fontSize={14}>
          {title}
        </Pill>

        <Container flexDirection="row" gap={GAP}>
          {actions.map((action) => <ActionTile key={action.id} action={action} />)}
          {settings != null && (
            <ActionTile
              action={{
                id: "settings",
                label: settingsOpen ? "Hide settings" : "Settings",
                tone: settingsOpen ? "accent" : "normal",
                run: () => setSettingsOpen((open) => !open),
              }}
            />
          )}
        </Container>
        {settingsOpen && settings}
      </Container>
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
      <Pill slots={4} units={2} fontSize={12}>{label}</Pill>
      <Container flexDirection="row" flexWrap="wrap" gap={INNER_GAP}>
        {children}
      </Container>
    </Container>
  );
}

export function SpatialSettingsButton({
  label,
  selected = false,
  onClick,
}: {
  label: string;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <Pill
      slots={4}
      units={2}
      fontSize={12}
      tone={selected ? "accent" : "outline"}
      onClick={onClick}
    >
      {label}
    </Pill>
  );
}

/**
 * Marks a node's place in the hierarchy.
 *
 * A rounded square, not a circle: it sits on the world rather than inside a
 * card, which makes it a top-level element. The circle shape belongs to
 * single-unit elements nested on a tile.
 */
export function SpatialHierarchyIndicator({
  role,
  position,
  visible = true,
}: {
  role: "parent" | "child" | "solo";
  position: [number, number, number];
  visible?: boolean;
}) {
  const label = role === "parent" ? "P" : role === "child" ? "C" : "S";
  const size = UNIT * 0.5;
  return (
    <group
      position={position}
      visible={visible}
      userData={{ spatialHierarchyIndicator: role }}
      {...({ pointerEvents: "none", pointerEventsOrder: 30 } as Record<string, unknown>)}
    >
      <Container
        pixelSize={0.001}
        width={size}
        height={size}
        alignItems="center"
        justifyContent="center"
        borderRadius={RADIUS.shell - GAP}
        borderWidth={OUTLINE_WIDTH}
        borderColor={COLOR.outline}
        borderOpacity={1}
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
    </group>
  );
}
