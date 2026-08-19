import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { stringToPointer } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import { getOpenVrLibraryPath } from "../classes/nativeLibraryPaths.ts";

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
  console.log("[petplay boot] OpenVR: loading bindings");
  const success = OpenVR.initializeOpenVR(
    getOpenVrLibraryPath(),
  );
  if (!success) throw new Error("failed to initialize openvr");
  console.log("[petplay boot] OpenVR: calling VR_InitInternal");

  const initErrorPtr = P.Int32P<OpenVR.InitError>();

  OpenVR.VR_InitInternal(
    initErrorPtr,
    OpenVR.ApplicationType.VRApplication_Overlay,
  );
  const initError = new Deno.UnsafePointerView(initErrorPtr).getInt32();
  console.log(
    `[petplay boot] OpenVR: VR_InitInternal returned ${OpenVR.InitError[initError]}`,
  );

  if (initError !== OpenVR.InitError.VRInitError_None) {
    throw new Error(
      `Failed to initialize OpenVR: ${OpenVR.InitError[initError]}`,
    );
  }

  const systemPtr = OpenVR.VR_GetGenericInterface(
    stringToPointer(OpenVR.IVRSystem_Version),
    initErrorPtr,
  );
  const interfaceError1 = new Deno.UnsafePointerView(initErrorPtr).getInt32();
  if (interfaceError1 !== OpenVR.InitError.VRInitError_None) {
    throw new Error(
      `Failed to get IVRSystem interface: ${OpenVR.InitError[interfaceError1]}`,
    );
  }
  console.log("[petplay boot] OpenVR: IVRSystem interface acquired");

  const compositorPtr = OpenVR.VR_GetGenericInterface(
    stringToPointer(OpenVR.IVRCompositor_Version),
    initErrorPtr,
  );
  const interfaceErrorComp = new Deno.UnsafePointerView(initErrorPtr)
    .getInt32();
  if (interfaceErrorComp !== OpenVR.InitError.VRInitError_None) {
    LogChannel.log(
      "actor",
      `OpenVR: IVRCompositor not available (overlay frame pacing will skip CanRenderScene): ${
        OpenVR.InitError[interfaceErrorComp]
      }`,
    );
  }

  const overlayPtr = OpenVR.VR_GetGenericInterface(
    stringToPointer(OpenVR.IVROverlay_Version),
    initErrorPtr,
  );
  {
    const err = new Deno.UnsafePointerView(initErrorPtr).getInt32();
    if (err !== OpenVR.InitError.VRInitError_None) {
      throw new Error(`Failed to get IVROverlay: ${OpenVR.InitError[err]}`);
    }
  }
  const inputPtr = OpenVR.VR_GetGenericInterface(
    stringToPointer(OpenVR.IVRInput_Version),
    initErrorPtr,
  );
  {
    const err = new Deno.UnsafePointerView(initErrorPtr).getInt32();
    if (err !== OpenVR.InitError.VRInitError_None) {
      throw new Error(`Failed to get IVRInput: ${OpenVR.InitError[err]}`);
    }
  }
  const renderModelsPtr = OpenVR.VR_GetGenericInterface(
    stringToPointer(OpenVR.IVRRenderModels_Version),
    initErrorPtr,
  );
  {
    const err = new Deno.UnsafePointerView(initErrorPtr).getInt32();
    if (err !== OpenVR.InitError.VRInitError_None) {
      throw new Error(`Failed to get IVRRenderModels: ${OpenVR.InitError[err]}`);
    }
  }

  state.vrSystemPTR = systemPtr;
  state.compositorPTR = interfaceErrorComp === OpenVR.InitError.VRInitError_None
    ? compositorPtr
    : null;
  state.overlayPTR = overlayPtr;
  state.inputPTR = inputPtr;
  state.renderModelsPTR = renderModelsPtr;

  LogChannel.log(
    "actor",
    "OpenVR initialized and IVRSystem interface acquired.",
  );
}

function shutdownOpenVR() {
  if (OpenVR.isInitialized()) {
    OpenVR.VR_ShutdownInternal();
  }
  state.vrSystemPTR = null;
  state.compositorPTR = null;
  state.overlayPTR = null;
  state.inputPTR = null;
  state.renderModelsPTR = null;
  OpenVR.closeOpenVR();
  LogChannel.log("actor", "OpenVR shutdown complete and library closed.");
}
