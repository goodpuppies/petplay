import React, { useState } from "react";
import * as TSL from "three/tsl";
import { Content } from "../../../submodules/threewebxrwebgpudeno/uikit-r3f.tsx";
import { Button, Container, Text } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import type { WristMenuButtonId } from "./types.ts";

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

function ControllerFrame({ children }: { children?: React.ReactNode }) {
  const [hovered, setHovered] = useState(false);

  return (
    <group onPointerOver={() => setHovered(true)} onPointerOut={() => setHovered(false)}>
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
  }: WristMenuUiProps,
) {
  return (
    <ControllerFrame>
      <Container
        pixelSize={0.001}
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

        <Container {...({ positionType: "absolute", left: 10, bottom: 10 } as const)}>
          <Text color="#90ee90" fontSize={12}>
            {statusLabel}
          </Text>
        </Container>
      </Container>
    </ControllerFrame>
  );
}
