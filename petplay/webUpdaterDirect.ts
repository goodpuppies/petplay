import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { createStruct, stringToPointer } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";

type ChromeDirectConfig = {
  key: string;
  width: number;
  height: number;
  scale: number;
  url: string;
  exe: string;
  fps: number;
};

const state = actorState({
  name: "webUpdaterDirect",
  overlayHandle: null as bigint | null,
  overlayClass: null as OpenVR.IVROverlay | null,
  isRunning: false as boolean,
  chromedirectProcess: null as Deno.ChildProcess | null,
  config: null as ChromeDirectConfig | null,
});

new PostMan(
  state,
  {
    __INIT__: (_payload: void) => {
    },

    INITOVROVERLAY: (payload: bigint) => {
      const systemPtr = Deno.UnsafePointer.create(payload);
      state.overlayClass = new OpenVR.IVROverlay(systemPtr);
      LogChannel.log("actor", `IVROverlay initialized in ${state.id}`);
    },

    STARTWEBUPDATER: (payload: {
      key?: string;
      width?: number;
      height?: number;
      scale?: number;
      url?: string;
      exe?: string;
      fps?: number;
    }) => {
      // Build config with defaults
      const config: ChromeDirectConfig = {
        key: payload.key || "cef.web.overlay",
        width: payload.width || 4000,
        height: payload.height || 4000,
        scale: payload.scale || 3.0,
        url: payload.url || getDefaultUrl(),
        exe: payload.exe || getDefaultExePath(),
        fps: payload.fps || 60,
      };

      state.config = config;

      LogChannel.log("actor", `Starting WebUpdaterDirect with config:`, config);

      // Initialize overlay and spawn chromedirect
      initializeOverlay();
      spawnChromeDirect();
    },

    STOPWEBUPDATER: (_payload: void) => {
      cleanup();
    },

    GETOVERLAYHANDLE: (_payload: void) => {
      return state.overlayHandle;
    },

    SETURL: (payload: { url: string }) => {
      LogChannel.log("actor", `URL change requested: ${payload.url}`);
      // TODO: Implement URL change via IPC or restart chromedirect
      // For now, this would require restarting the process
      if (state.isRunning && state.config) {
        state.config.url = payload.url;
        restartChromeDirect();
      }
    },
  } as const,
);

function getDefaultUrl(): string {
  const cwd = Deno.cwd();
  const sep = Deno.build.os === "windows" ? "\\" : "/";
  const path = `${cwd}${sep}index.html`;
  const fileUrl = Deno.build.os === "windows"
    ? `file:///${path.replace(/\\/g, "/")}`
    : `file://${path}`;
  return fileUrl;
}

function getDefaultExePath(): string {
  return Deno.build.os === "windows"
    ? ".\\submodules\\chromedirect\\build\\bin\\chromedirect_demo.exe"
    : "./submodules/chromedirect/build/bin/chromedirect_demo";
}

function initializeOverlay() {
  if (!state.overlayClass) {
    throw new Error("IVROverlay not initialized. Call INITOVROVERLAY first.");
  }
  if (!state.config) {
    throw new Error("Config not set");
  }

  const config = state.config;

  // Create overlay
  const overlayHandlePTR = P.BigUint64P<OpenVR.OverlayHandle>();
  const createError = state.overlayClass.CreateOverlay(
    config.key,
    "CEF Web Overlay Direct",
    overlayHandlePTR,
  );

  if (
    createError !== OpenVR.OverlayError.VROverlayError_None &&
    createError !== OpenVR.OverlayError.VROverlayError_KeyInUse
  ) {
    throw new Error(`CreateOverlay failed: ${OpenVR.OverlayError[createError]}`);
  }

  state.overlayHandle = new Deno.UnsafePointerView(overlayHandlePTR).getBigUint64();

  LogChannel.log("actor", `Overlay created: key=${config.key}, handle=${state.overlayHandle}`);

  // Configure overlay as stereo panorama
  state.overlayClass.SetOverlayFlag(
    state.overlayHandle,
    OpenVR.OverlayFlags.VROverlayFlags_Panorama,
    false,
  );
  state.overlayClass.SetOverlayFlag(
    state.overlayHandle,
    OpenVR.OverlayFlags.VROverlayFlags_StereoPanorama,
    true,
  );
  state.overlayClass.SetOverlaySortOrder(state.overlayHandle, 9999);
  state.overlayClass.SetOverlayWidthInMeters(state.overlayHandle, 3);

  // Set transform relative to HMD
  const idTransform: OpenVR.HmdMatrix34 = {
    m: [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, -1],
    ],
  };
  const [transformPtr, _transView] = createStruct<OpenVR.HmdMatrix34>(
    idTransform,
    OpenVR.HmdMatrix34Struct,
  );

  state.overlayClass.SetOverlayTransformTrackedDeviceRelative(
    state.overlayHandle,
    OpenVR.k_unTrackedDeviceIndex_Hmd,
    transformPtr,
  );

  // Set texture bounds
  const bounds = { uMin: 0, uMax: 1, vMin: 0, vMax: 1 };
  const [boundsPtr, _boundsView] = createStruct<OpenVR.TextureBounds>(
    bounds,
    OpenVR.TextureBoundsStruct,
  );
  state.overlayClass.SetOverlayTextureBounds(state.overlayHandle, boundsPtr);

  // Show overlay
  state.overlayClass.ShowOverlay(state.overlayHandle);

  LogChannel.log("actor", `Overlay configured and visible`);
}

