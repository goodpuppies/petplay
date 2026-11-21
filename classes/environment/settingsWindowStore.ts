/**
 * Open/closed state for the floating VR Settings Window (`settingsWindowOverlay.tsx`).
 * Toggled by the Settings tile on the wrist menu and closed by the window's Close (`×`) button.
 */
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function isSettingsWindowOpen(): boolean {
  return open;
}

export function setSettingsWindowOpen(next: boolean): void {
  if (next === open) return;
  open = next;
  emit();
}

export function toggleSettingsWindow(): void {
  setSettingsWindowOpen(!open);
}

export function useSettingsWindowOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
  );
}
