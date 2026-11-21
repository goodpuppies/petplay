/**
 * Interactive PetPlay Design System specimen: showcases color tokens, concentric radii,
 * Pills, Slots, segmented Controls, Tiles, Footer hover tooltips, and Material Icons.
 */
import React, { useState } from "react";
import { Container } from "../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Text } from "../../classes/environment/ui/text.tsx";
import {
  Control,
  Footer,
  Pill,
  Shell,
  Slot,
  SlotRow,
  Tile,
  TileRow,
} from "../../classes/environment/ui/primitives.tsx";
import { Icon, type IconName } from "../../classes/environment/ui/icons.tsx";
import { COLOR, GAP, INNER_GAP, RADIUS } from "../../classes/environment/ui/tokens.ts";
import type { PreviewSceneProps } from "./index.ts";

const SWATCHES: ReadonlyArray<{ name: string; hex: string; ink: string }> = [
  { name: "ground", hex: COLOR.ground, ink: COLOR.ink },
  { name: "tile", hex: COLOR.tile, ink: COLOR.ink },
  { name: "tileHi", hex: COLOR.tileHi, ink: COLOR.ink },
  { name: "ink", hex: COLOR.ink, ink: COLOR.ground },
  { name: "inkDim", hex: COLOR.inkDim, ink: COLOR.ground },
  { name: "accent", hex: COLOR.accent, ink: COLOR.onAccent },
  { name: "accentBright", hex: COLOR.accentBright, ink: COLOR.onAccent },
  { name: "danger", hex: COLOR.danger, ink: COLOR.onDanger },
];

const SAMPLE_ICONS: readonly IconName[] = [
  "layers",
  "tune",
  "desktop_windows",
  "settings",
  "keyboard",
  "music_note",
  "notifications",
  "headset",
  "videogame_asset",
  "battery_full",
  "link",
  "push_pin",
  "lock",
  "refresh",
  "add",
  "delete",
];

export function DesignSystemScene({ stageCenter, scale }: PreviewSceneProps) {
  const [followMode, setFollowMode] = useState<"follow" | "world">("follow");
  const [density, setDensity] = useState<"compact" | "arrows" | "full">("arrows");
  const [activeSlot, setActiveSlot] = useState(0);
  const [lastClick, setLastClick] = useState("Hover any icon or click a control");

  return (
    <group position={[stageCenter[0], stageCenter[1], 10]} scale={[scale, scale, 1]}>
      {/* Left column: live Shell (528px wide) using real primitives */}
      <group position={[-210, 0, 0]} scale={[1000, 1000, 1]}>
        <Shell footer={<Footer>{lastClick}</Footer>}>
          <TileRow>
            <Tile units={4} height={112}>
              <Container flexDirection="row" gap={INNER_GAP} alignItems="center">
                <Pill
                  slots={2}
                  units={2}
                  tone="outline"
                  onClick={() => setLastClick("Clicked outline pill")}
                >
                  OUTLINE
                </Pill>
                <Pill
                  slots={2}
                  units={2}
                  tone="accent"
                  onClick={() => setLastClick("Clicked accent pill")}
                >
                  ACCENT
                </Pill>
                <Pill
                  slots={2}
                  units={2}
                  tone="danger"
                  onClick={() => setLastClick("Clicked danger pill")}
                >
                  DANGER
                </Pill>
                <Pill slots={2} units={2} disabled>
                  DISABLED
                </Pill>
              </Container>
            </Tile>
          </TileRow>

          <TileRow>
            <Tile units={2}>
              <Pill slots={4} units={2} fontSize={14}>SLOTS</Pill>
              <SlotRow>
                {(["layers", "tune", "desktop_windows"] as const).map((icon, idx) => (
                  <Slot
                    key={icon}
                    units={2}
                    active={activeSlot === idx}
                    tooltip={`Slot: ${icon}`}
                    onClick={() => {
                      setActiveSlot(idx);
                      setLastClick(`Selected slot ${icon}`);
                    }}
                  >
                    <Icon
                      name={icon}
                      size={22}
                      color={activeSlot === idx ? COLOR.onAccent : COLOR.ink}
                    />
                  </Slot>
                ))}
                <Slot units={2} disabled tooltip="Disabled slot">
                  <Icon name="lock" size={22} color={COLOR.inkDim} />
                </Slot>
              </SlotRow>
            </Tile>

            <Tile units={2}>
              <Pill slots={4} units={2} fontSize={14}>RADII</Pill>
              <Container flexDirection="row" gap={INNER_GAP} alignItems="center">
                <Text color={COLOR.inkDim} fontSize={12}>
                  shell {RADIUS.shell} · tile {RADIUS.tile} · slot {RADIUS.slot}
                </Text>
              </Container>
            </Tile>
          </TileRow>

          <TileRow>
            <Tile units={4} height={140}>
              <Control
                value={followMode}
                onChange={(next) => {
                  setFollowMode(next);
                  setLastClick(`Toggle -> ${next}`);
                }}
                options={[
                  { value: "follow", label: "FOLLOW HEAD" },
                  { value: "world", label: "WORLD LOCK" },
                ]}
              />
              <Control
                value={density}
                onChange={(next) => {
                  setDensity(next);
                  setLastClick(`Mode -> ${next}`);
                }}
                options={[
                  { value: "compact", label: "COMPACT" },
                  { value: "arrows", label: "ARROWS" },
                  { value: "full", label: "FULL" },
                ]}
              />
            </Tile>
          </TileRow>
        </Shell>
      </group>

      {/* Right column: tokens, palette, and icon specimen (380px wide) */}
      <group position={[270, 0, 0]}>
        <Container
          pixelSize={1}
          width={380}
          padding={GAP}
          borderRadius={28}
          backgroundColor="#0d0f13"
          backgroundOpacity={1}
          flexDirection="column"
          gap={16}
        >
          <Text color={COLOR.ink} fontSize={16}>COLOR TOKENS</Text>
          <Container flexDirection="row" flexWrap="wrap" gap={8}>
            {SWATCHES.map((s) => (
              <Container
                key={s.name}
                width={168}
                height={38}
                paddingX={12}
                borderRadius={12}
                backgroundColor={s.hex}
                backgroundOpacity={1}
                borderWidth={s.hex === COLOR.ground ? 2 : 0}
                borderColor="#333844"
                flexDirection="row"
                alignItems="center"
                justifyContent="space-between"
              >
                <Text color={s.ink} fontSize={12}>{s.name}</Text>
                <Text color={s.ink} fontSize={11}>{s.hex}</Text>
              </Container>
            ))}
          </Container>

          <Text color={COLOR.ink} fontSize={16}>ICONS (MSDF ATLAS)</Text>
          <Container flexDirection="row" flexWrap="wrap" gap={8}>
            {SAMPLE_ICONS.map((name) => (
              <Container
                key={name}
                width={40}
                height={40}
                borderRadius={12}
                backgroundColor={COLOR.tile}
                backgroundOpacity={1}
                alignItems="center"
                justifyContent="center"
                onClick={() => setLastClick(`Icon: ${name}`)}
              >
                <Icon name={name} size={20} color={COLOR.ink} />
              </Container>
            ))}
          </Container>
        </Container>
      </group>
    </group>
  );
}