function spawnChromeDirect() {
  if (!state.config) {
    throw new Error("Config not set");
  }

  const config = state.config;

  // Build command line arguments for chromedirect
  const args = [
    `--vr-mode=true`,
    `--width=${config.width}`,
    `--height=${config.height}`,
    `--scale=${config.scale}`,
    `--overlay-key=${config.key}`,
    `--url=${config.url}`,
    `--fps=${config.fps}`,
    `--iwer-apply-pose=0`
  ];

  LogChannel.log("actor", `Spawning chromedirect: ${config.exe} ${args.join(" ")}`);

  const cmd = new Deno.Command(config.exe, {
    args: args,
    stdout: "piped",
    stderr: "piped",
  });

  state.chromedirectProcess = cmd.spawn();
  state.isRunning = true;

  // Set overlay rendering PID
  if (state.overlayClass && state.overlayHandle) {
    try {
      state.overlayClass.SetOverlayRenderingPid(
        state.overlayHandle,
        state.chromedirectProcess.pid,
      );
      LogChannel.log("actor", `SetOverlayRenderingPid -> ${state.chromedirectProcess.pid}`);
    } catch (e) {
      LogChannel.log("actor", `Failed to SetOverlayRenderingPid: ${e}`);
    }
  }

  // Pipe stdout
  (async () => {
    if (!state.chromedirectProcess) return;
    const reader = state.chromedirectProcess.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        const text = decoder.decode(value);
        LogChannel.log("chromedirect", text.trim());
      }
    }
  })();

  // Pipe stderr
  (async () => {
    if (!state.chromedirectProcess) return;
    const reader = state.chromedirectProcess.stderr.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        const text = decoder.decode(value);
        LogChannel.log("chromedirect-err", text.trim());
      }
    }
  })();

  // Monitor process status
  (async () => {
    if (!state.chromedirectProcess) return;
    const status = await state.chromedirectProcess.status;
    LogChannel.log(
      "actor",
      `ChromeDirect exited: code=${status.code}, signal=${status.signal ?? "none"}`,
    );
    state.isRunning = false;
    state.chromedirectProcess = null;
  })();
}

function restartChromeDirect() {
  LogChannel.log("actor", "Restarting chromedirect...");
  cleanup(false); // Don't destroy overlay
  spawnChromeDirect();
}

function cleanup(destroyOverlay = true) {
  state.isRunning = false;

  // Kill chromedirect process
  if (state.chromedirectProcess) {
    try {
      state.chromedirectProcess.kill("SIGTERM");
      LogChannel.log("actor", "ChromeDirect process terminated");
    } catch (e) {
      LogChannel.log("actor", `Failed to kill chromedirect: ${e}`);
      try {
        state.chromedirectProcess.kill("SIGKILL");
      } catch { /* ignore */ }
    }
    state.chromedirectProcess = null;
  }

  // Destroy overlay if requested
  if (destroyOverlay && state.overlayClass && state.overlayHandle) {
    try {
      state.overlayClass.DestroyOverlay(state.overlayHandle);
      LogChannel.log("actor", "Overlay destroyed");
    } catch (e) {
      LogChannel.log("actor", `Failed to destroy overlay: ${e}`);
    }
    state.overlayHandle = null;
  }
}

// Handle cleanup on worker termination
globalThis.addEventListener("unload", () => {
  cleanup();
});
