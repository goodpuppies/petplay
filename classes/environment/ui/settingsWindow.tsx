/**
 * First-class floating Settings Window, built on PetPlay's recursive `<Grid>` / `<Cell>` system.
 *
 * Opens as its own window (8 × 5 grid units = 1040 × 656 px) when the Settings button on the
 * wrist menu is pressed, rather than cramming settings into the 4×4 wrist watch face.
 *
 * Layout (8 × 5 root grid):
 *   - cols 0..1, rows 0..4 (2×5): Category sidebar
 *   - cols 2..7, row 0     (6×1): Active category header + Close button
 *   - cols 2..7, rows 1..4 (6×4): Category content cards (toggles, mode pickers, steppers, actions)
 */
import React, { useState } from "react";
import { Container } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Text } from "./text.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { Cell, Grid } from "./grid.tsx";
import { COLOR, GAP, INNER_GAP, RADIUS, UNIT, unitSpan } from "./tokens.ts";
import { setSetting, type SettingKey, useSetting, VRC_CAMERA_RESOLUTIONS } from "../../settings.ts";
import {
  baseEyeSize,
  MAX_EYE_SIZE,
  RENDER_SCALE_STEPS,
  scaledEyeSize,
  setRenderScale,
  useRenderResolution,
} from "../../renderResolution.ts";
import { describeBuild, getBuildInfo } from "../../buildInfo.ts";
import { installState } from "../../install.ts";
import { logsDir } from "../../appPaths.ts";
import { resetPlayspace } from "../../playspaceMover.ts";
import {
  addWorkspaceLayoutOutput,
  assignWorkspaceLayoutOutput,
  loadLayoutSlot,
  saveLayoutSlot,
  useWorkspaceLayoutSnapshot,
} from "../workspaceLayoutStore.ts";
import { useVrcCameraControls, useVrcCameraSnapshot } from "../vrcCameraStore.ts";
import { PostMan, System } from "../../../submodules/stageforge/mod.ts";
import { pushToast } from "../toastStore.ts";

export const SETTINGS_WINDOW_COLS = 8;
export const SETTINGS_WINDOW_ROWS = 5;
export const SETTINGS_WINDOW_WIDTH = unitSpan(SETTINGS_WINDOW_COLS) + GAP * 2;
export const SETTINGS_WINDOW_HEIGHT = unitSpan(SETTINGS_WINDOW_ROWS) + GAP * 2;

export type SettingsCategoryId =
  | "general"
  | "wrist"
  | "displays"
  | "layouts"
  | "keyboard"
  | "text"
  | "camera"
  | "install";

const CATEGORIES: ReadonlyArray<{
  id: SettingsCategoryId;
  label: string;
  subtitle: string;
  icon: IconName;
}> = [
  {
    id: "general",
    label: "General",
    subtitle: "Input, lasers, haptics, and notifications",
    icon: "tune",
  },
  {
    id: "wrist",
    label: "Wrist",
    subtitle: "Hand assignment, scale, and opacity",
    icon: "layers",
  },
  {
    id: "displays",
    label: "Displays",
    subtitle: "Monitor assignment and window chrome",
    icon: "desktop_windows",
  },
  {
    id: "layouts",
    label: "Layouts",
    subtitle: "Save and restore workspace arrangements",
    icon: "grid_view",
  },
  {
    id: "keyboard",
    label: "Keyboard",
    subtitle: "Locale legends and typing audio",
    icon: "keyboard",
  },
  {
    id: "text",
    label: "Text",
    subtitle: "Text renderer, glyph tuning, and filter",
    icon: "visibility",
  },
  {
    id: "camera",
    label: "Camera",
    subtitle: "VRC camera stream, calibration, and layer",
    icon: "videogame_asset",
  },
  {
    id: "install",
    label: "Install",
    subtitle: "PetPlay version, SteamVR registration, and logs",
    icon: "save",
  },
];

export type SettingsWindowProps = {
  initialCategory?: SettingsCategoryId;
  pixelSize?: number;
  showGuides?: boolean;
  onClose?: () => void;
};

