import { useSyncExternalStore } from "react";

let visible = false;
const listeners = new Set<() => void>();

export function setWindowLayerVisible(nextVisible: boolean): void {
  if (visible === nextVisible) return;
  visible = nextVisible;
  for (const listener of listeners) listener();
}

export function getWindowLayerVisible(): boolean {
  return visible;
}

export function useWindowLayerVisible(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getWindowLayerVisible,
    getWindowLayerVisible,
  );
}
