import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import { type OpenVrPresence, OpenVrRuntime } from "../classes/openVrRuntime.ts";
import { wait } from "../classes/utils.ts";

/**
 * SteamVR-facing actor — the process-local owner of the OpenVR client runtime.
 *
 * It never fails to load: `__INIT__` attempts the runtime and records why it is
 * missing, so `main` can supervise — boot into the desktop view, poll `TRYINIT`
 * until SteamVR appears, and `RELEASE` when it goes away. The pointers it hands
 * out (`GETOPENVRPTR`, …) still throw while there is no runtime, so a dependant
 * wired too early fails loudly instead of touching a null interface.
 */
const state = actorState({
  name: "openvr",
  sync: false,
  vrSystemPTR: null as Deno.PointerValue | null,
  /** `IVRCompositor` — for overlay-legal display timing (see `openVrOverlayFramePacing.ts`). */
  compositorPTR: null as Deno.PointerValue | null,
  overlayPTR: null as Deno.PointerValue | null,
  inputPTR: null as Deno.PointerValue | null,
  renderModelsPTR: null as Deno.PointerValue | null,
  /** Last `VR_InitInternal`/interface failure; cleared once the runtime is up. */
  initError: null as string | null,
  initAttempts: 0,
  /** SteamVR asked the client to quit/restart; the runtime is unusable from here. */
  runtimeQuit: false,
  /** Last `VR_IsRuntimeInstalled`/`VR_IsHmdPresent` probe, for diagnostics. */
  presence: null as OpenVrPresence | null,
  watchRunning: false,
});

const runtime = new OpenVrRuntime("PetPlay OpenVR");

/** SteamVR shutdown events are the only signal that arrives *before* calls start failing. */
const RUNTIME_WATCH_INTERVAL_MS = 500;

export const api = {
  __INIT__: (_payload: null) => {
    attemptInitialize();
    startRuntimeWatch();
  },
  __SHUTDOWN__: (payload: { reason?: string } | null) => {
    state.watchRunning = false;
    if (Deno.build.os === "linux" && payload?.reason === "process-exit") {
      // Keep both the runtime and DynamicLibrary alive while other workers'
      // generated OpenVR-facing wrappers remain reachable. Stress testing
      // shows VR_ShutdownInternal itself can race that retained native state;
      // Deno/OS process teardown safely releases both after module graphs die.
      state.vrSystemPTR = null;
      state.compositorPTR = null;
      state.overlayPTR = null;
      state.inputPTR = null;
      state.renderModelsPTR = null;
      LogChannel.log(
        "actor",
        "OpenVR runtime/library release deferred to OS process teardown on Linux.",
      );
      return;
    }
    shutdownOpenVR();
  },
  __HEALTH__: (_payload: unknown) => {
    return getOpenVrStatus();
  },
  /**
   * Idempotent init attempt for a supervisor: succeeds once SteamVR is running,
   * reports the failure instead of throwing while it is not.
   */
  TRYINIT: (_payload: unknown) => {
    attemptInitialize();
    return getOpenVrStatus();
  },
  /**
   * Despawn side of a SteamVR shutdown: drop the client runtime so a later
   * `TRYINIT` can initialize a fresh one. Only call it once every dependant has
   * stopped using the interfaces — their vtables die with `VR_ShutdownInternal`.
   */
  RELEASE: (_payload: unknown) => {
    shutdownOpenVR();
    return getOpenVrStatus();
  },
  GETOPENVRPTR: (_payload: null) => {
    if (!state.vrSystemPTR) throw new Error("OpenVR system not initialized");
    const ivrsystem = state.vrSystemPTR;
    const systemPtrNumeric = Deno.UnsafePointer.value(ivrsystem);
    return systemPtrNumeric;
  },
  GETOVERLAYPTR: (_payload: null) => {
    if (!state.overlayPTR) throw new Error("overlay system not initialized");
    const overlay = state.overlayPTR;
    const overlayPtrNumeric = Deno.UnsafePointer.value(overlay);
    return overlayPtrNumeric;
  },
  GETINPUTPTR: (_payload: null) => {
    if (!state.inputPTR) throw new Error("input system not initialized");
    const input = state.inputPTR;
    const inputPtrNumeric = Deno.UnsafePointer.value(input);
    return inputPtrNumeric;
  },
  GETCOMPOSITORPTR: (_payload: null): bigint | null => {
    if (!state.compositorPTR) {
      return null;
    }
    return Deno.UnsafePointer.value(state.compositorPTR);
  },
  GETRENDERMODELSPTR: (_payload: null) => {
    if (!state.renderModelsPTR) throw new Error("render models system not initialized");
    return Deno.UnsafePointer.value(state.renderModelsPTR);
  },
} as const;

