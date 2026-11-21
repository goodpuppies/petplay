/**
 * Interactive Recursive Grid lab:
 *   - Left: PetPlay's 4×4 Wrist Menu built purely from `<Grid>` and `<Cell>` (with live toggles
 *     for grid guides, media vs displays, and Row 4 full context strip vs empty grid space).
 *   - Right: Interactive recursive subdivision sandbox — click any cell to split it into a nested
 *     2×2 `<Grid>`, watching gap halving and concentric corner radii resolve automatically.
 */
import React, { useState } from "react";
import { Container } from "../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Text } from "../../classes/environment/ui/text.tsx";
import { Icon, type IconName } from "../../classes/environment/ui/icons.tsx";
import { UiImage } from "../../classes/environment/ui/image.tsx";
import {
  type BatteryDeviceItem,
  BatteryWidget,
} from "../../classes/environment/ui/batteryWidget.tsx";
import { Cell, Grid, useCellRect } from "../../classes/environment/ui/grid.tsx";
import { COLOR, GAP, INNER_GAP, RADIUS, SHELL_SIZE } from "../../classes/environment/ui/tokens.ts";
import type { PreviewSceneProps } from "./index.ts";

function Chip(
  { label, active, onClick }: { label: string; active?: boolean; onClick: () => void },
) {
  return (
    <Container
      paddingX={10}
      paddingY={5}
      borderRadius={999}
      backgroundColor={active ? COLOR.accent : COLOR.tile}
      backgroundOpacity={1}
      onClick={onClick}
    >
      <Text fontSize={12} color={active ? COLOR.onAccent : COLOR.ink}>{label}</Text>
    </Container>
  );
}

function ClockWallpaper() {
  const rect = useCellRect();
  if (!rect) return null;
  return (
    <UiImage
      texture="wallpaper"
      width={rect.width}
      height={rect.height}
      radius={rect.radius}
      focus={[1, 0.5]}
    />
  );
}

/** Recursive tree node for the interactive split sandbox on the right. */
type SplitNode = { id: string; children: SplitNode[] | null };

function makeNode(id: string): SplitNode {
  return { id, children: null };
}

function toggleSplit(node: SplitNode, targetId: string, depth: number): SplitNode {
  if (node.id === targetId) {
    if (node.children) return { ...node, children: null };
    if (depth >= 3) return node;
    return {
      ...node,
      children: [
        makeNode(`${node.id}.0`),
        makeNode(`${node.id}.1`),
        makeNode(`${node.id}.2`),
        makeNode(`${node.id}.3`),
      ],
    };
  }
  if (!node.children) return node;
  return {
    ...node,
    children: node.children.map((child) => toggleSplit(child, targetId, depth + 1)),
  };
}

function RecursiveSandboxNode({
  node,
  col,
  row,
  depth,
  showGuides,
  onSplit,
}: {
  node: SplitNode;
  col: number;
  row: number;
  depth: number;
  showGuides: boolean;
  onSplit: (id: string) => void;
}) {
  if (node.children) {
    return (
      <Cell col={col} row={row} surface="none">
        <Grid cols={2} rows={2} showGuides={showGuides}>
          {node.children.map((child, idx) => (
            <RecursiveSandboxNode
              key={child.id}
              node={child}
              col={idx % 2}
              row={Math.floor(idx / 2)}
              depth={depth + 1}
              showGuides={showGuides}
              onSplit={onSplit}
            />
          ))}
        </Grid>
      </Cell>
    );
  }
  const surface = depth === 0 ? "tile" : depth === 1 ? "outline" : depth === 2 ? "accent" : "inverted";
  const ink = surface === "accent"
    ? COLOR.onAccent
    : surface === "inverted"
    ? COLOR.ground
    : COLOR.ink;
  return (
    <Cell
      col={col}
      row={row}
      surface={surface}
      onClick={() => onSplit(node.id)}
    >
      <Text color={ink} fontSize={depth <= 1 ? 14 : 11}>
        {depth < 3 ? `d${depth + 1}` : "●"}
      </Text>
    </Cell>
  );
}

const MOCK_BATTERY_POOL: readonly BatteryDeviceItem[] = [
  { id: "hmd", label: "Headset", icon: "headset", reading: { percent: 86, charging: false } },
  { id: "left", label: "Left controller", icon: "videogame_asset", reading: { percent: 74, charging: false } },
  { id: "right", label: "Right controller", icon: "videogame_asset", reading: { percent: 92, charging: true } },
  { id: "hip", label: "Hip tracker", icon: "battery_full", reading: { percent: 68, charging: false } },
  { id: "lfoot", label: "Left foot", icon: "battery_full", reading: { percent: 45, charging: false } },
  { id: "rfoot", label: "Right foot", icon: "battery_full", reading: { percent: 14, charging: false } },
  { id: "chest", label: "Chest tracker", icon: "battery_full", reading: { percent: 81, charging: false } },
  { id: "lknee", label: "Left knee", icon: "battery_full", reading: { percent: 55, charging: false } },
  { id: "rknee", label: "Right knee", icon: "battery_full", reading: { percent: 62, charging: true } },
];

