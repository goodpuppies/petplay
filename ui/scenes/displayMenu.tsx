/**
 * Preview of PetPlay's real `SpatialContextToolbar` + recursive-grid `DisplaySettingsPanel`
 * positioned right next to a black screen placeholder, at true 1:1 world-meter proportions.
 */
import React, { useMemo, useState } from "react";
import { Container } from "../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Text } from "../../classes/environment/ui/text.tsx";
import { COLOR } from "../../classes/environment/ui/tokens.ts";
import {
  DEFAULT_DISPLAY_HEIGHT,
  DISPLAY_PANEL_WIDTH,
} from "../../classes/environment/displayMetrics.ts";
import {
  SPATIAL_ORIGIN_IDS,
  SPATIAL_ORIGIN_LABEL,
  type SpatialOriginId,
} from "../../classes/environment/trackedOrigins.ts";
import {
  type SpatialContextAction,
  SpatialContextToolbar,
} from "../../classes/environment/spatialContextToolbar.tsx";
import { DisplaySettingsPanel } from "../../classes/environment/ui/displaySettingsPanel.tsx";
import type { PreviewSceneProps } from "./index.ts";

type ToolbarSide = "right" | "left" | "below" | "above";
type ScreenShape = "square" | "wide";
type HierarchyRole = "parent" | "child" | "solo";

const SIDES: readonly ToolbarSide[] = ["right", "left", "below", "above"];
const ROLES: readonly HierarchyRole[] = ["parent", "child", "solo"];

const MOCK_FEEDS = [
  { id: "DP-1", name: "DP-1" },
  { id: "DP-2", name: "DP-2" },
  { id: "HDMI-1", name: "HDMI-1" },
];

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

