import { useSyncExternalStore } from "react";

type ToolEditListener = () => void;

let toolEditActive = false;
const listeners = new Set<ToolEditListener>();

function emitToolEditChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function setToolEditMode(active: boolean): void {
  if (toolEditActive === active) {
    return;
  }
  toolEditActive = active;
  emitToolEditChange();
}

export function getToolEditMode(): boolean {
  return toolEditActive;
}

export function subscribeToolEditMode(listener: ToolEditListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useToolEditMode(): boolean {
  return useSyncExternalStore(subscribeToolEditMode, getToolEditMode, getToolEditMode);
}
