/**
 * Dedicated preview scene for the first-class floating Settings Window (`SettingsWindow`).
 */
import React, { useState } from "react";
import { Container } from "../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Text } from "../../classes/environment/ui/text.tsx";
import { COLOR } from "../../classes/environment/ui/tokens.ts";
import {
  SETTINGS_WINDOW_HEIGHT,
  SettingsWindow,
} from "../../classes/environment/ui/settingsWindow.tsx";
import type { PreviewSceneProps } from "./index.ts";

export function SettingsScene({ stageCenter, scale }: PreviewSceneProps) {
  const [showGuides, setShowGuides] = useState(false);
  const [closedNotice, setClosedNotice] = useState(false);

  return (
    <group position={[stageCenter[0], stageCenter[1] + 18, 10]} scale={[scale, scale, 1]}>
      {closedNotice
        ? (
          <Container
            pixelSize={1}
            paddingX={24}
            paddingY={16}
            borderRadius={20}
            backgroundColor={COLOR.ground}
            backgroundOpacity={1}
            flexDirection="row"
            alignItems="center"
            gap={16}
            onClick={() => setClosedNotice(false)}
          >
            <Text color={COLOR.ink} fontSize={20}>Settings window closed</Text>
            <Container
              paddingX={14}
              paddingY={8}
              borderRadius={999}
              backgroundColor={COLOR.accent}
              backgroundOpacity={1}
            >
              <Text color={COLOR.onAccent} fontSize={14}>REOPEN</Text>
            </Container>
          </Container>
        )
        : (
          <SettingsWindow
            showGuides={showGuides}
            onClose={() => setClosedNotice(true)}
          />
        )}

      <group position={[0, -(SETTINGS_WINDOW_HEIGHT / 2) - 34, 10]}>
        <Container
          pixelSize={1}
          flexDirection="row"
          alignItems="center"
          gap={8}
          paddingX={12}
          paddingY={8}
          borderRadius={14}
          backgroundColor="#1a1d24"
          backgroundOpacity={0.95}
        >
          <Container
            paddingX={10}
            paddingY={5}
            borderRadius={999}
            backgroundColor={showGuides ? COLOR.accent : COLOR.tile}
            backgroundOpacity={1}
            onClick={() => setShowGuides((v) => !v)}
          >
            <Text fontSize={12} color={showGuides ? COLOR.onAccent : COLOR.ink}>
              {showGuides ? "Guides: On" : "Guides: Off"}
            </Text>
          </Container>
          <Text fontSize={12} color="#8a93a2">8 × 5 recursive grid (1040 × 656)</Text>
        </Container>
      </group>
    </group>
  );
}
