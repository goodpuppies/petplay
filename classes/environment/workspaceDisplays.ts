export type WorkspaceRect = {
  /** Normalized against the complete captured workspace. */
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WorkspaceOutput = {
  id: string;
  name: string;
  priority: number;
  logicalX: number;
  logicalY: number;
  logicalWidth: number;
  logicalHeight: number;
  crop: WorkspaceRect;
};

type KscreenOutput = {
  id?: string | number;
  name?: string;
  enabled?: boolean;
  connected?: boolean;
  priority?: number;
  scale?: number;
  rotation?: number;
  pos?: { x?: number; y?: number };
  size?: { width?: number; height?: number };
};

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Convert KDE output geometry into crops over one Full Workspace capture. */
export function workspaceOutputsFromKscreen(value: unknown): WorkspaceOutput[] {
  const outputs = (value as { outputs?: KscreenOutput[] } | null)?.outputs ?? [];
  const logical = outputs.flatMap((output, index) => {
    if (output.enabled !== true || output.connected !== true) return [];
    const scale = Math.max(0.01, finite(output.scale, 1));
    let width = finite(output.size?.width) / scale;
    let height = finite(output.size?.height) / scale;
    // KScreen rotations 2 and 8 are the quarter-turn orientations.
    if (output.rotation === 2 || output.rotation === 8) [width, height] = [height, width];
    if (width <= 0 || height <= 0) return [];
    return [{
      id: String(output.id ?? output.name ?? index),
      name: output.name ?? `Display ${output.id ?? index + 1}`,
      priority: finite(output.priority),
      logicalX: finite(output.pos?.x),
      logicalY: finite(output.pos?.y),
      logicalWidth: width,
      logicalHeight: height,
    }];
  });
  if (logical.length === 0) return [];

  const left = Math.min(...logical.map((output) => output.logicalX));
  const top = Math.min(...logical.map((output) => output.logicalY));
  const right = Math.max(...logical.map((output) => output.logicalX + output.logicalWidth));
  const bottom = Math.max(...logical.map((output) => output.logicalY + output.logicalHeight));
  const workspaceWidth = Math.max(1, right - left);
  const workspaceHeight = Math.max(1, bottom - top);

  return logical
    .map((output) => ({
      ...output,
      crop: {
        x: (output.logicalX - left) / workspaceWidth,
        y: (output.logicalY - top) / workspaceHeight,
        width: output.logicalWidth / workspaceWidth,
        height: output.logicalHeight / workspaceHeight,
      },
    }))
    .sort((a, b) => b.priority - a.priority || a.logicalX - b.logicalX || a.logicalY - b.logicalY);
}

export async function loadKdeWorkspaceOutputs(): Promise<WorkspaceOutput[]> {
  if (Deno.build.os !== "linux") return [];
  try {
    const result = await new Deno.Command("kscreen-doctor", {
      args: ["-j"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!result.success) return [];
    return workspaceOutputsFromKscreen(JSON.parse(new TextDecoder().decode(result.stdout)));
  } catch {
    return [];
  }
}
