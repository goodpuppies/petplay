import React, { useMemo, useState } from "react";
import { CameraSettingsView } from "./cameraView.tsx";
import { TextComparisonView } from "./textComparisonView.tsx";
import { AppView } from "./appView.tsx";
import { useVrcCameraSnapshot } from "../vrcCameraStore.ts";
import type { AllowedPointerEventsType } from "@pmndrs/pointer-events";
import { Button, Container } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Text } from "../ui/text.tsx";
import { Pill, Shell } from "../ui/primitives.tsx";
import { COLOR, INNER_GAP, OUTLINE_WIDTH, RADIUS } from "../ui/tokens.ts";
import { WristOverlay } from "../ui/wristOverlay.tsx";
import { useBatteryReadings } from "../batteryStore.ts";
import { sendMediaCommand, useNowPlaying } from "../mediaStore.ts";
import type { WristMenuButtonId } from "./types.ts";
import type { WorkspaceLayoutSnapshot } from "../workspaceLayoutStore.ts";
import type { LayoutSlotSummary } from "../spatialLayoutPersistence.ts";
import { setSetting, type SettingKey, useSetting } from "../../settings.ts";
import { resetPlayspace } from "../../playspaceMover.ts";
import {
  MAX_EYE_SIZE,
  RENDER_SCALE_STEPS,
  setRenderScale,
  useRenderResolution,
} from "../../renderResolution.ts";

export type { WristMenuButtonId } from "./types.ts";

export type WristMenuUiProps = {
  clock?: string;
  dateLabel?: string;
  elapsed?: string;
  statusLabel?: string;
  layoutActive?: boolean;
  editActive?: boolean;
  onToggle?: (id: WristMenuButtonId) => void;
  onRecenter?: () => void;
  workspaceLayout?: WorkspaceLayoutSnapshot;
  onAssignOutput?: (displayId: string, outputId: string) => void;
  onAddOutput?: (outputId: string) => void;
  onSaveLayout?: (slot: number) => void;
  onLoadLayout?: (slot: number) => void;
  /** Only the opposite controller’s pointer should hit the menu (set from `WristMenuPanel` in XR). */
  pointerEventsType?: AllowedPointerEventsType;
};

const DEFAULT_CLOCK = "12:00";
const DEFAULT_DATE_LABEL = "FRI 24 APR";
const DEFAULT_ELAPSED = "00:00:00";
const DEFAULT_STATUS_LABEL = "Native module active";

/**
 * Monitor assignment, drawn in the panel's own vocabulary rather than the ad-hoc
 * palette it used before. It is a list rather than a tile grid, so it takes the
 * shell but not the 4x4 layout — the grid governs the overlay's home screen, not
 * every view reachable from it.
 */
