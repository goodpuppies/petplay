import React, { useCallback, useEffect, useRef, useState } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import { extend, ThreeToJSXElements } from "@react-three/fiber";
import { Handle } from "@react-three/handle";
import { DefaultXRController, isXRInputSourceState, XRSpace } from "@pmndrs/xr";
import { Content } from "../../submodules/threewebxrwebgpudeno/uikit-r3f.tsx";
import { Button, Container, Text } from "../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

declare module "@react-three/fiber" {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

const CONTROLLER_UI_POSITION: [number, number, number] = [0.14, 0.0, 0.04];
const CONTROLLER_UI_ROTATION: [number, number, number] = [
  -1.1064536056499201,
  -0.5691113573725565,
  -1.1867850376947444,
];
const CONTROLLER_UI_SCALE: [number, number, number] = [0.47, 0.47, 0.47];

export type NativeHudTransform = {
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
};

function formatClock(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function formatDate(date: Date) {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear()).padStart(4, "0");
  return `${weekday} ${day}/${month}/${year}`;
}

function formatElapsed(startedAt: number, now: number) {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

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

export function NativeHudPanel(
  { ignoredHandedness, transform }: {
    ignoredHandedness?: "left" | "right";
    transform?: NativeHudTransform;
  },
) {
  const startedAt = useRef(performance.now());
  const [layersActive, setLayersActive] = useState(false);
  const [musicActive, setMusicActive] = useState(false);
  const [signalActive, setSignalActive] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const allowPointerEvents = useCallback(
    (_pointerId: number, _pointerType: string, pointerState: unknown) => {
      if (!ignoredHandedness || !isXRInputSourceState(pointerState)) {
        return true;
      }
      return pointerState.inputSource.handedness !== ignoredHandedness;
    },
    [ignoredHandedness],
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const currentDate = new Date(now);
  const clock = formatClock(currentDate);
  const dateLabel = formatDate(currentDate);
  const elapsed = formatElapsed(startedAt.current, now);
  const position = transform?.position ?? CONTROLLER_UI_POSITION;
  const rotation = transform?.rotation ?? CONTROLLER_UI_ROTATION;
  const scale = transform?.scale ?? CONTROLLER_UI_SCALE;

  return (
    <group
      position={position}
      rotation={rotation}
      scale={scale}
      pointerEventsType={allowPointerEvents}
      userData={{ bridge: { kind: "skip" } }}
    >
      <Handle>
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
                <Button
                  padding={24}
                  borderRadius={12}
                  backgroundOpacity={1}
                  backgroundColor={layersActive ? "#a51d1d" : "#f39c12"}
                  hover={{
                    backgroundColor: layersActive ? "#8c1818" : "#d35400",
                    backgroundOpacity: 1,
                  }}
                  onClick={() => setLayersActive((value) => !value)}
                >
                  <LayersIcon />
                </Button>
                <Button
                  padding={24}
                  borderRadius={12}
                  backgroundOpacity={1}
                  backgroundColor={musicActive ? "#a51d1d" : "#f39c12"}
                  hover={{
                    backgroundColor: musicActive ? "#8c1818" : "#d35400",
                    backgroundOpacity: 1,
                  }}
                  onClick={() => setMusicActive((value) => !value)}
                >
                  <MusicIcon />
                </Button>
                <Button
                  padding={24}
                  borderRadius={12}
                  backgroundOpacity={1}
                  backgroundColor={signalActive ? "#a51d1d" : "#f39c12"}
                  hover={{
                    backgroundColor: signalActive ? "#8c1818" : "#d35400",
                    backgroundOpacity: 1,
                  }}
                  onClick={() => setSignalActive((value) => !value)}
                >
                  <SignalHighIcon />
                </Button>
              </Container>
            </Container>

            <Container {...({ positionType: "absolute", left: 10, bottom: 10 } as const)}>
              <Text color="#90ee90" fontSize={12}>
                Native module active
              </Text>
            </Container>
          </Container>
        </ControllerFrame>
      </Handle>
    </group>
  );
}

export function NativeFrontend() {
  return <NativeHudPanel />;
}

export function NativeControllerHud() {
  return (
    <>
      <DefaultXRController />
      <XRSpace space="grip-space">
        <NativeHudPanel ignoredHandedness="right" />
      </XRSpace>
    </>
  );
}
