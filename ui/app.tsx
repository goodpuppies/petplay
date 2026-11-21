/**
 * The PetPlay UI Preview Studio app, running inside the headless `BrowserTab`
 * (`rdp/classes/browserTab.ts`) and streamed to the browser via raythree IR.
 *
 * Provides a top toolbar for switching scenes, adjusting zoom (Fit / manual), and cycling
 * backdrop tones, with the active PetPlay UI scene centered below.
 */
import React, { useState } from "react";
import { Container, Text } from "../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { TabBody, useTabSize } from "../rdp/classes/browserTab.ts";
import { DEFAULT_SCENE_ID, findScene, SCENES } from "./scenes/index.ts";

export const TOOLBAR_HEIGHT = 48;

export const BACKGROUNDS = [
  { id: "dark", label: "Dark", color: "#15171c" },
  { id: "slate", label: "Slate", color: "#28303d" },
  { id: "light", label: "Light", color: "#d7dce5" },
] as const;

export type UiStudioAppProps = {
  sceneId?: string;
  onSceneChange?: (id: string) => void;
  onBackgroundChange?: (hex: string) => void;
};

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function ToolbarButton(
  { label, active = false, onClick }: { label: string; active?: boolean; onClick: () => void },
) {
  return (
    <Container
      paddingX={10}
      paddingY={5}
      borderRadius={8}
      backgroundColor={active ? "#ffc300" : "#2a2f39"}
      backgroundOpacity={1}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <Text fontSize={13} color={active ? "#000000" : "#d0d6e0"}>{label}</Text>
    </Container>
  );
}

export function UiStudioApp({
  sceneId: controlledScene,
  onSceneChange,
  onBackgroundChange,
}: UiStudioAppProps) {
  const tab = useTabSize();
  const [localScene, setLocalScene] = useState(controlledScene ?? DEFAULT_SCENE_ID);
  const [zoomMode, setZoomMode] = useState<"fit" | number>("fit");
  const [bgIndex, setBgIndex] = useState(0);

  const activeId = controlledScene ?? localScene;
  const activeScene = findScene(activeId);
  const bg = BACKGROUNDS[bgIndex];

  const stageWidth = tab.width;
  const stageHeight = Math.max(1, tab.height - TOOLBAR_HEIGHT);
  const fitScale = Math.min(
    (stageWidth - 48) / activeScene.naturalSize[0],
    (stageHeight - 48) / activeScene.naturalSize[1],
    1.35,
  );
  const scale = zoomMode === "fit" ? Math.max(0.35, fitScale) : zoomMode;

  const selectScene = (id: string) => {
    setLocalScene(id);
    setZoomMode("fit");
    onSceneChange?.(id);
  };

  const stepZoom = (dir: -1 | 1) => {
    const current = scale;
    const next = dir > 0
      ? ZOOM_STEPS.find((z) => z > current + 0.04) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
      : [...ZOOM_STEPS].reverse().find((z) => z < current - 0.04) ?? ZOOM_STEPS[0];
    setZoomMode(next);
  };

  const cycleBg = () => {
    const next = (bgIndex + 1) % BACKGROUNDS.length;
    setBgIndex(next);
    onBackgroundChange?.(BACKGROUNDS[next].color);
  };

  const SceneComponent = activeScene.Component;

  return (
    <>
      {/* Keep the studio toolbar above every scene (scenes render at z = 10..20) so zooming never covers it. */}
      <group position={[0, 0, 200]}>
        <TabBody flexDirection="column">
          <Container
            height={TOOLBAR_HEIGHT}
            flexShrink={0}
            flexDirection="row"
            alignItems="center"
            paddingX={14}
            gap={8}
            backgroundColor="#1b1f27"
            backgroundOpacity={1}
          >
            <Text fontSize={15} color="#ffc300">PetPlay UI</Text>
            <Container width={8} />
            {SCENES.map((scene) => (
              <ToolbarButton
                key={scene.id}
                label={scene.label}
                active={scene.id === activeScene.id}
                onClick={() => selectScene(scene.id)}
              />
            ))}
            <Container flexGrow={1} />
            <ToolbarButton label="-" onClick={() => stepZoom(-1)} />
            <ToolbarButton
              label={zoomMode === "fit" ? `Fit (${Math.round(scale * 100)}%)` : `${Math.round(scale * 100)}%`}
              active={zoomMode === "fit"}
              onClick={() => setZoomMode(zoomMode === "fit" ? 1 : "fit")}
            />
            <ToolbarButton label="+" onClick={() => stepZoom(1)} />
            <ToolbarButton label={`BG: ${bg.label}`} onClick={cycleBg} />
          </Container>
        </TabBody>
      </group>

      <SceneComponent
        stageCenter={[0, -TOOLBAR_HEIGHT / 2]}
        stageWidth={stageWidth}
        stageHeight={stageHeight}
        scale={scale}
      />
    </>
  );
}
