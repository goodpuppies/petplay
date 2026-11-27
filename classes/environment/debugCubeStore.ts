/**
 * The debug test cubes (`debugTestCube.tsx`), switched from Settings → Debug. Not persisted: a
 * debugging aid should not come back after a restart.
 *
 * `layer` draws a cube into the eye image like the rest of the 3D scene; `native` shows one on a
 * stereo SteamVR quad (docs/NATIVE_OVERLAYS.md); `both` puts them side by side to compare.
 */
import { useSyncExternalStore } from "react";

export type DebugCubeMode = "off" | "layer" | "native" | "both";

let snapshot: { mode: DebugCubeMode; placement: number } = { mode: "off", placement: 0 };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getDebugCubeMode(): DebugCubeMode {
  return snapshot.mode;
}

export function setDebugCubeMode(mode: DebugCubeMode): void {
  if (mode === snapshot.mode) return;
  // Switching on places the cubes in front of the head again.
  snapshot = {
    mode,
    placement: snapshot.mode === "off" ? snapshot.placement + 1 : snapshot.placement,
  };
  emit();
}

/** Bring the cubes back in front of the head. */
export function placeDebugCubes(): void {
  snapshot = { ...snapshot, placement: snapshot.placement + 1 };
  emit();
}

export function useDebugCube(): { mode: DebugCubeMode; placement: number } {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}