/** One full-width setting row inside a 1×4 content grid: label/description on left, control on right. */
function SettingRow({
  row,
  title,
  description,
  children,
}: {
  row: number;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Cell
      col={0}
      row={row}
      colSpan={1}
      rowSpan={1}
      surface="tile"
      flexDirection="row"
      alignItems="center"
      justifyContent="space-between"
      paddingX={GAP + INNER_GAP}
    >
      <Container flexDirection="column" gap={4} alignItems="flex-start">
        <Text color={COLOR.ink} fontSize={22}>{title}</Text>
        <Text color={COLOR.inkDim} fontSize={14}>{description}</Text>
      </Container>
      <Container flexDirection="row" alignItems="center" gap={INNER_GAP}>
        {children}
      </Container>
    </Cell>
  );
}

function ToggleControl({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Container
      flexDirection="row"
      alignItems="center"
      gap={6}
      padding={5}
      borderRadius={999}
      backgroundColor={COLOR.ground}
      backgroundOpacity={1}
    >
      {([
        { label: "OFF", active: !value, next: false },
        { label: "ON", active: value, next: true },
      ] as const).map((opt) => (
        <Container
          key={opt.label}
          width={68}
          height={44}
          borderRadius={999}
          alignItems="center"
          justifyContent="center"
          backgroundColor={opt.active ? COLOR.accent : COLOR.tile}
          backgroundOpacity={opt.active ? 1 : 0}
          onClick={() => onChange(opt.next)}
        >
          <Text color={opt.active ? COLOR.onAccent : COLOR.inkDim} fontSize={16}>
            {opt.label}
          </Text>
        </Container>
      ))}
    </Container>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  itemWidth = 88,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
  itemWidth?: number;
}) {
  return (
    <Container
      flexDirection="row"
      alignItems="center"
      gap={6}
      padding={5}
      borderRadius={999}
      backgroundColor={COLOR.ground}
      backgroundOpacity={1}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <Container
            key={opt.value}
            width={itemWidth}
            height={44}
            borderRadius={999}
            alignItems="center"
            justifyContent="center"
            backgroundColor={COLOR.accent}
            backgroundOpacity={selected ? 1 : 0}
            onClick={() => onChange(opt.value)}
          >
            <Text color={selected ? COLOR.onAccent : COLOR.inkDim} fontSize={15}>
              {opt.label}
            </Text>
          </Container>
        );
      })}
    </Container>
  );
}

function StepperControl({
  label,
  fraction,
  onDecrement,
  onIncrement,
}: {
  label: string;
  /** 0..1 progress fill behind the readout. */
  fraction: number;
  onDecrement: () => void;
  onIncrement: () => void;
}) {
  const barW = 132;
  const barH = 48;
  const fillW = Math.round(barW * Math.max(0, Math.min(1, fraction)));
  return (
    <Container flexDirection="row" alignItems="center" gap={8}>
      <Container
        width={48}
        height={barH}
        borderRadius={24}
        alignItems="center"
        justifyContent="center"
        backgroundColor={COLOR.ground}
        backgroundOpacity={1}
        onClick={onDecrement}
      >
        <Text color={COLOR.ink} fontSize={24}>-</Text>
      </Container>
      <Container
        width={barW}
        height={barH}
        borderRadius={16}
        backgroundColor={COLOR.ground}
        backgroundOpacity={1}
        positionType="relative"
        alignItems="center"
        justifyContent="center"
      >
        {fillW > 0 && (
          <Container
            positionType="absolute"
            positionLeft={0}
            positionTop={0}
            width={fillW}
            height={barH}
            borderRadius={Math.min(16, fillW / 2, barH / 2)}
            backgroundColor="#4a4d5c"
            backgroundOpacity={1}
          />
        )}
        <Text color={COLOR.ink} fontSize={18}>{label}</Text>
      </Container>
      <Container
        width={48}
        height={barH}
        borderRadius={24}
        alignItems="center"
        justifyContent="center"
        backgroundColor={COLOR.ground}
        backgroundOpacity={1}
        onClick={onIncrement}
      >
        <Text color={COLOR.ink} fontSize={24}>+</Text>
      </Container>
    </Container>
  );
}

