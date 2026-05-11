import { useSyncExternalStore } from "react";

type ControllerLaserListener = () => void;

let controllerLaserEnabled = true;
const listeners = new Set<ControllerLaserListener>();

function emitControllerLaserChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function setControllerLaserEnabled(enabled: boolean): void {
  if (controllerLaserEnabled === enabled) {
    return;
  }
  controllerLaserEnabled = enabled;
  emitControllerLaserChange();
}

export function getControllerLaserEnabled(): boolean {
  return controllerLaserEnabled;
}

export function subscribeControllerLaserEnabled(listener: ControllerLaserListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useControllerLaserEnabled(): boolean {
  return useSyncExternalStore(
    subscribeControllerLaserEnabled,
    getControllerLaserEnabled,
    getControllerLaserEnabled,
  );
}
