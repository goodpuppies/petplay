import React, { useState } from "react";
import type { AllowedPointerEventsType } from "@pmndrs/pointer-events";
import { Button, Container, Text } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Pill, Shell } from "../ui/primitives.tsx";
import { COLOR, INNER_GAP, OUTLINE_WIDTH, RADIUS } from "../ui/tokens.ts";
import { WristOverlay } from "../ui/wristOverlay.tsx";
import type { WristMenuButtonId } from "./types.ts";
import type { WorkspaceLayoutSnapshot } from "../workspaceLayoutStore.ts";

export type { WristMenuButtonId } from "./types.ts";

export type WristMenuUiProps = {
  clock?: string;
  dateLabel?: string;
  elapsed?: string;
  statusLabel?: string;
  layoutActive?: boolean;
  editActive?: boolean;
  onToggle?: (id: WristMenuButtonId) => void;
  workspaceLayout?: WorkspaceLayoutSnapshot;
  onAssignOutput?: (displayId: string, outputId: string) => void;
  onAddOutput?: (outputId: string) => void;
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
                  borderOpacity={1}
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
                borderOpacity={1}
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

export function WristMenuUi(
  {
    clock = DEFAULT_CLOCK,
    dateLabel = DEFAULT_DATE_LABEL,
    elapsed = DEFAULT_ELAPSED,
    statusLabel = DEFAULT_STATUS_LABEL,
    layoutActive = false,
    editActive = false,
    onToggle,
    workspaceLayout = { outputs: [], displays: [] },
    onAssignOutput,
    onAddOutput,
    pointerEventsType,
  }: WristMenuUiProps,
) {
  const pe: AllowedPointerEventsType = pointerEventsType ?? "all";
  const [view, setView] = useState<"main" | "monitors">("main");

  if (view === "monitors") {
    return (
      <Shell pointerEventsType={pe}>
        <MonitorAssignments
          workspaceLayout={workspaceLayout}
          onAssignOutput={onAssignOutput}
          onAddOutput={onAddOutput}
          onBack={() => setView("main")}
        />
      </Shell>
    );
  }

  return (
    <WristOverlay
      clock={clock}
      dateLabel={dateLabel}
      elapsed={elapsed}
      status={statusLabel}
      displayCount={workspaceLayout.displays.length}
      active={{ layout: layoutActive, edit: editActive }}
      onToggle={onToggle}
      onOpenSettings={() => setView("monitors")}
      pointerEventsType={pe}
    />
  );
}