function ActionButton({
  label,
  tone = "outline",
  disabled = false,
  onClick,
}: {
  label: string;
  tone?: "outline" | "accent" | "danger";
  disabled?: boolean;
  onClick: () => void;
}) {
  const bg = disabled
    ? COLOR.ground
    : tone === "accent"
    ? COLOR.accent
    : tone === "danger"
    ? COLOR.danger
    : COLOR.ground;
  const ink = disabled ? COLOR.inkDim : tone === "accent" ? COLOR.onAccent : COLOR.ink;
  return (
    <Container
      paddingX={20}
      height={48}
      borderRadius={24}
      alignItems="center"
      justifyContent="center"
      backgroundColor={bg}
      backgroundOpacity={disabled ? 0.55 : 1}
      onClick={disabled ? undefined : onClick}
    >
      <Text color={ink} fontSize={16}>{label}</Text>
    </Container>
  );
}

function BooleanSettingRow({
  row,
  title,
  description,
  setting,
}: {
  row: number;
  title: string;
  description: string;
  setting: {
    [K in SettingKey]: boolean extends ReturnType<typeof useSetting<K>> ? K : never;
  }[SettingKey];
}) {
  const value = useSetting(setting) as boolean;
  return (
    <SettingRow row={row} title={title} description={description}>
      <ToggleControl
        value={value}
        onChange={(next) => setSetting(setting, next as never)}
      />
    </SettingRow>
  );
}

function PeerNetworkingRow({ row }: { row: number }) {
  const value = useSetting("stageforgeNetworking");
  return (
    <SettingRow
      row={row}
      title="Peer Networking"
      description="Connect via iroh + topic server for VRChat sharing"
    >
      <ToggleControl
        value={value}
        onChange={(next) => {
          setSetting("stageforgeNetworking", next);
          try {
            PostMan.PostMessage({
              target: System,
              type: "SETNETWORKING",
              payload: { enabled: next },
            });
          } catch {
            // Standalone UI preview runs outside a Stageforge actor worker.
          }
          pushToast({
            source: "Settings",
            title: next ? "Peer networking enabled" : "Peer networking disabled",
          });
        }}
      />
    </SettingRow>
  );
}

function GrabThresholdRow({ row }: { row: number }) {
  const threshold = useSetting("grabThreshold");
  const clamp = (v: number) => Math.round(Math.min(0.95, Math.max(0.05, v)) * 100) / 100;
  return (
    <SettingRow
      row={row}
      title="Grab Threshold"
      description="Index grip squeeze force required to grab (5% to 95%)"
    >
      <StepperControl
        label={`${Math.round(threshold * 100)}%`}
        fraction={(threshold - 0.05) / 0.9}
        onDecrement={() => setSetting("grabThreshold", clamp(threshold - 0.05))}
        onIncrement={() => setSetting("grabThreshold", clamp(threshold + 0.05))}
      />
    </SettingRow>
  );
}

function OverlayModeRow({ row }: { row: number }) {
  const mode = useSetting("overlayPresentMode");
  return (
    <SettingRow
      row={row}
      title="Overlay Mode"
      description="Panorama (default, native displays) or Projection (lower VRAM, head reprojection)"
    >
      <SegmentedControl
        value={mode}
        onChange={(next) => setSetting("overlayPresentMode", next as "panorama" | "projection")}
        options={[
          { value: "panorama", label: "PANO" },
          { value: "projection", label: "PROJ" },
        ]}
        itemWidth={92}
      />
    </SettingRow>
  );
}

function RenderResolutionRow({ row }: { row: number }) {
  const { key, scale, eye } = useRenderResolution();
  const base = baseEyeSize();
  const currentIdx = Math.max(
    0,
    RENDER_SCALE_STEPS.findIndex((step) => Math.abs(step - scale) < 1e-3),
  );
  const maxStepIdx = base == null
    ? RENDER_SCALE_STEPS.length - 1
    : Math.max(
      0,
      RENDER_SCALE_STEPS.reduce(
        (last, step, i) => (i === 0 || scaledEyeSize(base, step) > scaledEyeSize(base, RENDER_SCALE_STEPS[last]!) ? i : last),
        0,
      ),
    );
  const clampedIdx = Math.min(currentIdx, maxStepIdx);
  const description = key != null && eye != null
    ? `SteamVR ${key} → ${eye}×${eye} per eye (max ${MAX_EYE_SIZE})`
    : "Scale PetPlay eye target relative to SteamVR resolution (waiting for headset)";
  return (
    <SettingRow
      row={row}
      title="Overlay Resolution"
      description={description}
    >
      <StepperControl
        label={`${Math.round(scale * 100)}%`}
        fraction={maxStepIdx > 0 ? clampedIdx / maxStepIdx : 0}
        onDecrement={() => {
          if (key == null) return;
          const next = RENDER_SCALE_STEPS[Math.max(0, clampedIdx - 1)]!;
          setRenderScale(next);
        }}
        onIncrement={() => {
          if (key == null) return;
          const next = RENDER_SCALE_STEPS[Math.min(maxStepIdx, clampedIdx + 1)]!;
          setRenderScale(next);
        }}
      />
    </SettingRow>
  );
}