const BATTERY_COUNTS = [3, 4, 6, 7, 8, 9] as const;

export function RecursiveGridScene({ stageCenter, scale }: PreviewSceneProps) {
  const [showGuides, setShowGuides] = useState(false);
  const [footerMode, setFooterMode] = useState<"expanded" | "empty">("expanded");
  const [mediaPlaying, setMediaPlaying] = useState(true);
  const [batteryCountIdx, setBatteryCountIdx] = useState(0);
  const [layoutOn, setLayoutOn] = useState(true);
  const [editOn, setEditOn] = useState(false);
  const [tooltip, setTooltip] = useState<string | null>(null);
  const batteryCount = BATTERY_COUNTS[batteryCountIdx];
  const mockBatteries = MOCK_BATTERY_POOL.slice(0, batteryCount);
  const [sandboxRoot, setSandboxRoot] = useState<SplitNode>(() => ({
    id: "root",
    children: [
      makeNode("0"),
      {
        id: "1",
        children: [makeNode("1.0"), makeNode("1.1"), makeNode("1.2"), makeNode("1.3")],
      },
      makeNode("2"),
      makeNode("3"),
    ],
  }));

  const actions: ReadonlyArray<{
    id: string;
    icon: IconName;
    tip: string;
    active?: boolean;
    disabled?: boolean;
    onClick: () => void;
  }> = [
    {
      id: "layout",
      icon: "grid_view",
      tip: layoutOn ? "Hide windows" : "Show windows",
      active: layoutOn,
      onClick: () => setLayoutOn((v) => !v),
    },
    {
      id: "edit",
      icon: "tune",
      tip: layoutOn ? (editOn ? "Stop editing" : "Edit layout") : "Show windows first",
      active: editOn,
      disabled: !layoutOn,
      onClick: () => setEditOn((v) => !v),
    },
    {
      id: "settings",
      icon: "settings",
      tip: "Settings",
      onClick: () => setTooltip("Settings (mock)"),
    },
    {
      id: "recenter",
      icon: "open_with",
      tip: layoutOn ? "Recenter windows" : "Show windows first",
      disabled: !layoutOn,
      onClick: () => setTooltip("Recentered layout"),
    },
  ];

  const footerText = tooltip ?? (mediaPlaying ? "C418 · Aria Math" : "Recursive 4x4 Grid");

  return (
    <group position={[stageCenter[0], stageCenter[1] + 20, 10]} scale={[scale, scale, 1]}>
      {/* Left: Wrist Menu built 100% with recursive <Grid> & <Cell> */}
      <group position={[-250, 0, 0]}>
        <Grid
          cols={4}
          rows={4}
          width={SHELL_SIZE}
          height={SHELL_SIZE}
          gap={GAP}
          padding={GAP}
          radius={RADIUS.shell}
          pixelSize={1}
          showGuides={showGuides}
        >
          {/* Clock: 2x2 cell with centered clock pill */}
          <Cell col={0} row={0} colSpan={2} rowSpan={2} surface="tile">
            <ClockWallpaper />
            <Grid cols={1} rows={3} gap={INNER_GAP} padding={0} showGuides={showGuides}>
              <Cell col={0} row={1} surface="accent" shape="round">
                <Text color={COLOR.onAccent} fontSize={52}>19:52</Text>
              </Cell>
            </Grid>
          </Cell>

          {/* Media / Displays: 2x1 cell with nested 4x2 sub-grid */}
          <Cell col={2} row={0} colSpan={2} rowSpan={1} surface="tile">
            <Grid cols={4} rows={2} showGuides={showGuides}>
              <Cell col={0} row={0} colSpan={3} rowSpan={1} surface="outline" shape="round">
                <Text color={COLOR.ink} fontSize={14}>{mediaPlaying ? "MEDIA" : "DISPLAYS"}</Text>
              </Cell>
              {mediaPlaying
                ? (
                  <>
                    <Cell
                      col={0}
                      row={1}
                      surface="outline"
                      shape="round"
                      onHover={(h) => setTooltip(h ? "Previous track" : null)}
                      onClick={() => setTooltip("Previous track")}
                    >
                      <Icon name="skip_previous" size={22} color={COLOR.ink} />
                    </Cell>
                    <Cell
                      col={1}
                      row={1}
                      surface="outline"
                      shape="round"
                      active
                      onHover={(h) => setTooltip(h ? "Pause" : null)}
                      onClick={() => setMediaPlaying(false)}
                    >
                      <Icon name="pause" size={22} color={COLOR.onAccent} />
                    </Cell>
                    <Cell
                      col={2}
                      row={1}
                      surface="outline"
                      shape="round"
                      onHover={(h) => setTooltip(h ? "Next track" : null)}
                      onClick={() => setTooltip("Next track")}
                    >
                      <Icon name="skip_next" size={22} color={COLOR.ink} />
                    </Cell>
                  </>
                )
                : (
                  <Cell
                    col={0}
                    row={1}
                    surface="outline"
                    shape="round"
                    onClick={() => setMediaPlaying(true)}
                  >
                    <Icon name="desktop_windows" size={16} color={COLOR.ink} />
                    <Text color={COLOR.ink} fontSize={11}>2</Text>
                  </Cell>
                )}
            </Grid>
          </Cell>

          {/* Battery: 2x1 cell with recursive gauge grid (adapts from 3 up to 9 devices) */}
          <Cell col={2} row={1} colSpan={2} rowSpan={1} surface="none">
            <BatteryWidget
              items={mockBatteries}
              showGuides={showGuides}
              onHoverTooltip={setTooltip}
            />
          </Cell>

          {/* Row 3: four 1x1 action cells */}
          {actions.map((act, idx) => (
            <Cell
              key={act.id}
              col={idx}
              row={2}
              surface="tile"
              active={act.active}
              disabled={act.disabled}
              onHover={(h) => setTooltip(h ? act.tip : null)}
              onClick={act.onClick}
            >
              <Icon
                name={act.icon}
                size={40}
                color={act.disabled ? COLOR.inkDim : act.active ? COLOR.onAccent : COLOR.ink}
              />
            </Cell>
          ))}

          {/* Row 4: full 4x1 inverted context strip — or omitted to show empty square grid space */}
          {footerMode === "expanded" && (
            <Cell
              col={0}
              row={3}
              colSpan={4}
              rowSpan={1}
              surface="inverted"
              flexDirection="row"
              justifyContent="flex-start"
              paddingX={GAP + INNER_GAP}
            >
              <Text color={COLOR.ground} fontSize={36}>{footerText}</Text>
            </Cell>
          )}
        </Grid>
      </group>

      {/* Right: Interactive Recursive Subdivision Sandbox (click any cell to split 2x2) */}
      <group position={[280, 0, 0]}>
        <Grid
          cols={2}
          rows={2}
          width={420}
          height={420}
          gap={GAP}
          padding={GAP}
          radius={RADIUS.shell}
          pixelSize={1}
          showGuides={showGuides}
        >
          {(sandboxRoot.children ?? []).map((child, idx) => (
            <RecursiveSandboxNode
              key={child.id}
              node={child}
              col={idx % 2}
              row={Math.floor(idx / 2)}
              depth={0}
              showGuides={showGuides}
              onSplit={(id) => setSandboxRoot((prev) => toggleSplit(prev, id, 0))}
            />
          ))}
        </Grid>
      </group>

      {/* Controls bar underneath */}
      <group position={[0, -SHELL_SIZE / 2 - 38, 10]}>
        <Container
          pixelSize={1}
          flexDirection="row"
          alignItems="center"
          gap={8}
          paddingX={12}
          paddingY={8}
          borderRadius={14}
          backgroundColor="#1a1d24"
          backgroundOpacity={0.95}
        >
          <Chip
            label={showGuides ? "Guides: On" : "Guides: Off"}
            active={showGuides}
            onClick={() => setShowGuides((v) => !v)}
          />
          <Chip
            label={footerMode === "expanded" ? "Row 4: Context 4x1" : "Row 4: Empty"}
            active={footerMode === "expanded"}
            onClick={() => setFooterMode((m) => m === "expanded" ? "empty" : "expanded")}
          />
          <Chip
            label={`Batteries: ${batteryCount}`}
            active={batteryCount > 3}
            onClick={() => setBatteryCountIdx((i) => (i + 1) % BATTERY_COUNTS.length)}
          />
          <Chip
            label={mediaPlaying ? "Media: Playing" : "Media: Idle"}
            active={mediaPlaying}
            onClick={() => setMediaPlaying((v) => !v)}
          />
          <Chip
            label="Reset Sandbox"
            onClick={() =>
              setSandboxRoot({
                id: "root",
                children: [makeNode("0"), makeNode("1"), makeNode("2"), makeNode("3")],
              })}
          />
          <Text fontSize={12} color="#8a93a2">Click right cells to subdivide</Text>
        </Container>
      </group>
    </group>
  );
}
