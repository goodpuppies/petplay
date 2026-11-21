/**
 * Interactive preview of PetPlay's live `WristMenuUi` (`classes/environment/wristMenu/ui.tsx`),
 * driven by local mock state so clicking toggles, monitors, layouts, media, and settings works
 * without OpenVR or touching the live PetPlay session.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Container } from "../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Text } from "../../classes/environment/ui/text.tsx";
import { SHELL_SIZE } from "../../classes/environment/ui/tokens.ts";
import type { BatteryDeviceItem } from "../../classes/environment/ui/batteryWidget.tsx";
import {
  SETTINGS_WINDOW_WIDTH,
  SettingsWindow,
} from "../../classes/environment/ui/settingsWindow.tsx";
import { WristMenuUi } from "../../classes/environment/wristMenu/ui.tsx";
import type { WristMenuButtonId } from "../../classes/environment/wristMenu/types.ts";
import type { WorkspaceLayoutSnapshot } from "../../classes/environment/workspaceLayoutStore.ts";
import { batteryStore } from "../../classes/environment/batteryStore.ts";
import { mediaStore, type NowPlaying } from "../../classes/environment/mediaStore.ts";
import type { PreviewSceneProps } from "./index.ts";

const MOCK_TRACKS: readonly NowPlaying[] = [
  { player: "spotify", playing: true, artist: "C418", title: "Aria Math" },
  { player: "spotify", playing: true, artist: "Home", title: "Resonance" },
  { player: "spotify", playing: false, artist: "Porter Robinson", title: "Shelter" },
];

const BATTERY_COUNTS = [1, 2, 3, 4, 6, 7, 8, 9] as const;

function makeMockBatteries(count: number, low: boolean): BatteryDeviceItem[] {
  const pool: BatteryDeviceItem[] = [
    {
      id: "hmd",
      label: "Headset",
      icon: "headset",
      reading: { percent: low ? 18 : 86, charging: false },
    },
    {
      id: "left",
      label: "Left controller",
      icon: "videogame_asset",
      reading: { percent: low ? 12 : 74, charging: false },
    },
    {
      id: "right",
      label: "Right controller",
      icon: "videogame_asset",
      reading: { percent: low ? 44 : 92, charging: true },
    },
    {
      id: "hip",
      label: "Hip tracker",
      icon: "battery_full",
      reading: { percent: low ? 15 : 68, charging: false },
    },
    {
      id: "lfoot",
      label: "Left foot",
      icon: "battery_full",
      reading: { percent: low ? 9 : 45, charging: false },
    },
    {
      id: "rfoot",
      label: "Right foot",
      icon: "battery_full",
      reading: { percent: 14, charging: false },
    },
    {
      id: "chest",
      label: "Chest tracker",
      icon: "battery_full",
      reading: { percent: low ? 22 : 81, charging: false },
    },
    {
      id: "lknee",
      label: "Left knee",
      icon: "battery_full",
      reading: { percent: low ? 11 : 55, charging: false },
    },
    {
      id: "rknee",
      label: "Right knee",
      icon: "battery_full",
      reading: { percent: 62, charging: true },
    },
  ];
  return pool.slice(0, count);
}

function formatClock(now: Date): { clock: string; dateLabel: string } {
  const clock = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(now).toUpperCase();
  const day = String(now.getDate()).padStart(2, "0");
  const month = new Intl.DateTimeFormat("en-US", { month: "short" }).format(now).toUpperCase();
  return { clock, dateLabel: `${weekday} ${day} ${month}` };
}

function makeMockWorkspace(displayCount: number): WorkspaceLayoutSnapshot {
  const outputs = [
    { id: "DP-1", name: "DP-1 · 2560x1440", assignedDisplayId: "disp-1" },
    {
      id: "DP-2",
      name: "DP-2 · 1920x1080",
      assignedDisplayId: displayCount >= 2 ? "disp-2" : null,
    },
    {
      id: "HDMI-1",
      name: "HDMI-1 · 1920x1080",
      assignedDisplayId: displayCount >= 3 ? "disp-3" : null,
    },
  ];
  const displays = Array.from({ length: displayCount }, (_, i) => ({
    id: `disp-${i + 1}`,
    ordinal: i + 1,
    root: i === 0,
    outputId: outputs[i]?.id ?? null,
    outputName: outputs[i]?.name ?? null,
  }));
  return {
    displays,
    outputs,
    layoutSlots: [
      { displays: 2, savedAt: Date.now() - 1000 * 60 * 18 },
      { displays: 3, savedAt: Date.now() - 1000 * 60 * 60 * 36 },
      null,
    ],
  };
}

function MockChip(
  { label, active, onClick }: { label: string; active?: boolean; onClick: () => void },
) {
  return (
    <Container
      paddingX={10}
      paddingY={5}
      borderRadius={999}
      backgroundColor={active ? "#ffc300" : "#26262b"}
      backgroundOpacity={1}
      onClick={onClick}
    >
      <Text fontSize={12} color={active ? "#000000" : "#d0d6e0"}>{label}</Text>
    </Container>
  );
}

export function WristMenuScene({ stageCenter, scale }: PreviewSceneProps) {
  const [layoutActive, setLayoutActive] = useState(true);
  const [editActive, setEditActive] = useState(false);
  const [musicOn, setMusicOn] = useState(true);
  const [trackIndex, setTrackIndex] = useState(0);
  const [lowBattery, setLowBattery] = useState(false);
  const [batteryCount, setBatteryCount] = useState<number>(3);
  const [displayCount, setDisplayCount] = useState(2);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statusNote, setStatusNote] = useState("Design preview · mocked state");
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    batteryStore.publish(
      lowBattery
        ? {
          hmd: { percent: 18, charging: false },
          left: { percent: 12, charging: false },
          right: { percent: 44, charging: true },
        }
        : {
          hmd: { percent: 86, charging: false },
          left: { percent: 74, charging: false },
          right: { percent: 92, charging: true },
        },
    );
  }, [lowBattery]);

  useEffect(() => {
    mediaStore.publish(musicOn ? MOCK_TRACKS[trackIndex] : null);
  }, [musicOn, trackIndex]);

  const workspaceLayout = useMemo(() => makeMockWorkspace(displayCount), [displayCount]);
  const batteryItems = useMemo(
    () => makeMockBatteries(batteryCount, lowBattery),
    [batteryCount, lowBattery],
  );
  const { clock, dateLabel } = formatClock(now);

  const handleToggle = (id: WristMenuButtonId) => {
    if (id === "layout") {
      setLayoutActive((v) => !v);
      setStatusNote(`Toggled layout`);
    } else if (id === "edit") {
      setEditActive((v) => !v);
      setStatusNote(`Toggled edit mode`);
    }
  };

  // When the Settings window is open, place the wrist menu on the left and the new Settings window beside it.
  const wristScale = settingsOpen ? scale * 0.62 : scale;
  const settingsScale = scale * 0.62;
  const wristX = settingsOpen ? stageCenter[0] - (SETTINGS_WINDOW_WIDTH * settingsScale) / 2 - 20 : stageCenter[0];
  const settingsX = stageCenter[0] + (SHELL_SIZE * wristScale) / 2 + 20;
  const panelHalfH = (SHELL_SIZE * scale) / 2;

  return (
    <>
      <group
        position={[wristX, stageCenter[1] + 22, 10]}
        scale={[wristScale * 1000, wristScale * 1000, 1]}
      >
        <WristMenuUi
          clock={clock}
          dateLabel={dateLabel}
          statusLabel={statusNote}
          layoutActive={layoutActive}
          editActive={editActive}
          onToggle={handleToggle}
          onRecenter={() => setStatusNote("Recentered layout (mock)")}
          workspaceLayout={workspaceLayout}
          onAssignOutput={(displayId, outputId) =>
            setStatusNote(`Assigned ${outputId} -> ${displayId} (mock)`)}
          onAddOutput={(outputId) => {
            setDisplayCount((c) => Math.min(3, c + 1));
            setStatusNote(`Added ${outputId} (mock)`);
          }}
          onSaveLayout={(slot) => setStatusNote(`Saved layout slot ${slot} (mock)`)}
          onLoadLayout={(slot) => setStatusNote(`Loaded layout slot ${slot} (mock)`)}
          batteryItems={batteryItems}
          onOpenSettingsWindow={() => setSettingsOpen((open) => !open)}
        />
      </group>
      {settingsOpen && (
        <group
          position={[settingsX, stageCenter[1] + 22, 15]}
          scale={[settingsScale, settingsScale, 1]}
        >
          <SettingsWindow onClose={() => setSettingsOpen(false)} />
        </group>
      )}
      <group position={[stageCenter[0], stageCenter[1] + 22 - panelHalfH - 54, 20]}>
        <Container
          pixelSize={1}
          flexDirection="column"
          alignItems="center"
          gap={6}
          paddingX={12}
          paddingY={8}
          borderRadius={14}
          backgroundColor="#1a1d24"
          backgroundOpacity={0.92}
        >
          <Container flexDirection="row" alignItems="center" gap={8}>
            <Text fontSize={12} color="#8a93a2">Mock:</Text>
            <MockChip
              label={musicOn ? "Media: On" : "Media: Off"}
              active={musicOn}
              onClick={() => setMusicOn((v) => !v)}
            />
            {musicOn && (
              <MockChip
                label="Next track"
                onClick={() => setTrackIndex((i) => (i + 1) % MOCK_TRACKS.length)}
              />
            )}
            <MockChip
              label={lowBattery ? "Battery: Low" : "Battery: High"}
              active={lowBattery}
              onClick={() => setLowBattery((v) => !v)}
            />
            <MockChip
              label={`Displays: ${displayCount}`}
              onClick={() => setDisplayCount((c) => (c % 3) + 1)}
            />
          </Container>
          <Container flexDirection="row" alignItems="center" gap={6}>
            <Text fontSize={12} color="#8a93a2">Batteries:</Text>
            {BATTERY_COUNTS.map((n) => (
              <MockChip
                key={n}
                label={String(n)}
                active={batteryCount === n}
                onClick={() => setBatteryCount(n)}
              />
            ))}
          </Container>
        </Container>
      </group>
    </>
  );
}
