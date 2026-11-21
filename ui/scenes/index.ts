/**
 * Registry of preview scenes available in the PetPlay UI web studio.
 * Add new design system mockups or component experiments here.
 */
import type React from "react";
import { WristMenuScene } from "./wristMenu.tsx";
import { SettingsScene } from "./settings.tsx";
import { DisplayMenuScene } from "./displayMenu.tsx";
import { RecursiveGridScene } from "./recursiveGrid.tsx";
import { DesignSystemScene } from "./designSystem.tsx";
import { KeyboardScene } from "./keyboard.tsx";
import { ToastsScene } from "./toasts.tsx";

export type PreviewSceneProps = {
  /** Center of the canvas area below the studio toolbar, in orthographic world units (CSS px). */
  stageCenter: [number, number];
  /** Available canvas area size below the studio toolbar, in CSS px. */
  stageWidth: number;
  stageHeight: number;
  /** Resolved scale factor (auto-fit or manual zoom). */
  scale: number;
};

export type PreviewSceneEntry = {
  id: string;
  label: string;
  /** Natural bounding size in CSS px, used for "Fit" zoom calculation. */
  naturalSize: [number, number];
  Component: React.ComponentType<PreviewSceneProps>;
};

export const SCENES: readonly PreviewSceneEntry[] = [
  {
    id: "wrist",
    label: "Wrist Menu",
    naturalSize: [560, 620],
    Component: WristMenuScene,
  },
  {
    id: "settings",
    label: "Settings",
    naturalSize: [1080, 740],
    Component: SettingsScene,
  },
  {
    id: "display",
    label: "Display Menu",
    naturalSize: [960, 680],
    Component: DisplayMenuScene,
  },
  {
    id: "grid",
    label: "Recursive Grid",
    naturalSize: [1040, 620],
    Component: RecursiveGridScene,
  },
  {
    id: "design",
    label: "Design System",
    naturalSize: [960, 580],
    Component: DesignSystemScene,
  },
  {
    id: "keyboard",
    label: "Keyboard",
    naturalSize: [920, 440],
    Component: KeyboardScene,
  },
  {
    id: "toasts",
    label: "Toasts & Bar",
    naturalSize: [540, 620],
    Component: ToastsScene,
  },
];

export const DEFAULT_SCENE_ID = SCENES[0].id;

export function findScene(id: string | undefined): PreviewSceneEntry {
  return SCENES.find((s) => s.id === id) ?? SCENES[0];
}