function GeneralPage({ showGuides }: { showGuides: boolean }) {
  return (
    <Grid cols={1} rows={8} gap={GAP} padding={0} showGuides={showGuides}>
      <OverlayModeRow row={0} />
      <RenderResolutionRow row={1} />
      <BooleanSettingRow
        row={2}
        title="Controller Lasers"
        description="Draw aiming beams from both controllers"
        setting="controllerLaser"
      />
      <BooleanSettingRow
        row={3}
        title="Haptic Feedback"
        description="Subtle vibration on hover and click"
        setting="haptics"
      />
      <BooleanSettingRow
        row={4}
        title="Desktop Notifications"
        description="Forward Linux desktop alerts as VR toasts"
        setting="desktopNotifications"
      />
      <BooleanSettingRow
        row={5}
        title="Grab-Box Outlines"
        description="Show wireframe frames around spatial windows"
        setting="grabboxOutline"
      />
      <GrabThresholdRow row={6} />
      <PeerNetworkingRow row={7} />
    </Grid>
  );
}

function WristPage({ showGuides }: { showGuides: boolean }) {
  const hand = useSetting("wristMenuHand");
  const scale = useSetting("wristMenuScale");
  const opacity = useSetting("wristMenuOpacity");
  const toolbarScale = useSetting("contextToolbarScale");
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, v)) * 100) / 100;

  return (
    <Grid cols={1} rows={4} gap={GAP} padding={0} showGuides={showGuides}>
      <SettingRow row={0} title="Wrist Hand" description="Which controller wears the wrist menu">
        <SegmentedControl
          value={hand}
          onChange={(next) => setSetting("wristMenuHand", next)}
          options={[
            { value: "left", label: "LEFT" },
            { value: "right", label: "RIGHT" },
          ]}
        />
      </SettingRow>
      <SettingRow row={1} title="Wrist Scale" description="Size of the watch face (50% to 200%)">
        <StepperControl
          label={`${Math.round(scale * 100)}%`}
          fraction={(scale - 0.5) / 1.5}
          onDecrement={() => setSetting("wristMenuScale", clamp(scale - 0.1, 0.5, 2))}
          onIncrement={() => setSetting("wristMenuScale", clamp(scale + 0.1, 0.5, 2))}
        />
      </SettingRow>
      <SettingRow row={2} title="Wrist Opacity" description="Transparency of the wrist panel">
        <StepperControl
          label={`${Math.round(opacity * 100)}%`}
          fraction={(opacity - 0.2) / 0.8}
          onDecrement={() => setSetting("wristMenuOpacity", clamp(opacity - 0.1, 0.2, 1))}
          onIncrement={() => setSetting("wristMenuOpacity", clamp(opacity + 0.1, 0.2, 1))}
        />
      </SettingRow>
      <SettingRow row={3} title="Context Toolbar Scale" description="Size of window action bars">
        <StepperControl
          label={`${Math.round(toolbarScale * 100)}%`}
          fraction={(toolbarScale - 0.5) / 1.5}
          onDecrement={() => setSetting("contextToolbarScale", clamp(toolbarScale - 0.1, 0.5, 2))}
          onIncrement={() => setSetting("contextToolbarScale", clamp(toolbarScale + 0.1, 0.5, 2))}
        />
      </SettingRow>
    </Grid>
  );
}

