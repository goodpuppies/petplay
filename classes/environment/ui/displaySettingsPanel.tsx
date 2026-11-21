/**
 * Display settings panel built 100% on PetPlay's recursive `<Grid>` / `<Cell>` system:
 * a square 4 × 4 grid (`SHELL_SIZE = 528 × 528`, same dimensions, spacing, and concentric radii
 * as the Wrist Menu).
 *
 *   Row 0 (4×1): Feed selector (equal-width nested grid)
 *   Row 1 (4×1): Anchored to selector (Playspace / Head / Left / Right)
 *   Row 2 (4×1): 1×2 sub-grid of Opacity + Curve interactive sliders
 *   Row 3 (4×1): 2×2 sub-grid of Laser mouse, Auto-hide, Grab outline toggles + Reset pose action
 */
import React from "react";
import type { AllowedPointerEventsType } from "@pmndrs/pointer-events";
import { Text } from "./text.tsx";
import { Cell, Grid } from "./grid.tsx";
import { GridOptionSection, GridSlider, GridToggle } from "./gridControls.tsx";
import { COLOR, GAP, INNER_GAP, RADIUS, SHELL_SIZE, unitSpan } from "./tokens.ts";

export type DisplaySettingsPanelProps = {
  feeds: ReadonlyArray<{ id: string; name: string }>;
  selectedFeedId: string | null;
  onSelectFeed: (id: string) => void;
  anchorLabel: string;
  anchorOptions: ReadonlyArray<{ id: string; label: string }>;
  selectedAnchorId: string;
  onSelectAnchor: (id: string) => void;
  opacity: number;
  onChangeOpacity: (next: number) => void;
  curvature: number;
  onChangeCurvature: (next: number) => void;
  showLaserMouse?: boolean;
  laserMouse: boolean;
  onChangeLaserMouse: (next: boolean) => void;
  autoHide: boolean;
  onChangeAutoHide: (next: boolean) => void;
  grabOutline: boolean;
  onChangeGrabOutline: (next: boolean) => void;
  shareDisplay?: boolean;
  onChangeShareDisplay?: (next: boolean) => void;
  allowRemoteControl?: boolean;
  onChangeAllowRemoteControl?: (next: boolean) => void;
  onResetPose: () => void;
  pixelSize?: number;
  pointerEventsType?: AllowedPointerEventsType;
  showGuides?: boolean;
};