function MonitorAssignments({
  workspaceLayout,
  onAssignOutput,
  onAddOutput,
  onBack,
}: {
  workspaceLayout: WorkspaceLayoutSnapshot;
  onAssignOutput?: (displayId: string, outputId: string) => void;
  onAddOutput?: (outputId: string) => void;
  onBack: () => void;
}) {
  const unassigned = workspaceLayout.outputs.filter((output) => output.assignedDisplayId == null);
  return (
    <Container flexDirection="column" gap={INNER_GAP} width={448}>
      <Container flexDirection="row" alignItems="center" gap={INNER_GAP}>
        <Button paddingX={0} paddingY={0} backgroundOpacity={0} onClick={onBack}>
          <Pill slots={1} units={2} fontSize={14}>BACK</Pill>
        </Button>
        <Pill slots={3} units={2} tone="accent" fontSize={14}>MONITORS</Pill>
      </Container>

      {workspaceLayout.displays.map((display) => (
        <Container
          key={display.id}
          flexDirection="column"
          gap={INNER_GAP}
          padding={INNER_GAP}
          borderRadius={RADIUS.tile}
          backgroundColor={COLOR.tile}
          backgroundOpacity={1}
        >
          <Text color={COLOR.ink} fontSize={14}>
            Display {display.ordinal}
            {display.root ? " (root)" : ""}
          </Text>
          <Container flexDirection="row" gap={INNER_GAP} flexWrap="wrap">
            {workspaceLayout.outputs.map((output) => {
              const selected = display.outputId === output.id;
              return (
                <Container
                  key={output.id}
                  paddingX={12}
                  paddingY={8}
                  borderRadius={16}
                  backgroundColor={COLOR.accent}
                  backgroundOpacity={selected ? 1 : 0}
                  borderWidth={selected ? 0 : OUTLINE_WIDTH}
                  borderColor={COLOR.outline}
                  onClick={() => onAssignOutput?.(display.id, output.id)}
                >
                  <Text color={selected ? COLOR.onAccent : COLOR.ink} fontSize={13}>
                    {output.name}
                  </Text>
                </Container>
              );
            })}
          </Container>
        </Container>
      ))}

      {workspaceLayout.outputs.length === 0 && (
        <Text color={COLOR.inkDim} fontSize={14}>No workspace outputs found.</Text>
      )}
      {unassigned.length > 0 && (
        <Container flexDirection="column" gap={INNER_GAP}>
          <Text color={COLOR.inkDim} fontSize={13}>Unassigned outputs</Text>
          <Container flexDirection="row" gap={INNER_GAP} flexWrap="wrap">
            {unassigned.map((output) => (
              <Container
                key={output.id}
                paddingX={12}
                paddingY={8}
                borderRadius={16}
                backgroundOpacity={0}
                borderWidth={OUTLINE_WIDTH}
                borderColor={COLOR.outline}
                onClick={() => onAddOutput?.(output.id)}
              >
                <Text color={COLOR.ink} fontSize={13}>Add {output.name}</Text>
              </Container>
            ))}
          </Container>
        </Container>
      )}
    </Container>
  );
}

/**
 * Saved layout slots: SAVE writes the current arrangement, LOAD brings it back. LOAD is disabled
 * on an empty slot rather than hidden, so the rows keep their places.
 */
/**
 * "3 displays · 08:14 PM", or the date ("3 displays · 09/10") when it wasn't saved today. Same
 * formats as the wrist clock and date.
 */
export function layoutSlotLabel(summary: LayoutSlotSummary, now = new Date()): string {
  const displays = `${summary.displays} display${summary.displays === 1 ? "" : "s"}`;
  if (summary.savedAt == null) return displays;
  const saved = new Date(summary.savedAt);
  const when = saved.toDateString() === now.toDateString()
    ? new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })
      .format(saved)
    : `${String(saved.getDate()).padStart(2, "0")}/${
      String(saved.getMonth() + 1).padStart(2, "0")
    }`;
  return `${displays} · ${when}`;
}

function LayoutSlotsView(
  { slots, onSave, onLoad, onBack }: {
    slots: (LayoutSlotSummary | null)[];
    onSave?: (slot: number) => void;
    onLoad?: (slot: number) => void;
    onBack: () => void;
  },
) {
  return (
    <Container flexDirection="column" gap={INNER_GAP} width={448}>
      <Container flexDirection="row" alignItems="center" gap={INNER_GAP}>
        <Button paddingX={0} paddingY={0} backgroundOpacity={0} onClick={onBack}>
          <Pill slots={1} units={2} fontSize={14}>BACK</Pill>
        </Button>
        <Pill slots={3} units={2} tone="accent" fontSize={14}>LAYOUTS</Pill>
      </Container>
      {[1, 2, 3].map((slot) => {
        const summary = slots[slot - 1] ?? null;
        const saved = summary != null;
        return (
          <Container
            key={slot}
            flexDirection="row"
            alignItems="center"
            justifyContent="space-between"
            padding={INNER_GAP}
            borderRadius={RADIUS.tile}
            backgroundColor={COLOR.tile}
            backgroundOpacity={1}
          >
            <Container flexDirection="column" gap={2}>
              <Text color={saved ? COLOR.ink : COLOR.inkDim} fontSize={14}>
                Layout {slot}
                {saved ? "" : " (empty)"}
              </Text>
              {summary != null && (
                <Text color={COLOR.inkDim} fontSize={12}>{layoutSlotLabel(summary)}</Text>
              )}
            </Container>
            <Container flexDirection="row" gap={INNER_GAP}>
              <Pill slots={1} units={2} fontSize={13} onClick={() => onSave?.(slot)}>SAVE</Pill>
              <Pill
                slots={1}
                units={2}
                fontSize={13}
                disabled={!saved}
                onClick={() => onLoad?.(slot)}
              >
                LOAD
              </Pill>
            </Container>
          </Container>
        );
      })}
    </Container>
  );
}