function DisplaysPage({ showGuides }: { showGuides: boolean }) {
  const workspace = useWorkspaceLayoutSnapshot();
  const [mockD1, setMockD1] = useState("DP-1");
  const [mockD2, setMockD2] = useState("DP-2");
  const hasReal = workspace.displays.length > 0 && workspace.outputs.length > 0;
  const outputs = hasReal
    ? workspace.outputs.map((o) => ({ value: o.id, label: o.name }))
    : [
      { value: "DP-1", label: "DP-1" },
      { value: "DP-2", label: "DP-2" },
      { value: "HDMI-1", label: "HDMI-1" },
    ];
  const d1 = hasReal ? workspace.displays[0] : null;
  const d2 = hasReal ? workspace.displays[1] : null;
  const unassigned = hasReal
    ? workspace.outputs.find((o) => o.assignedDisplayId == null)
    : null;

  return (
    <Grid cols={1} rows={4} gap={GAP} padding={0} showGuides={showGuides}>
      <SettingRow
        row={0}
        title={d1 ? `Display ${d1.ordinal}${d1.root ? " (Root)" : ""}` : "Display 1 (Root)"}
        description={d1?.outputName ?? "Primary workspace monitor"}
      >
        <SegmentedControl
          value={d1?.outputId ?? mockD1}
          onChange={(next) => {
            if (d1) assignWorkspaceLayoutOutput(d1.id, next);
            else setMockD1(next);
          }}
          options={outputs.slice(0, 3)}
          itemWidth={82}
        />
      </SettingRow>
      <SettingRow
        row={1}
        title={d2 ? `Display ${d2.ordinal}` : "Display 2"}
        description={d2?.outputName ?? "Secondary workspace monitor"}
      >
        <SegmentedControl
          value={d2?.outputId ?? mockD2}
          onChange={(next) => {
            if (d2) assignWorkspaceLayoutOutput(d2.id, next);
            else setMockD2(next);
          }}
          options={outputs.slice(0, 3)}
          itemWidth={82}
        />
      </SettingRow>
      <BooleanSettingRow
        row={2}
        title="Grab-Box Outlines"
        description="Highlight draggable window hulls"
        setting="grabboxOutline"
      />
      <SettingRow
        row={3}
        title="Workspace Displays"
        description={unassigned ? `Unassigned: ${unassigned.name}` : "Add another virtual monitor"}
      >
        <ActionButton
          label={unassigned ? `+ ADD ${unassigned.name}` : "+ ADD DISPLAY"}
          tone="accent"
          onClick={() => {
            if (unassigned) addWorkspaceLayoutOutput(unassigned.id);
          }}
        />
      </SettingRow>
    </Grid>
  );
}

function LayoutsPage({ showGuides }: { showGuides: boolean }) {
  const workspace = useWorkspaceLayoutSnapshot();
  const realSlots = workspace.layoutSlots;
  const [activeSlot, setActiveSlot] = useState(1);
  const [mockSlots, setMockSlots] = useState<Record<number, string>>({
    1: "2 displays · saved 18m ago",
    2: "3 displays · saved yesterday",
    3: "Empty slot",
  });
  return (
    <Grid cols={1} rows={4} gap={GAP} padding={0} showGuides={showGuides}>
      {[1, 2, 3].map((slot) => {
        const realSummary = realSlots?.[slot - 1] ?? null;
        const desc = realSlots
          ? (realSummary
            ? `${realSummary.displays} display${realSummary.displays === 1 ? "" : "s"}`
            : "Empty slot")
          : mockSlots[slot];
        return (
          <SettingRow
            key={slot}
            row={slot - 1}
            title={`Layout Slot ${slot}`}
            description={desc}
          >
            <ActionButton
              label="SAVE"
              tone="outline"
              onClick={() => {
                saveLayoutSlot(slot);
                setMockSlots((prev) => ({ ...prev, [slot]: "Saved just now" }));
              }}
            />
            <ActionButton
              label={activeSlot === slot ? "LOADED" : "LOAD"}
              tone={activeSlot === slot ? "accent" : "outline"}
              onClick={() => {
                loadLayoutSlot(slot);
                setActiveSlot(slot);
              }}
            />
          </SettingRow>
        );
      })}
      <SettingRow row={3} title="Playspace Origin" description="Reset playspace mover offset to zero">
        <ActionButton
          label="RESET PLAYSPACE"
          tone="danger"
          onClick={() => resetPlayspace()}
        />
      </SettingRow>
    </Grid>
  );
}

