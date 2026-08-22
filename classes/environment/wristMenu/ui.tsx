import React, { useState } from "react";
import * as TSL from "three/tsl";
import type { AllowedPointerEventsType } from "@pmndrs/pointer-events";
import { Content } from "../../../submodules/threewebxrwebgpudeno/uikit-r3f.tsx";
import { Button, Container, Text } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import type { WristMenuButtonId } from "./types.ts";
import type { WorkspaceLayoutSnapshot } from "../workspaceLayoutStore.ts";

export type { WristMenuButtonId } from "./types.ts";

export type WristMenuUiProps = {
  clock?: string;
  dateLabel?: string;
  elapsed?: string;
  statusLabel?: string;
  layersActive?: boolean;
  musicActive?: boolean;
  signalActive?: boolean;
  onToggle?: (id: WristMenuButtonId) => void;
  workspaceLayout?: WorkspaceLayoutSnapshot;
  onAssignOutput?: (displayId: string, outputId: string) => void;
  onAddOutput?: (outputId: string) => void;
  /** Only the opposite controller’s pointer should hit the menu (set from `WristMenuPanel` in XR). */
  pointerEventsType?: AllowedPointerEventsType;
};

const DEFAULT_CLOCK = "12:00 PM";
const DEFAULT_DATE_LABEL = "Fri 24/04/2026";
const DEFAULT_ELAPSED = "00:00:00";
const DEFAULT_STATUS_LABEL = "Native module active";

