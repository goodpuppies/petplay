import React, { useState } from "react";
import type { AllowedPointerEventsType } from "@pmndrs/pointer-events";
import { Button, Container, Text } from "../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";

export type SpatialContextAction = {
  id: string;
  label: string;
  tone?: "normal" | "danger" | "accent";
  disabled?: boolean;
  run: () => void;
};

export type SpatialContextToolbarProps = {
  title: string;
  actions: SpatialContextAction[];
  settings?: React.ReactNode;
  position: [number, number, number];
  scale?: number;
  pointerEventsType?: AllowedPointerEventsType;
};

function actionColor(action: SpatialContextAction): string {
  if (action.disabled) return "#34414c";
  if (action.tone === "danger") return "#9f2f3f";
  if (action.tone === "accent") return "#1d7d67";
  return "#365f91";
}

export function SpatialContextToolbar({
  title,
  actions,
  settings,
  position,
  scale = 0.72,
  pointerEventsType = "all",
}: SpatialContextToolbarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <group
      position={position}
      scale={[scale, scale, scale]}
      userData={{ spatialContextToolbar: true }}
      {...({ pointerEventsOrder: 20 } as Record<string, unknown>)}
    >
      <Container
        pixelSize={0.001}
        width={560}
        padding={10}
        gap={8}
        flexDirection="column"
        alignItems="stretch"
        borderRadius={14}
        borderWidth={3}
        borderColor="#49657c"
        backgroundColor="#172633"
        backgroundOpacity={0.94}
        pointerEventsType={pointerEventsType}
      >
        <Container flexDirection="row" alignItems="center" gap={8}>
          <Text color="#ffffff" fontSize={16} fontWeight="bold" flexGrow={1}>
            {title}
          </Text>
          {settings != null && (
            <Button
              paddingX={12}
              paddingY={8}
              borderRadius={9}
              backgroundColor={settingsOpen ? "#1d7d67" : "#365f91"}
              backgroundOpacity={1}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <Text color="#ffffff" fontSize={13} fontWeight="bold">Settings</Text>
            </Button>
          )}
          {actions.map((action) => (
            <Button
              key={action.id}
              paddingX={12}
              paddingY={8}
              borderRadius={9}
              backgroundColor={actionColor(action)}
              backgroundOpacity={1}
              hover={{ backgroundColor: action.disabled ? "#34414c" : "#2877a8" }}
              onClick={action.disabled ? undefined : action.run}
            >
              <Text color={action.disabled ? "#82909b" : "#ffffff"} fontSize={13}>
                {action.label}
              </Text>
            </Button>
          ))}
        </Container>
        {settingsOpen && settings}
      </Container>
    </group>
  );
}

export function SpatialSettingsSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Container flexDirection="column" gap={6} paddingTop={4}>
      <Text color="#9ec6df" fontSize={12}>{label}</Text>
      <Container flexDirection="row" flexWrap="wrap" gap={6}>
        {children}
      </Container>
    </Container>
  );
}

export function SpatialSettingsButton({
  label,
  selected = false,
  onClick,
}: {
  label: string;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      paddingX={10}
      paddingY={7}
      borderRadius={8}
      backgroundColor={selected ? "#1d8a66" : "#40566b"}
      backgroundOpacity={1}
      hover={{ backgroundColor: "#2877a8" }}
      onClick={onClick}
    >
      <Text color="#ffffff" fontSize={12}>{label}</Text>
    </Button>
  );
}

export function SpatialHierarchyIndicator({
  role,
  position,
}: {
  role: "parent" | "child" | "solo";
  position: [number, number, number];
}) {
  const label = role === "parent" ? "P" : role === "child" ? "C" : "S";
  return (
    <group
      position={position}
      userData={{ spatialHierarchyIndicator: role }}
      {...({ pointerEvents: "none", pointerEventsOrder: 30 } as Record<string, unknown>)}
    >
      <Container
        pixelSize={0.001}
        width={42}
        height={42}
        alignItems="center"
        justifyContent="center"
        borderRadius={21}
        borderWidth={3}
        borderColor="#9ec6df"
        backgroundColor="#172633"
        backgroundOpacity={0.94}
      >
        <Text color="#ffffff" fontSize={22} fontWeight="bold">{label}</Text>
      </Container>
    </group>
  );
}
