import { useSyncExternalStore } from "react";

export type WorkspaceLayoutOutput = {
  id: string;
  name: string;
  assignedDisplayId: string | null;
};

export type WorkspaceLayoutDisplay = {
  id: string;
  ordinal: number;
  root: boolean;
  outputId: string | null;
  outputName: string | null;
};

export type WorkspaceLayoutSnapshot = {
  outputs: WorkspaceLayoutOutput[];
  displays: WorkspaceLayoutDisplay[];
};

type WorkspaceLayoutActions = {
  assignOutput: (displayId: string, outputId: string) => void;
  addOutput: (outputId: string) => void;
};

let snapshot: WorkspaceLayoutSnapshot = { outputs: [], displays: [] };
let actions: WorkspaceLayoutActions | null = null;
const listeners = new Set<() => void>();

export function publishWorkspaceLayout(next: WorkspaceLayoutSnapshot): void {
  if (JSON.stringify(snapshot) === JSON.stringify(next)) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export function registerWorkspaceLayoutActions(next: WorkspaceLayoutActions): () => void {
  actions = next;
  return () => {
    if (actions === next) actions = null;
  };
}

export function assignWorkspaceLayoutOutput(displayId: string, outputId: string): void {
  actions?.assignOutput(displayId, outputId);
}

export function addWorkspaceLayoutOutput(outputId: string): void {
  actions?.addOutput(outputId);
}

export function useWorkspaceLayoutSnapshot(): WorkspaceLayoutSnapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
}