function KeyboardPage({ showGuides }: { showGuides: boolean }) {
  const locale = useSetting("keyboardLocale") ?? "auto";
  const [mode, setMode] = useState<"compact" | "arrows" | "full">("arrows");
  return (
    <Grid cols={1} rows={4} gap={GAP} padding={0} showGuides={showGuides}>
      <SettingRow row={0} title="Keyboard Locale" description="Keycap legend layout">
        <SegmentedControl
          value={locale}
          onChange={(next) => setSetting("keyboardLocale", next === "auto" ? null : next)}
          options={[
            { value: "auto", label: "AUTO" },
            { value: "us", label: "US" },
            { value: "fi", label: "FI" },
          ]}
          itemWidth={78}
        />
      </SettingRow>
      <SettingRow row={1} title="Layout Mode" description="Columns shown on the virtual keyboard">
        <SegmentedControl
          value={mode}
          onChange={setMode}
          options={[
            { value: "compact", label: "COMPACT" },
            { value: "arrows", label: "ARROWS" },
            { value: "full", label: "FULL" },
          ]}
          itemWidth={92}
        />
      </SettingRow>
      <BooleanSettingRow
        row={2}
        title="Typing Sounds"
        description="Spatial click sounds played at each key"
        setting="typingSounds"
      />
      <BooleanSettingRow
        row={3}
        title="Key Haptics"
        description="Controller pulse when pressing keys"
        setting="haptics"
      />
    </Grid>
  );
}

function TextPage({ showGuides }: { showGuides: boolean }) {
  const textRenderer = useSetting("textRenderer") ?? "msdf";
  const filter = useSetting("panoramaFilter") ?? "catmull-rom";
  const aaWidth = useSetting("glyphAaWidth");
  const glyphWeight = useSetting("glyphWeightPixels");
  const clamp = (v: number, lo: number, hi: number) =>
    Math.round(Math.min(hi, Math.max(lo, v)) * 100) / 100;

  return (
    <Grid cols={1} rows={4} gap={GAP} padding={0} showGuides={showGuides}>
      <SettingRow row={0} title="Text Renderer" description="Glyph rasterization backend">
        <SegmentedControl
          value={textRenderer}
          onChange={(next) =>
            setSetting("textRenderer", next as "msdf" | "pathfinder" | "glyph" | "windfoil")}
          options={[
            { value: "msdf", label: "MSDF" },
            { value: "pathfinder", label: "PATH" },
            { value: "glyph", label: "GLYPH" },
            { value: "windfoil", label: "WIND" },
          ]}
          itemWidth={76}
        />
      </SettingRow>
      <SettingRow row={1} title="Panorama Filter" description="Varggles eye reconstruction filter">
        <SegmentedControl
          value={filter}
          onChange={(next) => setSetting("panoramaFilter", next as "linear" | "catmull-rom")}
          options={[
            { value: "linear", label: "LINEAR" },
            { value: "catmull-rom", label: "CATMULL" },
          ]}
          itemWidth={102}
        />
      </SettingRow>
      <SettingRow row={2} title="Glyph AA Width" description="Antialiasing footprint (smaller = sharper)">
        <StepperControl
          label={aaWidth.toFixed(2)}
          fraction={(aaWidth - 0.5) / 0.5}
          onDecrement={() => setSetting("glyphAaWidth", clamp(aaWidth - 0.05, 0.5, 1))}
          onIncrement={() => setSetting("glyphAaWidth", clamp(aaWidth + 0.05, 0.5, 1))}
        />
      </SettingRow>
      <SettingRow row={3} title="Glyph Weight" description="Coverage dilation in eye pixels">
        <StepperControl
          label={`${glyphWeight.toFixed(2)}px`}
          fraction={glyphWeight / 0.25}
          onDecrement={() => setSetting("glyphWeightPixels", clamp(glyphWeight - 0.02, 0, 0.25))}
          onIncrement={() => setSetting("glyphWeightPixels", clamp(glyphWeight + 0.02, 0, 0.25))}
        />
      </SettingRow>
    </Grid>
  );
}