new PostMan(state, api);

function getOpenVrStatus() {
  const ready = state.vrSystemPTR != null && state.overlayPTR != null &&
    state.inputPTR != null && state.renderModelsPTR != null;
  return {
    ready,
    initialized: ready,
    vrSystemReady: state.vrSystemPTR != null,
    compositorReady: state.compositorPTR != null,
    overlayReady: state.overlayPTR != null,
    inputReady: state.inputPTR != null,
    renderModelsReady: state.renderModelsPTR != null,
    runtimeQuit: state.runtimeQuit,
    initError: state.initError,
    initAttempts: state.initAttempts,
    presence: state.presence,
  };
}

function attemptInitialize(): void {
  if (state.vrSystemPTR != null) return;
  state.initAttempts += 1;
  try {
    const pointers = runtime.initialize({
      system: "required",
      compositor: "optional",
      overlay: "required",
      input: "required",
      renderModels: "required",
    });
    state.vrSystemPTR = pointers.system;
    state.compositorPTR = pointers.compositor;
    state.overlayPTR = pointers.overlay;
    state.inputPTR = pointers.input;
    state.renderModelsPTR = pointers.renderModels;
    state.initError = null;
    state.runtimeQuit = false;
    state.presence = runtime.probePresence();
    LogChannel.log(
      "actor",
      `OpenVR runtime ready (attempt ${state.initAttempts}, compositor=${state.compositorPTR != null})`,
    );
  } catch (error) {
    state.initError = error instanceof Error ? error.message : String(error);
    // The library stays loaded after a failed init, so probing is cheap and
    // tells an operator whether SteamVR is missing or merely not started.
    state.presence = runtime.probePresence();
    LogChannel.log(
      "actor",
      `OpenVR runtime unavailable (attempt ${state.initAttempts}): ${state.initError}`,
    );
  }
}

function shutdownOpenVR(): void {
  state.watchRunning = false;
  runtime.shutdown();
  state.vrSystemPTR = null;
  state.compositorPTR = null;
  state.overlayPTR = null;
  state.inputPTR = null;
  state.renderModelsPTR = null;
  state.initError = null;
  state.runtimeQuit = false;
  LogChannel.log("actor", "OpenVR actor released the client runtime.");
}

/**
 * Drain `IVRSystem` events while the runtime is up. `VREvent_Quit` (and the
 * driver/restart variants) is the polite warning SteamVR sends before calls
 * start failing, so the supervisor can detach in dependency order.
 */
function startRuntimeWatch(): void {
  if (state.watchRunning) return;
  state.watchRunning = true;
  void (async () => {
    try {
      while (state.watchRunning) {
        if (state.vrSystemPTR != null && !state.runtimeQuit) {
          const events = runtime.pollRuntimeEvents();
          if (events.exiting) {
            state.runtimeQuit = true;
            LogChannel.log(
              "actor",
              `OpenVR runtime is exiting (event ${events.exitEventType}, ${events.handled} event(s) drained)`,
            );
          }
        }
        await wait(RUNTIME_WATCH_INTERVAL_MS);
      }
    } finally {
      state.watchRunning = false;
    }
  })();
}
