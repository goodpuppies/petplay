/**
 * Interactive preview of PetPlay's virtual keyboard (`KeyboardFromJson`),
 * with locale (`us` / `fi`) and layout mode (`compact` / `arrows` / `full`) switchers
 * and a local keystroke readout (never injects into the OS).
 */
import React, { useMemo, useState } from "react";
import { Container } from "../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Text } from "../../classes/environment/ui/text.tsx";
import { COLOR } from "../../classes/environment/ui/tokens.ts";
import { getDefaultKeyboardLayoutSync } from "../../classes/environment/keyboard/defaultLayoutPreload.ts";
import { KeyboardFromJson } from "../../classes/environment/keyboard/keyboardUi.tsx";
import type {
  KeyboardLayoutMode,
  KeyboardLocaleId,
  KeyboardLogicEvent,
} from "../../classes/environment/keyboard/types.ts";
import type { PreviewSceneProps } from "./index.ts";

function ModePill(
  { label, active, onClick }: { label: string; active: boolean; onClick: () => void },
) {
  return (
    <Container
      paddingX={10}
      paddingY={5}
      borderRadius={999}
      backgroundColor={active ? COLOR.accent : COLOR.tile}
      backgroundOpacity={1}
      onClick={onClick}
    >
      <Text fontSize={12} color={active ? COLOR.onAccent : COLOR.ink}>{label}</Text>
    </Container>
  );
}

export function KeyboardScene({ stageCenter, scale }: PreviewSceneProps) {
  const layout = useMemo(() => getDefaultKeyboardLayoutSync(), []);
  const [locale, setLocale] = useState<KeyboardLocaleId>("us");
  const [layoutMode, setLayoutMode] = useState<KeyboardLayoutMode>("arrows");
  const [typed, setTyped] = useState("");
  const [lastEvent, setLastEvent] = useState("Click any keycap to test");

  const handleKey = (event: KeyboardLogicEvent) => {
    if (event.kind === "modifier") {
      setLastEvent(`modifier ${event.modifier} -> ${event.active ? "on" : "off"}`);
      return;
    }
    if (event.pressed === false) return;
    if (event.scanCodeHex.toUpperCase() === "0E") {
      setTyped((s) => s.slice(0, -1));
      setLastEvent("Backspace");
      return;
    }
    if (event.scanCodeHex.toUpperCase() === "39") {
      setTyped((s) => (s + " ").slice(-48));
      setLastEvent("Space");
      return;
    }
    if (event.char) {
      setTyped((s) => (s + event.char).slice(-48));
      setLastEvent(`key '${event.char}' (0x${event.scanCodeHex})`);
    } else {
      setLastEvent(`scan 0x${event.scanCodeHex}`);
    }
  };

  return (
    <group position={[stageCenter[0], stageCenter[1], 10]} scale={[scale, scale, 1]}>
      <Container pixelSize={1} flexDirection="column" alignItems="center" gap={18}>
        <Container
          flexDirection="row"
          alignItems="center"
          gap={10}
          paddingX={14}
          paddingY={8}
          borderRadius={14}
          backgroundColor="#1a1d24"
          backgroundOpacity={0.95}
        >
          <Text fontSize={12} color="#8a93a2">Locale:</Text>
          {(["us", "fi"] as const).map((id) => (
            <ModePill key={id} label={id.toUpperCase()} active={locale === id} onClick={() => setLocale(id)} />
          ))}
          <Container width={8} />
          <Text fontSize={12} color="#8a93a2">Mode:</Text>
          {(["compact", "arrows", "full"] as const).map((m) => (
            <ModePill key={m} label={m} active={layoutMode === m} onClick={() => setLayoutMode(m)} />
          ))}
          <Container width={8} />
          <ModePill
            label="Clear"
            active={false}
            onClick={() => {
              setTyped("");
              setLastEvent("Cleared");
            }}
          />
        </Container>

        <Container
          width={680}
          height={42}
          paddingX={16}
          borderRadius={12}
          backgroundColor={COLOR.ground}
          backgroundOpacity={1}
          borderWidth={2}
          borderColor="#333844"
          flexDirection="row"
          alignItems="center"
          justifyContent="space-between"
        >
          <Text fontSize={16} color={COLOR.ink}>
            {typed || "Type on the keys below…"}
          </Text>
          <Text fontSize={12} color={COLOR.inkDim}>{lastEvent}</Text>
        </Container>

        <KeyboardFromJson
          preloadedLayout={layout}
          locale={locale}
          layoutMode={layoutMode}
          pixelSize={0.72}
          onKey={handleKey}
        />
      </Container>
    </group>
  );
}
