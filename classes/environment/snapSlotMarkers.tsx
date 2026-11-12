/**
 * Edit layout mode: where a display's snap slots are, and which kinds of node each one snaps.
 *
 * Each slot (`SpatialGraph.hitboxes`, owned by a display) draws as a translucent box with one pill
 * per kind it accepts. Clicking a pill toggles that kind for that slot: accent snaps, outline does
 * not ({@link setHitboxKindEnabled}). Turning a slot off leaves anything already attached there.
 *
 * Rendered inside the owner's node group, which is the frame slot transforms are in.
 */
import React from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { Container } from "../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Pill } from "./ui/primitives.tsx";
import { COLOR, INNER_GAP, RADIUS } from "./ui/tokens.ts";
import {
  isHitboxKindEnabled,
  setHitboxKindEnabled,
  type SpatialGraph,
  type SpatialHitbox,
  type SpatialNode,
  type SpatialNodeId,
} from "./spatialGraph.ts";
import { useToolEditMode } from "./toolEditMode.ts";

const KIND_LABEL: Record<SpatialNode["kind"], string> = {
  display: "DISPLAY",
  keyboard: "KEYBOARD",
  control: "CONTROL",
};

/** Above the display surface (1), the keyboard and toolbars (20), so a click reaches the pill. */
const SNAP_PILL_POINTER_EVENTS_ORDER = 30;
const SLOT_ENABLED_COLOR = 0x5ec8ff;
const SLOT_DISABLED_COLOR = 0x888888;

export function SnapSlotMarkers(
  { graph, ownerId, setGraph }: {
    graph: SpatialGraph;
    ownerId: SpatialNodeId;
    setGraph: React.Dispatch<React.SetStateAction<SpatialGraph>>;
  },
) {
  const editing = useToolEditMode();
  if (!editing) return null;
  const slots = Object.values(graph.hitboxes).filter((slot) => slot.ownerId === ownerId);
  return (
    <>
      {slots.map((slot) => <SnapSlotMarker key={slot.id} slot={slot} setGraph={setGraph} />)}
    </>
  );
}

function SnapSlotMarker(
  { slot, setGraph }: {
    slot: SpatialHitbox;
    setGraph: React.Dispatch<React.SetStateAction<SpatialGraph>>;
  },
) {
  const { position, rotation, scale } = slot.localTransform;
  const anyEnabled = slot.accepts.some((kind) => isHitboxKindEnabled(slot, kind));
  return (
    <group position={position} rotation={rotation} scale={scale}>
      <mesh
        renderOrder={-50}
        userData={{ snapSlotMarker: slot.id }}
        {...({ pointerEvents: "none" } as Record<string, unknown>)}
      >
        <boxGeometry args={slot.size} />
        <meshBasicMaterial
          color={anyEnabled ? SLOT_ENABLED_COLOR : SLOT_DISABLED_COLOR}
          transparent
          opacity={anyEnabled ? 0.16 : 0.06}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      <group
        position={[0, 0, slot.size[2] / 2 + 0.005]}
        {...({ pointerEventsOrder: SNAP_PILL_POINTER_EVENTS_ORDER } as Record<string, unknown>)}
      >
        <Container
          pixelSize={0.001}
          flexDirection="row"
          gap={INNER_GAP}
          padding={INNER_GAP}
          borderRadius={RADIUS.shell}
          backgroundColor={COLOR.ground}
          backgroundOpacity={0.85}
        >
          {slot.accepts.map((kind) => {
            const enabled = isHitboxKindEnabled(slot, kind);
            return (
              <Pill
                key={kind}
                slots={2}
                units={1}
                fontSize={12}
                tone={enabled ? "accent" : "outline"}
                onClick={() =>
                  setGraph((graph) => setHitboxKindEnabled(graph, slot.id, kind, !enabled))}
              >
                {KIND_LABEL[kind]}
              </Pill>
            );
          })}
        </Container>
      </group>
    </group>
  );
}
