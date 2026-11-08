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
  return withWorkspaceCrops(logical);
}

/** Crops each output out of the one frame spanning all of them, most important output first. */
function withWorkspaceCrops(logical: Omit<WorkspaceOutput, "crop">[]): WorkspaceOutput[] {
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

export type WindowsMonitor = {
  deviceName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
};

/** Layouts saved by v0.0.15 are assigned to this id, so the primary monitor keeps it. */
const WINDOWS_PRIMARY_OUTPUT_ID = "windows-capture";

/** Without a monitor list, the captured frame can only be treated as one output. */
const WINDOWS_WHOLE_FRAME_OUTPUT: WorkspaceOutput = {
  id: WINDOWS_PRIMARY_OUTPUT_ID,
  name: "Desktop",
  priority: 0,
  logicalX: 0,
  logicalY: 0,
  logicalWidth: 1,
  logicalHeight: 1,
  crop: { x: 0, y: 0, width: 1, height: 1 },
};

/** The capture helper stitches monitors by desktop position, so these crop that frame. */
export function workspaceOutputsFromWindowsMonitors(monitors: WindowsMonitor[]): WorkspaceOutput[] {
  return withWorkspaceCrops(monitors.map((monitor) => ({
    id: monitor.primary ? WINDOWS_PRIMARY_OUTPUT_ID : monitor.deviceName,
    name: monitor.deviceName.replace(/^\\\\\.\\/, ""),
    priority: monitor.primary ? 1 : 0,
    logicalX: monitor.x,
    logicalY: monitor.y,
    logicalWidth: monitor.width,
    logicalHeight: monitor.height,
  })));
}

const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4n;
const MONITORINFOEXW_SIZE = 104;
const MONITORINFOF_PRIMARY = 1;

function enumerateWindowsMonitors(): WindowsMonitor[] {
  const user32 = Deno.dlopen("user32.dll", {
    EnumDisplayMonitors: {
      parameters: ["pointer", "pointer", "function", "isize"],
      result: "bool",
    },
    GetMonitorInfoW: { parameters: ["pointer", "buffer"], result: "bool" },
    SetThreadDpiAwarenessContext: { parameters: ["isize"], result: "isize" },
  });
  const monitors: WindowsMonitor[] = [];
  const onMonitor = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer", "isize"], result: "bool" },
    (handle) => {
      const info = new Uint8Array(MONITORINFOEXW_SIZE);
      const view = new DataView(info.buffer);
      view.setUint32(0, MONITORINFOEXW_SIZE, true);
      if (user32.symbols.GetMonitorInfoW(handle, info)) {
        const [left, top, right, bottom] = [4, 8, 12, 16].map((at) => view.getInt32(at, true));
        monitors.push({
          deviceName: new TextDecoder("utf-16le").decode(info.subarray(40)).split("\0")[0],
          x: left,
          y: top,
          width: right - left,
          height: bottom - top,
          primary: (view.getUint32(36, true) & MONITORINFOF_PRIMARY) !== 0,
        });
      }
      return true;
    },
  );
  // Physical pixels, like the capture; this process otherwise receives DPI-scaled rectangles.
  const previous = user32.symbols.SetThreadDpiAwarenessContext(
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
  );
  try {
    user32.symbols.EnumDisplayMonitors(null, null, onMonitor.pointer, 0n);
  } finally {
    user32.symbols.SetThreadDpiAwarenessContext(previous);
    onMonitor.close();
    user32.close();
  }
  return monitors;
}

function loadWindowsWorkspaceOutputs(): WorkspaceOutput[] {
  try {
    const outputs = workspaceOutputsFromWindowsMonitors(enumerateWindowsMonitors());
    return outputs.length > 0 ? outputs : [WINDOWS_WHOLE_FRAME_OUTPUT];
  } catch {
    return [WINDOWS_WHOLE_FRAME_OUTPUT];
  }
}

export async function loadWorkspaceOutputs(): Promise<WorkspaceOutput[]> {
  if (Deno.build.os === "windows") return loadWindowsWorkspaceOutputs();
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