export function DisplayMenuScene({ stageCenter, scale }: PreviewSceneProps) {
  const [side, setSide] = useState<ToolbarSide>("right");
  const [shape, setShape] = useState<ScreenShape>("square");
  const [role, setRole] = useState<HierarchyRole>("parent");
  const [showGuides, setShowGuides] = useState(false);
  const [locked, setLocked] = useState(false);
  const [attached, setAttached] = useState(true);
  const [feed, setFeed] = useState("DP-1");
  const [origin, setOrigin] = useState<SpatialOriginId>(SPATIAL_ORIGIN_IDS[0]);
  const [opacity, setOpacity] = useState(1);
  const [curvature, setCurvature] = useState(0.15);
  const [laserMouse, setLaserMouse] = useState(true);
  const [autoHide, setAutoHide] = useState(false);
  const [grabOutline, setGrabOutline] = useState(true);
  const [shareDisplay, setShareDisplay] = useState(true);
  const [allowRemoteControl, setAllowRemoteControl] = useState(false);
  const [lastAction, setLastAction] = useState("4×5 recursive-grid display settings panel");

  const screenW = shape === "square" ? DEFAULT_DISPLAY_HEIGHT : DISPLAY_PANEL_WIDTH;
  const screenH = DEFAULT_DISPLAY_HEIGHT;

  const actions = useMemo<SpatialContextAction[]>(() => [
    {
      id: "add-display",
      label: "Add display",
      run: () => setLastAction("Action: add-display"),
    },
    {
      id: "detach",
      label: attached ? "Detach" : "Detached",
      tone: attached ? "accent" : "normal",
      disabled: !attached,
      run: () => {
        setAttached(false);
        setLastAction("Action: detach");
      },
    },
    {
      id: "lock",
      label: locked ? "Unlock" : "Lock",
      tone: locked ? "accent" : "normal",
      run: () => {
        setLocked((v) => !v);
        setLastAction(locked ? "Action: unlock" : "Action: lock");
      },
    },
    {
      id: "reset",
      label: "Reset",
      run: () => {
        setAttached(true);
        setLocked(false);
        setOpacity(1);
        setCurvature(0);
        setLastAction("Action: reset");
      },
    },
    {
      id: "delete",
      label: "Delete",
      tone: "danger",
      run: () => setLastAction("Action: delete"),
    },
  ], [attached, locked]);

  const edgePad = 0.025;
  const toolbarPosition: [number, number, number] = side === "left" || side === "right"
    ? [
      (side === "right" ? 0.5 : -0.5) * screenW + (side === "right" ? edgePad : -edgePad),
      screenH * 0.5,
      0,
    ]
    : [
      0,
      (side === "above" ? 0.5 : -0.5) * screenH + (side === "above" ? edgePad : -edgePad),
      0,
    ];

  const worldToPx = 560 * scale;
  const offsetX = side === "right" ? -260 * scale : side === "left" ? 260 * scale : 0;
  const offsetY = side === "below" ? 90 * scale : side === "above" ? -90 * scale : 40 * scale;

  return (
    <>
      <group
        position={[stageCenter[0] + offsetX, stageCenter[1] + offsetY, 10]}
        scale={[worldToPx, worldToPx, 1]}
      >
        {/* Black screen placeholder at true meter dimensions (uikit pixelSize=0.001) */}
        <Container
          pixelSize={0.001}
          width={Math.round(screenW * 1000)}
          height={Math.round(screenH * 1000)}
          backgroundColor="#000000"
          backgroundOpacity={opacity}
          borderWidth={grabOutline ? 4 : 1}
          borderColor={grabOutline ? "#3b82f6" : "#26262b"}
          alignItems="center"
          justifyContent="center"
        >
          <Text color="#4a4d5c" fontSize={22}>
            {shape === "square" ? "Screen (1:1)" : "Screen (16:9)"}
          </Text>
        </Container>

        {/* Real SpatialContextToolbar + 4×5 recursive-grid DisplaySettingsPanel */}
        <SpatialContextToolbar
          open
          defaultSettingsOpen
          sharing={shareDisplay}
          title={feed}
          side={side}
          scale={0.72 * worldToPx}
          position={toolbarPosition}
          settingsPosition={[screenW * 0.5 + edgePad, screenH * 0.5, 0]}
          role={role}
          actions={actions}
          settingsPanel={
            <DisplaySettingsPanel
              feeds={MOCK_FEEDS}
              selectedFeedId={feed}
              onSelectFeed={(id) => {
                setFeed(id);
                setLastAction(`Feed -> ${id}`);
              }}
              anchorLabel={role === "child" ? "Group anchored to" : "Anchored to"}
              anchorOptions={SPATIAL_ORIGIN_IDS.map((id) => ({
                id,
                label: SPATIAL_ORIGIN_LABEL[id],
              }))}
              selectedAnchorId={origin}
              onSelectAnchor={(id) => {
                setOrigin(id as SpatialOriginId);
                setLastAction(`Anchored to -> ${SPATIAL_ORIGIN_LABEL[id as SpatialOriginId]}`);
              }}
              opacity={opacity}
              onChangeOpacity={(next) => {
                setOpacity(next);
                setLastAction(`Opacity -> ${Math.round(next * 100)}%`);
              }}
              curvature={curvature}
              onChangeCurvature={(next) => {
                setCurvature(next);
                setLastAction(`Curve -> ${next <= 0.001 ? "Flat" : `${Math.round(next * 100)}%`}`);
              }}
              laserMouse={laserMouse}
              onChangeLaserMouse={(next) => {
                setLaserMouse(next);
                setLastAction(`Laser mouse -> ${next ? "On" : "Off"}`);
              }}
              autoHide={autoHide}
              onChangeAutoHide={(next) => {
                setAutoHide(next);
                setLastAction(`Auto-hide -> ${next ? "On" : "Off"}`);
              }}
              grabOutline={grabOutline}
              onChangeGrabOutline={(next) => {
                setGrabOutline(next);
                setLastAction(`Grab outline -> ${next ? "On" : "Off"}`);
              }}
              shareDisplay={shareDisplay}
              onChangeShareDisplay={(next) => {
                setShareDisplay(next);
                if (!next) setAllowRemoteControl(false);
                setLastAction(`Share display -> ${next ? "On" : "Off"}`);
              }}
              allowRemoteControl={allowRemoteControl}
              onChangeAllowRemoteControl={(next) => {
                setAllowRemoteControl(next);
                if (next) setShareDisplay(true);
                setLastAction(`Remote control -> ${next ? "On" : "Off"}`);
              }}
              onResetPose={() => setLastAction("Reset pose (mock)")}
              showGuides={showGuides}
            />
          }
        />
      </group>

      {/* Mock controls strip at bottom */}
      <group position={[stageCenter[0], stageCenter[1] - 310 * scale, 20]}>
        <Container
          pixelSize={1}
          flexDirection="column"
          alignItems="center"
          gap={6}
          paddingX={12}
          paddingY={8}
          borderRadius={14}
          backgroundColor="#1a1d24"
          backgroundOpacity={0.95}
        >
          <Container flexDirection="row" alignItems="center" gap={6}>
            <Text fontSize={12} color="#8a93a2">Side:</Text>
            {SIDES.map((s) => (
              <Chip key={s} label={s} active={side === s} onClick={() => setSide(s)} />
            ))}
            <Container width={6} />
            <Text fontSize={12} color="#8a93a2">Screen:</Text>
            <Chip
              label="Square"
              active={shape === "square"}
              onClick={() => setShape("square")}
            />
            <Chip
              label="16:9"
              active={shape === "wide"}
              onClick={() => setShape("wide")}
            />
            <Container width={6} />
            <Text fontSize={12} color="#8a93a2">Role:</Text>
            {ROLES.map((r) => (
              <Chip key={r} label={r} active={role === r} onClick={() => setRole(r)} />
            ))}
            <Container width={6} />
            <Chip
              label={showGuides ? "Guides: On" : "Guides: Off"}
              active={showGuides}
              onClick={() => setShowGuides((v) => !v)}
            />
          </Container>
          <Text fontSize={12} color="#9aa3b2">{lastAction}</Text>
        </Container>
      </group>
    </>
  );
}