function CameraPage({ showGuides }: { showGuides: boolean }) {
  const snapshot = useVrcCameraSnapshot();
  const controls = useVrcCameraControls();
  const resolution = useSetting("vrcCameraResolution");
  const [mockCalibrating, setMockCalibrating] = useState(false);
  const [mockLayerOn, setMockLayerOn] = useState(false);
  const calibrating = snapshot ? snapshot.tracker.live : mockCalibrating;
  const layerOn = snapshot ? snapshot.layer.running : mockLayerOn;

  return (
    <Grid cols={1} rows={4} gap={GAP} padding={0} showGuides={showGuides}>
      <SettingRow row={0} title="VRC Camera Resolution" description="Match VRChat stream size">
        <SegmentedControl
          value={resolution}
          onChange={(next) => setSetting("vrcCameraResolution", next)}
          options={VRC_CAMERA_RESOLUTIONS.map((r) => ({
            value: r,
            label: r.split("x")[1] + "p",
          }))}
          itemWidth={82}
        />
      </SettingRow>
      <SettingRow row={1} title="Camera Calibration" description="Hold the camera while calibrating">
        <ActionButton
          label={calibrating ? "STOP CALIBRATE" : "CALIBRATE"}
          tone={calibrating ? "accent" : "outline"}
          onClick={() => {
            if (controls) controls.setLive(!calibrating);
            else setMockCalibrating((v) => !v);
          }}
        />
      </SettingRow>
      <SettingRow row={2} title="Recording Layer" description="OBS capture layer above VRChat">
        <ToggleControl
          value={layerOn}
          onChange={(next) => {
            if (controls) void controls.setLayer(next).catch(() => {});
            else setMockLayerOn(next);
          }}
        />
      </SettingRow>
      <SettingRow row={3} title="OSC Tracker" description="VRChat camera → Stream with OSC enabled">
        <Text color={COLOR.inkDim} fontSize={16}>
          {calibrating ? "Sampling…" : layerOn ? "Layer active" : "Idle"}
        </Text>
      </SettingRow>
    </Grid>
  );
}

