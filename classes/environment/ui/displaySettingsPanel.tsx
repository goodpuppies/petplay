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
  feeds: ReadonlyArray<{ id: string; name: string; kind?: "monitor" | "window" }>;
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
  showSharing?: boolean;
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
  showSharing = true,
  shareDisplay = false,
  onChangeShareDisplay,
  allowRemoteControl = false,
  onChangeAllowRemoteControl,
  onResetPose,
  pixelSize = 0.001,
  pointerEventsType = "all",
  showGuides = false,
}: DisplaySettingsPanelProps) {
  const screenFeeds = feeds.filter((f) => f.kind !== "window");
  const windowFeeds = feeds.filter((f) => f.kind === "window");
  const selectedIsWindow = windowFeeds.some((f) => f.id === selectedFeedId);
  const [feedTab, setFeedTab] = React.useState<"screens" | "windows">(
    selectedIsWindow ? "windows" : "screens",
  );
  const [page, setPage] = React.useState(0);
  const activeTab = windowFeeds.length === 0 ? "screens" : feedTab;
  const tabFeeds = activeTab === "windows" ? windowFeeds : screenFeeds;
  const pageSize = 3;
  const pageCount = Math.max(1, Math.ceil(tabFeeds.length / pageSize));
  const clampedPage = Math.min(page, pageCount - 1);
  const visibleFeeds = tabFeeds.length <= 4
    ? tabFeeds
    : tabFeeds.slice(clampedPage * pageSize, (clampedPage + 1) * pageSize);

  const rows = showSharing ? 5 : 4;
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
      {/* Row 0: Feed (Screens / Windows tabs + pagination when > 4 items) */}
      <Cell col={0} row={0} colSpan={4} rowSpan={1} surface="tile">
        {windowFeeds.length === 0 && tabFeeds.length <= 4
          ? (
            <GridOptionSection
              label="Feed"
              value={selectedFeedId}
              onChange={onSelectFeed}
              showGuides={showGuides}
              options={tabFeeds.map((f) => ({ value: f.id, label: f.name }))}
            />
          )
          : (
            <Grid cols={1} rows={2} gap={INNER_GAP} padding={INNER_GAP} showGuides={showGuides}>
              <Cell col={0} row={0}>
                <Grid
                  cols={windowFeeds.length > 0 ? 4 : 1}
                  rows={1}
                  gap={INNER_GAP}
                  padding={0}
                  showGuides={showGuides}
                >
                  <Cell
                    col={0}
                    row={0}
                    colSpan={windowFeeds.length > 0 ? 2 : 1}
                    flexDirection="row"
                    justifyContent="flex-start"
                    paddingX={12}
                  >
                    <Text color={COLOR.inkDim} fontSize={18}>
                      {tabFeeds.length > 4
                        ? `Feed (${clampedPage + 1}/${pageCount})`
                        : "Feed"}
                    </Text>
                  </Cell>
                  {windowFeeds.length > 0
                    ? (
                      <>
                        <Cell
                          col={2}
                          row={0}
                          shape="round"
                          surface={activeTab === "screens" ? "accent" : "outline"}
                          onClick={() => {
                            setFeedTab("screens");
                            setPage(0);
                          }}
                        >
                          <Text
                            color={activeTab === "screens" ? COLOR.onAccent : COLOR.ink}
                            fontSize={14}
                          >
                            Screens
                          </Text>
                        </Cell>
                        <Cell
                          col={3}
                          row={0}
                          shape="round"
                          surface={activeTab === "windows" ? "accent" : "outline"}
                          onClick={() => {
                            setFeedTab("windows");
                            setPage(0);
                          }}
                        >
                          <Text
                            color={activeTab === "windows" ? COLOR.onAccent : COLOR.ink}
                            fontSize={14}
                          >
                            Windows
                          </Text>
                        </Cell>
                      </>
                    )
                    : null}
                </Grid>
              </Cell>
              <Cell col={0} row={1}>
                <Grid
                  cols={tabFeeds.length > 4
                    ? visibleFeeds.length + 2
                    : Math.max(1, visibleFeeds.length)}
                  rows={1}
                  gap={INNER_GAP}
                  padding={0}
                  showGuides={showGuides}
                >
                  {tabFeeds.length > 4
                    ? (
                      <Cell
                        col={0}
                        row={0}
                        shape="round"
                        surface="outline"
                        onClick={() => setPage((p) => (p - 1 + pageCount) % pageCount)}
                      >
                        <Text color={COLOR.ink} fontSize={16}>‹</Text>
                      </Cell>
                    )
                    : null}
                  {visibleFeeds.map((f, idx) => {
                    const selected = f.id === selectedFeedId;
                    return (
                      <Cell
                        key={f.id}
                        col={tabFeeds.length > 4 ? idx + 1 : idx}
                        row={0}
                        shape="round"
                        surface={selected ? "accent" : "outline"}
                        onClick={() => onSelectFeed(f.id)}
                      >
                        <Text
                          color={selected ? COLOR.onAccent : COLOR.ink}
                          fontSize={visibleFeeds.length >= 3 ? 14 : 16}
                        >
                          {f.name}
                        </Text>
                      </Cell>
                    );
                  })}
                  {tabFeeds.length > 4
                    ? (
                      <Cell
                        col={visibleFeeds.length + 1}
                        row={0}
                        shape="round"
                        surface="outline"
                        onClick={() => setPage((p) => (p + 1) % pageCount)}
                      >
                        <Text color={COLOR.ink} fontSize={16}>›</Text>
                      </Cell>
                    )
                    : null}
                </Grid>
              </Cell>
            </Grid>
          )}
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
      {showSharing
        ? (
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
        )
        : null}
    </Grid>
  );
}