/** A persisted boolean setting as a full-width row: label on the left, ON/OFF pill on the right. */
function SettingToggleRow(
  { label, setting }: {
    label: string;
    setting: Extract<
      SettingKey,
      "grabboxOutline" | "controllerLaser" | "haptics" | "desktopNotifications"
    >;
  },
) {
  const value = useSetting(setting);
  return (
    <Container
      flexDirection="row"
      alignItems="center"
      justifyContent="space-between"
      padding={INNER_GAP}
      borderRadius={RADIUS.tile}
      backgroundColor={COLOR.tile}
      backgroundOpacity={1}
    >
      <Text color={COLOR.ink} fontSize={14}>{label}</Text>
      <Pill
        slots={1}
        units={2}
        tone={value ? "accent" : "outline"}
        fontSize={13}
        onClick={() => setSetting(setting, !value)}
      >
        {value ? "ON" : "OFF"}
      </Pill>
    </Container>
  );
}

/** A settings row: label on the left, one pill on the right. */
function PillRow(
  { label, value, dim = false, disabled = false, onClick }: {
    label: string;
    value: string;
    dim?: boolean;
    disabled?: boolean;
    onClick?: () => void;
  },
) {
  return (
    <Container
      flexDirection="row"
      alignItems="center"
      justifyContent="space-between"
      padding={INNER_GAP}
      borderRadius={RADIUS.tile}
      backgroundColor={COLOR.tile}
      backgroundOpacity={1}
      onClick={disabled ? undefined : onClick}
    >
      <Text color={dim ? COLOR.inkDim : COLOR.ink} fontSize={14}>{label}</Text>
      <Pill
        slots={1}
        units={2}
        fontSize={13}
        disabled={disabled}
        onClick={disabled ? undefined : onClick}
      >
        {value}
      </Pill>
    </Container>
  );
}

/** Steps the wrist size and opacity pills cycle through. */
const WRIST_SCALE_STEPS = [0.75, 1, 1.25, 1.5];
const WRIST_OPACITY_STEPS = [1, 0.75, 0.5];

const nextStep = (steps: readonly number[], current: number) =>
  steps[(steps.indexOf(current) + 1) % steps.length];

const percent = (value: number) => `${Math.round(value * 100)}%`;

/**
 * The wrist menu's own page: which hand wears it, its size and opacity, and putting it back after
 * it was grabbed somewhere else with the other hand. Its own page so Settings stays inside the
 * square panel.
 */
function WristSettingsView({ onBack }: { onBack: () => void }) {
  const hand = useSetting("wristMenuHand");
  const scale = useSetting("wristMenuScale");
  const opacity = useSetting("wristMenuOpacity");
  const moved = useSetting("wristMenuOffset") != null;
  return (
    <Container flexDirection="column" gap={INNER_GAP} width={448}>
      <Container flexDirection="row" alignItems="center" gap={INNER_GAP}>
        <Button paddingX={0} paddingY={0} backgroundOpacity={0} onClick={onBack}>
          <Pill slots={1} units={2} fontSize={14}>BACK</Pill>
        </Button>
        <Pill slots={3} units={2} tone="accent" fontSize={14}>WRIST MENU</Pill>
      </Container>
      <PillRow
        label="Hand"
        value={hand === "right" ? "RIGHT" : "LEFT"}
        onClick={() => setSetting("wristMenuHand", hand === "right" ? "left" : "right")}
      />
      <PillRow
        label="Size"
        value={percent(scale)}
        onClick={() => setSetting("wristMenuScale", nextStep(WRIST_SCALE_STEPS, scale))}
      />
      <PillRow
        label="Opacity"
        value={percent(opacity)}
        onClick={() => setSetting("wristMenuOpacity", nextStep(WRIST_OPACITY_STEPS, opacity))}
      />
      <PillRow
        label={moved ? "Position: moved" : "Position: grab it to move"}
        value="RESET"
        dim={!moved}
        disabled={!moved}
        onClick={() => setSetting("wristMenuOffset", null)}
      />
    </Container>
  );
}