function InstallPage({ showGuides }: { showGuides: boolean }) {
  const [, refresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const real = installState();
  const build = getBuildInfo();

  const defaultStatus = !real.canInstall
    ? "Source checkout · deno task steamvr:register"
    : !real.installed
    ? "Not installed in SteamVR"
    : real.runningInstalled || real.upToDate
    ? "Installed: starts with SteamVR"
    : `${real.installedBuild?.version ?? "Another version"} installed; this is ${real.thisBuild.version}`;

  const run = async (which: "install" | "uninstall") => {
    if (busy || !real.canInstall) return;
    setBusy(true);
    setMessage(which === "install" ? "Installing…" : "Uninstalling…");
    try {
      const output = await new Deno.Command(Deno.execPath(), {
        args: [`--${which}`],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim();
      const text = output.success ? decode(output.stdout) : decode(output.stderr);
      const summary = text.split(/\r?\n/).filter(Boolean).at(-1) ??
        (output.success ? "Done." : "Failed.");
      setMessage(summary);
      pushToast({
        source: "Install",
        title: summary,
        tone: output.success ? "info" : "warning",
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage(text);
      pushToast({ source: "Install", title: text, tone: "warning" });
    } finally {
      setBusy(false);
      refresh((n) => n + 1);
    }
  };

  const showInstallBtn = !real.installed || (!real.runningInstalled && !real.upToDate);

  return (
    <Grid cols={1} rows={4} gap={GAP} padding={0} showGuides={showGuides}>
      <SettingRow row={0} title="Version" description={describeBuild()}>
        <Text color={COLOR.accent} fontSize={22}>{build.version}</Text>
      </SettingRow>
      <SettingRow row={1} title="SteamVR Registration" description={message ?? defaultStatus}>
        {showInstallBtn && (
          <ActionButton
            label={busy ? "WORKING…" : real.installed ? "UPDATE" : "INSTALL"}
            tone="accent"
            disabled={busy || !real.canInstall}
            onClick={() => void run("install")}
          />
        )}
        {real.installed && (
          <ActionButton
            label={busy ? "WORKING…" : "UNINSTALL"}
            tone="danger"
            disabled={busy || !real.canInstall}
            onClick={() => void run("uninstall")}
          />
        )}
      </SettingRow>
      <SettingRow
        row={2}
        title="Start with SteamVR"
        description={real.installed ? real.installedPath : "Registers PetPlay as a SteamVR startup overlay"}
      >
        <ToggleControl
          value={real.installed}
          onChange={(next) => {
            if (busy || !real.canInstall) return;
            if (next && !real.installed) void run("install");
            else if (!next && real.installed) void run("uninstall");
          }}
        />
      </SettingRow>
      <SettingRow row={3} title="Logs Directory" description={logsDir()}>
        <Text color={COLOR.inkDim} fontSize={15}>
          {real.canInstall ? (real.runningInstalled ? "Installed" : "Portable") : "Dev checkout"}
        </Text>
      </SettingRow>
    </Grid>
  );
}

export function SettingsWindow({
  initialCategory = "general",
  pixelSize = 1,
  showGuides = false,
  onClose,
}: SettingsWindowProps) {
  const [category, setCategory] = useState<SettingsCategoryId>(initialCategory);
  const activeMeta = CATEGORIES.find((c) => c.id === category) ?? CATEGORIES[0];

  return (
    <Grid
      cols={SETTINGS_WINDOW_COLS}
      rows={SETTINGS_WINDOW_ROWS}
      width={SETTINGS_WINDOW_WIDTH}
      height={SETTINGS_WINDOW_HEIGHT}
      gap={GAP}
      padding={GAP}
      radius={RADIUS.shell}
      pixelSize={pixelSize}
      pointerEventsOrder={20}
      showGuides={showGuides}
    >
      {/* Left sidebar: 2 × 5 category list */}
      <Cell col={0} row={0} colSpan={2} rowSpan={5} surface="tile">
        <Grid cols={1} rows={CATEGORIES.length} gap={INNER_GAP} padding={INNER_GAP} showGuides={showGuides}>
          {CATEGORIES.map((cat, idx) => {
            const active = cat.id === category;
            const ink = active ? COLOR.onAccent : COLOR.ink;
            return (
              <Cell
                key={cat.id}
                col={0}
                row={idx}
                surface={active ? "accent" : "none"}
                flexDirection="row"
                alignItems="center"
                justifyContent="flex-start"
                paddingX={16}
                gap={12}
                onClick={() => setCategory(cat.id)}
              >
                <Icon name={cat.icon} size={24} color={ink} />
                <Text color={ink} fontSize={20}>{cat.label}</Text>
              </Cell>
            );
          })}
        </Grid>
      </Cell>

      {/* Top header: 6 × 1 (title + close button) */}
      <Cell col={2} row={0} colSpan={5} rowSpan={1} surface="inverted" flexDirection="column" alignItems="flex-start" justifyContent="center" paddingX={GAP + INNER_GAP} gap={2}>
        <Text color={COLOR.ground} fontSize={34}>{activeMeta.label}</Text>
        <Text color="#4a4d5c" fontSize={15}>{activeMeta.subtitle}</Text>
      </Cell>
      <Cell
        col={7}
        row={0}
        colSpan={1}
        rowSpan={1}
        surface="tile"
        onClick={onClose}
      >
        <Icon name="close" size={40} color={COLOR.ink} />
      </Cell>

      {/* Main content area: 6 × 4 */}
      <Cell col={2} row={1} colSpan={6} rowSpan={4} surface="none">
        {category === "general" && <GeneralPage showGuides={showGuides} />}
        {category === "wrist" && <WristPage showGuides={showGuides} />}
        {category === "displays" && <DisplaysPage showGuides={showGuides} />}
        {category === "layouts" && <LayoutsPage showGuides={showGuides} />}
        {category === "keyboard" && <KeyboardPage showGuides={showGuides} />}
        {category === "text" && <TextPage showGuides={showGuides} />}
        {category === "camera" && <CameraPage showGuides={showGuides} />}
        {category === "install" && <InstallPage showGuides={showGuides} />}
      </Cell>
    </Grid>
  );
}
