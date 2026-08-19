import { useSyncExternalStore } from "react";

let offset = 0;
const listeners = new Set<() => void>();

export function cycleWorkspaceOutputOrder(): void {
  offset++;
  for (const listener of listeners) listener();
}

export function useWorkspaceOutputOrder(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => offset,
    () => offset,
  );
}