export function DisplaySettingsPanel({
  feeds,
  selectedFeedId,
  onSelectFeed,
  anchorLabel,
  anchorOptions,
  selectedAnchorId,
  onSelectAnchor,
  opacity,
  onChangeOpacity,
  curvature,
  onChangeCurvature,
  showLaserMouse = true,
  laserMouse,
  onChangeLaserMouse,
  autoHide,
  onChangeAutoHide,
  grabOutline,
  onChangeGrabOutline,
  shareDisplay = false,
  onChangeShareDisplay,
  allowRemoteControl = false,
  onChangeAllowRemoteControl,
  onResetPose,
  pixelSize = 0.001,
  pointerEventsType = "all",
  showGuides = false,
}: DisplaySettingsPanelProps) {
  const rows = 5;
  const panelHeight = unitSpan(rows) + GAP * 2;
  return (
    <Grid
      cols={4}
      rows={rows}
      width={SHELL_SIZE}
      height={panelHeight}
      gap={GAP}
      padding={GAP}
      radius={RADIUS.shell}
      pixelSize={pixelSize}
      pointerEventsType={pointerEventsType}
      showGuides={showGuides}
    >
      {/* Row 0: Feed */}
      <Cell col={0} row={0} colSpan={4} rowSpan={1} surface="tile">
        <GridOptionSection
          label="Feed"
          value={selectedFeedId}
          onChange={onSelectFeed}
          showGuides={showGuides}
          options={feeds.map((f) => ({ value: f.id, label: f.name }))}
        />
      </Cell>

      {/* Row 1: Anchored to */}
      <Cell col={0} row={1} colSpan={4} rowSpan={1} surface="tile">
        <GridOptionSection
          label={anchorLabel}
          value={selectedAnchorId}
          onChange={onSelectAnchor}
          showGuides={showGuides}
          options={anchorOptions.map((o) => ({ value: o.id, label: o.label }))}
        />
      </Cell>

      {/* Row 2: Opacity + Curve pill sliders framed inside a 4×1 tile */}
      <Cell col={0} row={2} colSpan={4} rowSpan={1} surface="tile">
        <Grid cols={1} rows={2} gap={INNER_GAP} padding={INNER_GAP} showGuides={showGuides}>
          <Cell col={0} row={0} shape="round">
            <GridSlider
              label="Opacity"
              value={opacity}
              min={0.2}
              max={1}
              step={0.05}
              formatValue={(v) => `${Math.round(v * 100)}%`}
              onChange={onChangeOpacity}
            />
          </Cell>
          <Cell col={0} row={1} shape="round">
            <GridSlider
              label="Curve"
              value={curvature}
              min={0}
              max={0.35}
              step={0.05}
              formatValue={(v) => v <= 0.001 ? "Flat" : `${Math.round(v * 100)}%`}
              onChange={onChangeCurvature}
            />
          </Cell>
        </Grid>
      </Cell>

      {/* Row 3: 2×2 pill toggles + Reset pose framed inside a 4×1 tile */}
      <Cell col={0} row={3} colSpan={4} rowSpan={1} surface="tile">
        <Grid cols={2} rows={2} gap={INNER_GAP} padding={INNER_GAP} showGuides={showGuides}>
          {showLaserMouse
            ? (
              <Cell col={0} row={0} shape="round">
                <GridToggle
                  label="Laser mouse"
                  value={laserMouse}
                  onChange={onChangeLaserMouse}
                />
              </Cell>
            )
            : (
              <Cell col={0} row={0} shape="round" surface="outline">
                <Text color={COLOR.inkDim} fontSize={15}>View only</Text>
              </Cell>
            )}
          <Cell col={1} row={0} shape="round">
            <GridToggle
              label="Auto-hide"
              value={autoHide}
              onChange={onChangeAutoHide}
            />
          </Cell>
          <Cell col={0} row={1} shape="round">
            <GridToggle
              label="Grab outline"
              value={grabOutline}
              onChange={onChangeGrabOutline}
            />
          </Cell>
          <Cell col={1} row={1} shape="round" surface="outline" onClick={onResetPose}>
            <Text color={COLOR.ink} fontSize={16}>Reset pose</Text>
          </Cell>
        </Grid>
      </Cell>

      {/* Row 4: Sharing section (Share display + Allow remote control) */}
      <Cell col={0} row={4} colSpan={4} rowSpan={1} surface="tile">
        <Grid cols={1} rows={2} gap={INNER_GAP} padding={INNER_GAP} showGuides={showGuides}>
          <Cell col={0} row={0} flexDirection="row" justifyContent="flex-start" paddingX={12}>
            <Text color={COLOR.inkDim} fontSize={18}>Sharing</Text>
          </Cell>
          <Cell col={0} row={1}>
            <Grid cols={2} rows={1} gap={INNER_GAP} padding={0} showGuides={showGuides}>
              <Cell col={0} row={0} shape="round">
                <GridToggle
                  label="Share display"
                  value={shareDisplay}
                  onChange={(next) => onChangeShareDisplay?.(next)}
                />
              </Cell>
              <Cell col={1} row={0} shape="round">
                <GridToggle
                  label="Remote control"
                  value={allowRemoteControl}
                  onChange={(next) => onChangeAllowRemoteControl?.(next)}
                />
              </Cell>
            </Grid>
          </Cell>
        </Grid>
      </Cell>
    </Grid>
  );
}