function LayersIcon() {
  return (
    <Content width={22} height={22}>
      <mesh position={[0, 0.005, 0.003]}>
        <planeGeometry args={[0.02, 0.004]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
      </mesh>
      <mesh position={[0, 0, 0.003]}>
        <planeGeometry args={[0.02, 0.004]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
      </mesh>
      <mesh position={[0, -0.005, 0.003]}>
        <planeGeometry args={[0.02, 0.004]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
      </mesh>
    </Content>
  );
}

function MusicIcon() {
  return (
    <Content width={22} height={22}>
      <mesh position={[-0.004, 0.002, 0.003]}>
        <planeGeometry args={[0.0035, 0.022]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
      </mesh>
      <mesh position={[0.005, 0.009, 0.003]}>
        <planeGeometry args={[0.015, 0.0035]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
      </mesh>
      <mesh position={[-0.008, -0.01, 0.003]}>
        <circleGeometry args={[0.0055, 20]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
      </mesh>
      <mesh position={[0.003, -0.007, 0.003]}>
        <circleGeometry args={[0.0055, 20]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
      </mesh>
    </Content>
  );
}

function SignalHighIcon() {
  return (
    <Content width={22} height={22}>
      <mesh position={[-0.005, -0.004, 0.003]}>
        <planeGeometry args={[0.003, 0.008]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
      </mesh>
      <mesh position={[0, -0.002, 0.003]}>
        <planeGeometry args={[0.003, 0.012]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
      </mesh>
      <mesh position={[0.005, 0.001, 0.003]}>
        <planeGeometry args={[0.003, 0.016]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
      </mesh>
    </Content>
  );
}

function ControllerFrame(
  { children, pointerEventsType }: {
    children?: React.ReactNode;
    pointerEventsType?: AllowedPointerEventsType;
  },
) {
  const [hovered, setHovered] = useState(false);

  return (
    <group
      {...({ pointerEventsType } as Record<string, unknown>)}
      onPointerOver={() => setHovered(true)}
      onPointerOut={() => setHovered(false)}
    >
      {children}
      <mesh raycast={() => null} renderOrder={1}>
        <boxGeometry args={[0.4, 0.2, 0.04]} />
        <meshBasicMaterial
          color={hovered ? "#ff5a36" : "#4a7cff"}
          wireframe
          transparent
          opacity={0.2}
          depthTest={false}
        />
      </mesh>
    </group>
  );
}

function MenuButton(
  { active, children, onClick }: {
    active: boolean;
    children: React.ReactNode;
    onClick?: () => void;
  },
) {
  return (
    <Button
      padding={24}
      borderRadius={12}
      backgroundOpacity={1}
      backgroundColor={active ? "#a51d1d" : "#f39c12"}
      hover={{
        backgroundColor: active ? "#8c1818" : "#d35400",
        backgroundOpacity: 1,
      }}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

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
    <Container flexDirection="column" gap={10} width={460}>
      <Container flexDirection="row" alignItems="center" gap={10}>
        <Button
          paddingX={14}
          paddingY={8}
          borderRadius={10}
          backgroundColor="#365f91"
          backgroundOpacity={1}
          onClick={onBack}
        >
          <Text color="#ffffff" fontSize={14} fontWeight="bold">Back</Text>
        </Button>
        <Text color="#ffffff" fontSize={20} fontWeight="bold">Monitor assignments</Text>
      </Container>

      {workspaceLayout.displays.map((display) => (
        <Container
          key={display.id}
          flexDirection="column"
          gap={6}
          padding={9}
          borderRadius={10}
          backgroundColor="#243646"
          backgroundOpacity={0.9}
        >
          <Text color="#ffffff" fontSize={14} fontWeight="bold">
            Display {display.ordinal}
            {display.root ? " (root)" : ""}
          </Text>
          <Container flexDirection="row" gap={6} flexWrap="wrap">
            {workspaceLayout.outputs.map((output) => (
              <Button
                key={output.id}
                paddingX={10}
                paddingY={7}
                borderRadius={8}
                backgroundColor={display.outputId === output.id ? "#1d8a66" : "#40566b"}
                backgroundOpacity={1}
                hover={{ backgroundColor: "#2877a8", backgroundOpacity: 1 }}
                onClick={() => onAssignOutput?.(display.id, output.id)}
              >
                <Text color="#ffffff" fontSize={13}>{output.name}</Text>
              </Button>
            ))}
          </Container>
        </Container>
      ))}

      {workspaceLayout.outputs.length === 0 && (
        <Text color="#bdc3c7" fontSize={14}>No workspace outputs found.</Text>
      )}
      {unassigned.length > 0 && (
        <Container flexDirection="column" gap={6}>
          <Text color="#90ee90" fontSize={13}>Unassigned outputs</Text>
          <Container flexDirection="row" gap={6} flexWrap="wrap">
            {unassigned.map((output) => (
              <Button
                key={output.id}
                paddingX={10}
                paddingY={7}
                borderRadius={8}
                backgroundColor="#8a5721"
                backgroundOpacity={1}
                onClick={() => onAddOutput?.(output.id)}
              >
                <Text color="#ffffff" fontSize={13}>Add {output.name}</Text>
              </Button>
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
    layersActive = false,
    musicActive = false,
    signalActive = false,
    onToggle,
    workspaceLayout = { outputs: [], displays: [] },
    onAssignOutput,
    onAddOutput,
    pointerEventsType,
  }: WristMenuUiProps,
) {
  const pe: AllowedPointerEventsType = pointerEventsType ?? "all";
  const [view, setView] = useState<"main" | "monitors">("main");
  return (
    <ControllerFrame pointerEventsType={pe}>
      <Container
        pixelSize={0.001}
        pointerEventsType={pe}
        backgroundColor="#2c3e50"
        borderColor="#3b5268"
        borderWidth={4}
        borderRadius={20}
        backgroundOpacity={0.8}
        padding={10}
        flexDirection="column"
        alignItems="stretch"
        gap={10}
      >
        {view === "main" && (
          <Container
            flexDirection="row"
            alignItems="center"
            paddingX={15}
            paddingY={8}
            borderRadius={15}
            backgroundColor="rgba(70, 80, 90)"
            backgroundOpacity={0.7}
          >
            <Container flexDirection="column" flexShrink={0}>
              <Text color="#ffffff" fontSize={28} fontWeight="bold">
                {clock}
              </Text>
              <Text color="#bdc3c7" fontSize={14}>
                {dateLabel}
              </Text>
              <Text color="#bdc3c7" fontSize={12}>
                {elapsed}
              </Text>
            </Container>

            <Container padding={14} flexGrow={1} />

            <Container flexDirection="row" gap={8} alignItems="center" flexShrink={0}>
              <MenuButton active={layersActive} onClick={() => onToggle?.("layers")}>
                <LayersIcon />
              </MenuButton>
              <MenuButton active={musicActive} onClick={() => onToggle?.("music")}>
                <MusicIcon />
              </MenuButton>
              <MenuButton active={signalActive} onClick={() => onToggle?.("signal")}>
                <SignalHighIcon />
              </MenuButton>
            </Container>
          </Container>
        )}

        {view === "main" && (
          <Button
            paddingX={18}
            paddingY={10}
            borderRadius={12}
            backgroundColor="#365f91"
            backgroundOpacity={1}
            hover={{ backgroundColor: "#274b76", backgroundOpacity: 1 }}
            onClick={() => setView("monitors")}
          >
            <Text color="#ffffff" fontSize={16} fontWeight="bold">
              Monitors
            </Text>
          </Button>
        )}

        {view === "monitors" && (
          <MonitorAssignments
            workspaceLayout={workspaceLayout}
            onAssignOutput={onAssignOutput}
            onAddOutput={onAddOutput}
            onBack={() => setView("main")}
          />
        )}

        {view === "main" && (
          <Container paddingX={4}>
            <Text color="#90ee90" fontSize={12}>
              {statusLabel}
            </Text>
          </Container>
        )}
      </Container>
    </ControllerFrame>
  );
}
