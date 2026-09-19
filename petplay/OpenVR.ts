import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import { OpenVrRuntime } from "../classes/openVrRuntime.ts";

const state = actorState({
  name: "openvr",
  sync: false,
  vrSystemPTR: null as Deno.PointerValue | null,
  /** `IVRCompositor` — for overlay-legal display timing (see `openVrOverlayFramePacing.ts`). */
  compositorPTR: null as Deno.PointerValue | null,
  overlayPTR: null as Deno.PointerValue | null,
  inputPTR: null as Deno.PointerValue | null,
  renderModelsPTR: null as Deno.PointerValue | null,
});

const runtime = new OpenVrRuntime("PetPlay OpenVR");

export const api = {
  __INIT__: (_payload: null) => {
    initializeOpenVR();
  },
  __SHUTDOWN__: (payload: { reason?: string } | null) => {
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
    return {
      initialized: state.vrSystemPTR != null && state.overlayPTR != null &&
        state.inputPTR != null,
      vrSystemReady: state.vrSystemPTR != null,
      compositorReady: state.compositorPTR != null,
      overlayReady: state.overlayPTR != null,
      inputReady: state.inputPTR != null,
      renderModelsReady: state.renderModelsPTR != null,
    };
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

function initializeOpenVR() {
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
}

function shutdownOpenVR() {
  runtime.shutdown();
  state.vrSystemPTR = null;
  state.compositorPTR = null;
  state.overlayPTR = null;
  state.inputPTR = null;
  state.renderModelsPTR = null;
  LogChannel.log("actor", "OpenVR actor shutdown complete.");
}