/**
 * Render resolution, relative to what SteamVR asks for, saved for that size: a headset that looks
 * soft at SteamVR's size (a Quest 3 over Steam Link) can be rendered sharper without changing
 * the others.
 */
function RenderSettingsView({ onBack }: { onBack: () => void }) {
  const { key, scale, eye } = useRenderResolution();
  const capped = eye === MAX_EYE_SIZE;
  return (
    <Container flexDirection="column" gap={INNER_GAP} width={448}>
      <Container flexDirection="row" alignItems="center" gap={INNER_GAP}>
        <Button paddingX={0} paddingY={0} backgroundOpacity={0} onClick={onBack}>
          <Pill slots={1} units={2} fontSize={14}>BACK</Pill>
        </Button>
        <Pill slots={3} units={2} tone="accent" fontSize={14}>RENDER</Pill>
      </Container>
      {/* One pill per step, the chosen one lit, like the text renderer's row. */}
      <Container flexDirection="row" alignItems="center" justifyContent="space-between">
        <Text fontSize={14} color={key == null ? COLOR.inkDim : COLOR.ink}>Resolution</Text>
        <Container flexDirection="row" gap={INNER_GAP}>
          {RENDER_SCALE_STEPS.map((step) => (
            <Pill
              key={step}
              slots={1}
              units={2}
              fontSize={12}
              disabled={key == null}
              tone={step === scale ? "accent" : "outline"}
              onClick={key == null ? undefined : () => setRenderScale(step)}
            >
              {percent(step)}
            </Pill>
          ))}
        </Container>
      </Container>
      <Text fontSize={12} color={COLOR.inkDim}>
        {key == null
          ? "No headset yet: SteamVR's size is not known."
          : `SteamVR asks ${key} per eye. Rendering ${eye}x${eye}${
            capped ? ` (the ${MAX_EYE_SIZE} limit)` : ""
          }. Saved for ${key} only.`}
      </Text>
    </Container>
  );
}

/** Settings reachable from the wrist; every row here is persisted by `classes/settings.ts`. */
function SettingsView(
  {
    onBack,
    onOpenWrist,
    onOpenMonitors,
    onOpenLayouts,
    onOpenCamera,
    onOpenText,
    onOpenRender,
    onOpenApp,
  }: {
    onBack: () => void;
    onOpenRender: () => void;
    onOpenApp: () => void;
    onOpenWrist: () => void;
    onOpenMonitors: () => void;
    onOpenLayouts: () => void;
    onOpenCamera: () => void;
    onOpenText: () => void;
  },
) {
  return (
    <Container flexDirection="column" gap={INNER_GAP} width={448}>
      <Container flexDirection="row" alignItems="center" gap={INNER_GAP}>
        <Button paddingX={0} paddingY={0} backgroundOpacity={0} onClick={onBack}>
          <Pill slots={1} units={2} fontSize={14}>BACK</Pill>
        </Button>
        <Pill slots={3} units={2} tone="accent" fontSize={14}>SETTINGS</Pill>
        <Container flexGrow={1} />
        {/* Undo space move (left stick click + drag): the playspace PetPlay attached in. */}
        <Pill slots={2} units={2} fontSize={11} onClick={resetPlayspace}>RESET SPACE</Pill>
        <Pill slots={1} units={2} fontSize={11} onClick={onOpenText}>TEXT</Pill>
      </Container>
      <SettingToggleRow label="Grab-box outlines" setting="grabboxOutline" />
      <SettingToggleRow label="Laser beams" setting="controllerLaser" />
      <SettingToggleRow label="Vibration" setting="haptics" />
      <SettingToggleRow label="Desktop notifications" setting="desktopNotifications" />
      {/* The sub-pages share one row, so the toggles above have room inside the square panel. */}
      <Container
        flexDirection="row"
        alignItems="center"
        justifyContent="space-between"
        padding={INNER_GAP}
        borderRadius={RADIUS.tile}
        backgroundColor={COLOR.tile}
        backgroundOpacity={1}
      >
        <Pill slots={1} units={2} fontSize={11} onClick={onOpenWrist}>WRIST</Pill>
        <Pill slots={1} units={2} fontSize={11} onClick={onOpenMonitors}>SCREENS</Pill>
        <Pill slots={1} units={2} fontSize={11} onClick={onOpenLayouts}>LAYOUTS</Pill>
        <Pill slots={1} units={2} fontSize={11} onClick={onOpenCamera}>CAMERA</Pill>
        <Pill slots={1} units={2} fontSize={11} onClick={onOpenRender}>RENDER</Pill>
        {/* Version, installing into SteamVR, logs. */}
        <Pill slots={1} units={2} fontSize={11} onClick={onOpenApp}>APP</Pill>
      </Container>
    </Container>
  );
}

