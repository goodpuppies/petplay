/**
 * Interactive preview of PetPlay's toast cards (info / warning / error) and a contextual
 * spatial action bar using the same overlay tokens.
 */
import React, { useState } from "react";
import { Container } from "../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Text } from "../../classes/environment/ui/text.tsx";
import { Icon, type IconName } from "../../classes/environment/ui/icons.tsx";
import { Pill } from "../../classes/environment/ui/primitives.tsx";
import {
  clampRadius,
  COLOR,
  GAP,
  INNER_GAP,
  OUTLINE_WIDTH,
  RADIUS,
} from "../../classes/environment/ui/tokens.ts";
import type { PreviewSceneProps } from "./index.ts";

type SampleToast = {
  id: number;
  source: string;
  title: string;
  content: string;
  tone: "info" | "warning" | "error";
};

const INITIAL_TOASTS: SampleToast[] = [
  {
    id: 1,
    source: "PetPlay",
    title: "Layout 1 loaded",
    content: "2 displays restored to saved positions.",
    tone: "info",
  },
  {
    id: 2,
    source: "Battery",
    title: "Left controller battery low",
    content: "12%",
    tone: "warning",
  },
  {
    id: 3,
    source: "Display Host",
    title: "Screen capture interrupted",
    content: "Reconnecting to portal session…",
    tone: "error",
  },
];

function toneBorder(tone: SampleToast["tone"]): string {
  return tone === "error" ? COLOR.danger : tone === "warning" ? COLOR.accent : COLOR.outline;
}

const CONTEXT_ACTIONS: ReadonlyArray<{ id: string; icon: IconName; label: string; danger?: boolean }> = [
  { id: "add", icon: "add", label: "Add display" },
  { id: "link", icon: "link", label: "Attach / detach" },
  { id: "lock", icon: "lock", label: "Lock pose" },
  { id: "reset", icon: "refresh", label: "Reset" },
  { id: "settings", icon: "settings", label: "Settings" },
  { id: "delete", icon: "delete", label: "Delete", danger: true },
];

export function ToastsScene({ stageCenter, scale }: PreviewSceneProps) {
  const [toasts, setToasts] = useState<SampleToast[]>(INITIAL_TOASTS);
  const [nextId, setNextId] = useState(4);
  const [activeActions, setActiveActions] = useState<Record<string, boolean>>({ link: true });
  const [hoveredAction, setHoveredAction] = useState<string | null>(null);

  const pushSample = (tone: SampleToast["tone"]) => {
    const id = nextId;
    setNextId((n) => n + 1);
    const entry: SampleToast = tone === "info"
      ? { id, source: "Discord", title: "New message", content: "Are you hopping into VRChat?", tone }
      : tone === "warning"
      ? { id, source: "OSC", title: "Camera tracker paused", content: "Move the camera to resume fit.", tone }
      : { id, source: "OpenVR", title: "Overlay submit failed", content: "Retrying texture upload…", tone };
    setToasts((prev) => [entry, ...prev].slice(0, 4));
  };

  return (
    <group position={[stageCenter[0], stageCenter[1], 10]} scale={[scale, scale, 1]}>
      <Container pixelSize={1} flexDirection="column" alignItems="center" gap={28}>
        {/* Contextual toolbar mockup */}
        <Container
          padding={GAP}
          borderRadius={RADIUS.tile}
          backgroundColor={COLOR.ground}
          backgroundOpacity={1}
          flexDirection="column"
          alignItems="center"
          gap={INNER_GAP}
        >
          <Container flexDirection="row" alignItems="center" gap={INNER_GAP}>
            <Text color={COLOR.inkDim} fontSize={12}>DISPLAY 1 · CONTEXTUAL TOOLBAR</Text>
            {hoveredAction && <Text color={COLOR.accent} fontSize={12}>· {hoveredAction}</Text>}
          </Container>
          <Container flexDirection="row" alignItems="center" gap={INNER_GAP}>
            {CONTEXT_ACTIONS.map((act) => {
              const active = !!activeActions[act.id];
              const size = 52;
              return (
                <Container
                  key={act.id}
                  width={size}
                  height={size}
                  borderRadius={clampRadius(999, size, size)}
                  alignItems="center"
                  justifyContent="center"
                  backgroundColor={act.danger ? COLOR.danger : active ? COLOR.accent : COLOR.tile}
                  backgroundOpacity={act.danger || active ? 1 : 0}
                  borderWidth={act.danger || active ? 0 : OUTLINE_WIDTH}
                  borderColor={COLOR.outline}
                  onPointerOver={() => setHoveredAction(act.label)}
                  onPointerOut={() => setHoveredAction((cur) => cur === act.label ? null : cur)}
                  onClick={() =>
                    setActiveActions((prev) => ({ ...prev, [act.id]: !prev[act.id] }))}
                >
                  <Icon
                    name={act.icon}
                    size={22}
                    color={act.danger ? COLOR.onDanger : active ? COLOR.onAccent : COLOR.ink}
                  />
                </Container>
              );
            })}
          </Container>
        </Container>

        {/* Trigger controls */}
        <Container flexDirection="row" gap={10}>
          <Pill slots={2} units={2} tone="outline" onClick={() => pushSample("info")}>
            + INFO
          </Pill>
          <Pill slots={2} units={2} tone="accent" onClick={() => pushSample("warning")}>
            + WARNING
          </Pill>
          <Pill slots={2} units={2} tone="danger" onClick={() => pushSample("error")}>
            + ERROR
          </Pill>
        </Container>

        {/* Toast stack */}
        <Container flexDirection="column" alignItems="center" gap={10}>
          {toasts.map((toast) => (
            <Container
              key={toast.id}
              width={480}
              flexDirection="column"
              gap={4}
              paddingX={20}
              paddingY={14}
              borderRadius={22}
              backgroundColor={COLOR.ground}
              backgroundOpacity={0.94}
              borderWidth={OUTLINE_WIDTH}
              borderColor={toneBorder(toast.tone)}
              onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
            >
              <Text color={COLOR.inkDim} fontSize={14}>{toast.source} · click to dismiss</Text>
              <Text color={COLOR.ink} fontSize={20}>{toast.title}</Text>
              <Text color={COLOR.ink} fontSize={15}>{toast.content}</Text>
            </Container>
          ))}
        </Container>
      </Container>
    </group>
  );
}