export function WristMenuUi(
  {
    clock = DEFAULT_CLOCK,
    dateLabel = DEFAULT_DATE_LABEL,
    elapsed = DEFAULT_ELAPSED,
    statusLabel = DEFAULT_STATUS_LABEL,
    layoutActive = false,
    editActive = false,
    onToggle,
    onRecenter,
    workspaceLayout = { outputs: [], displays: [] },
    onAssignOutput,
    onAddOutput,
    onSaveLayout,
    onLoadLayout,
    pointerEventsType,
  }: WristMenuUiProps,
) {
  const pe: AllowedPointerEventsType = pointerEventsType ?? "all";
  const [view, setView] = useState<WristView>("main");
  // A page is built on its first visit and kept after that.
  const visited = React.useRef(new Set<WristView>()).current;
  visited.add(view);
  const batteries = useBatteryReadings();
  const nowPlaying = useNowPlaying();
  const camera = useVrcCameraSnapshot();
  const opacity = useSetting("wristMenuOpacity");
  const layoutSlots = workspaceLayout.layoutSlots ?? EMPTY_LAYOUT_SLOTS;

  // Built once per change of what they show, so the clock's once-a-second render does not
  // re-render the hidden pages. A hidden page also keeps the opacity and pointer type it was last
  // shown with: opacity is inherited by every UIKit component, so stepping it would otherwise
  // restyle all six pages at once. A page shown after a change restyles then, as before.
  const shownStyle = React.useRef(new Map<WristView, PageStyle>());
  const styleOf = (page: WristView): PageStyle => {
    const last = shownStyle.current.get(page);
    if (last !== undefined && (view !== page || (last.pe === pe && last.opacity === opacity))) {
      return last;
    }
    const style = { pe, opacity };
    shownStyle.current.set(page, style);
    return style;
  };
  const mainStyle = styleOf("main");
  const settingsStyle = styleOf("settings");
  const cameraStyle = styleOf("camera");
  const textStyle = styleOf("text");
  const renderStyle = styleOf("render");
  const appStyle = styleOf("app");
  const wristStyle = styleOf("wrist");
  const layoutsStyle = styleOf("layouts");
  const monitorsStyle = styleOf("monitors");
  const settings = useMemo(
    () => (
      <Shell pointerEventsType={settingsStyle.pe} opacity={settingsStyle.opacity}>
        <SettingsView
          onBack={() => setView("main")}
          onOpenWrist={() => setView("wrist")}
          onOpenMonitors={() => setView("monitors")}
          onOpenLayouts={() => setView("layouts")}
          onOpenCamera={() => setView("camera")}
          onOpenText={() => setView("text")}
          onOpenRender={() => setView("render")}
          onOpenApp={() => setView("app")}
        />
      </Shell>
    ),
    [settingsStyle],
  );
  const cameraPage = useMemo(
    () => (
      <Shell pointerEventsType={cameraStyle.pe} opacity={cameraStyle.opacity}>
        <CameraSettingsView onBack={() => setView("settings")} />
      </Shell>
    ),
    [cameraStyle],
  );
  const textPage = useMemo(
    () => (
      <Shell pointerEventsType={textStyle.pe} opacity={textStyle.opacity}>
        <TextComparisonView onBack={() => setView("settings")} />
      </Shell>
    ),
    [textStyle],
  );
  const renderPage = useMemo(
    () => (
      <Shell pointerEventsType={renderStyle.pe} opacity={renderStyle.opacity}>
        <RenderSettingsView onBack={() => setView("settings")} />
      </Shell>
    ),
    [renderStyle],
  );
  const appPage = useMemo(() => (
    <Shell pointerEventsType={appStyle.pe} opacity={appStyle.opacity}>
      <AppView onBack={() => setView("settings")} />
    </Shell>
  ), [appStyle]);
  const wrist = useMemo(() => (
    <Shell pointerEventsType={wristStyle.pe} opacity={wristStyle.opacity}>
      <WristSettingsView onBack={() => setView("settings")} />
    </Shell>
  ), [wristStyle]);
  const layouts = useMemo(
    () => (
      <Shell pointerEventsType={layoutsStyle.pe} opacity={layoutsStyle.opacity}>
        <LayoutSlotsView
          slots={layoutSlots}
          onSave={onSaveLayout}
          onLoad={onLoadLayout}
          onBack={() => setView("settings")}
        />
      </Shell>
    ),
    [layoutsStyle, layoutSlots, onSaveLayout, onLoadLayout],
  );
  const monitors = useMemo(
    () => (
      <Shell pointerEventsType={monitorsStyle.pe} opacity={monitorsStyle.opacity}>
        <MonitorAssignments
          workspaceLayout={workspaceLayout}
          onAssignOutput={onAssignOutput}
          onAddOutput={onAddOutput}
          onBack={() => setView("settings")}
        />
      </Shell>
    ),
    [monitorsStyle, workspaceLayout, onAssignOutput, onAddOutput],
  );

  const main = (
    <WristOverlay
      clock={clock}
      dateLabel={dateLabel}
      status={camera?.layer.running
        ? `Camera layer on · ${
          camera.tracker.calibration || camera.tracker.liveFit ? "synced" : "not synced"
        }`
        : statusLabel}
      displayCount={workspaceLayout.displays.length}
      batteries={batteries}
      nowPlaying={nowPlaying}
      onMedia={sendMediaCommand}
      opacity={mainStyle.opacity}
      active={{ layout: layoutActive, edit: editActive }}
      onToggle={onToggle}
      onOpenSettings={() => setView("settings")}
      onRecenter={onRecenter}
      pointerEventsType={mainStyle.pe}
    />
  );

  const page = (name: WristView, content: React.ReactNode) =>
    visited.has(name) && <WristPage key={name} visible={view === name}>{content}</WristPage>;
  return (
    <>
      {page("main", main)}
      {page("settings", settings)}
      {page("wrist", wrist)}
      {page("monitors", monitors)}
      {page("layouts", layouts)}
      {page("camera", cameraPage)}
      {page("text", textPage)}
      {page("render", renderPage)}
      {page("app", appPage)}
    </>
  );
}

type WristView =
  | "main"
  | "settings"
  | "wrist"
  | "monitors"
  | "layouts"
  | "camera"
  | "text"
  | "render"
  | "app";
type PageStyle = { pe: AllowedPointerEventsType; opacity: number };

const EMPTY_LAYOUT_SLOTS: LayoutSlotSummary[] = [];

/**
 * One wrist page, kept built while another is shown once it has been opened. Unmounting a page
 * and building the next one took 20-35 ms of UIKit construction and listener teardown per switch. A hidden Activity keeps
 * the tree and its objects but runs effect cleanups, so a hidden page has no frame jobs; pointer
 * events ignore `visible`, so the group also stops rays reaching it.
 */
function WristPage({ visible, children }: { visible: boolean; children: React.ReactNode }) {
  return (
    <group {...({ intersectChildren: visible } as Record<string, unknown>)}>
      <React.Activity mode={visible ? "visible" : "hidden"}>{children}</React.Activity>
    </group>
  );
}
