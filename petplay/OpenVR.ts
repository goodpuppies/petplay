import { PostMan, actorState } from "../submodules/stageforge/mod.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { stringToPointer } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";

const state = actorState({
    name: "openvr",
    sync: false,
    vrSystemPTR: null as Deno.PointerValue | null,
    overlayPTR: null as Deno.PointerValue | null,
    inputPTR: null as Deno.PointerValue | null
});

new PostMan(state, {
    __INIT__: (_payload) => {
        initializeOpenVR();
    },
    GETOPENVRPTR: (_payload) => {
        if (!state.vrSystemPTR) throw new Error("OpenVR system not initialized")
        const ivrsystem = state.vrSystemPTR
        const systemPtrNumeric = Deno.UnsafePointer.value(ivrsystem);
        return systemPtrNumeric
    },
    GETOVERLAYPTR: (_payload) => {
        if (!state.overlayPTR) throw new Error("overlay system not initialized")
        const overlay = state.overlayPTR
        const overlayPtrNumeric = Deno.UnsafePointer.value(overlay);
        return overlayPtrNumeric
    },
    GETINPUTPTR: (_payload) => {
        if (!state.inputPTR) throw new Error("input system not initialized")
        const input = state.inputPTR
        const inputPtrNumeric = Deno.UnsafePointer.value(input);
        return inputPtrNumeric
    }
} as const)

function initializeOpenVR() {

    const success = OpenVR.initializeOpenVR("../resources/openvr_api.dll", import.meta.url);
    if (!success) throw new Error("failed to initialize openvr")

    const initErrorPtr = P.Int32P<OpenVR.InitError>();


    OpenVR.VR_InitInternal(initErrorPtr, OpenVR.ApplicationType.VRApplication_Overlay);
    const initError = new Deno.UnsafePointerView(initErrorPtr).getInt32();

    if (initError !== OpenVR.InitError.VRInitError_None) throw new Error(`Failed to initialize OpenVR: ${OpenVR.InitError[initError]}`)

    const systemPtr = OpenVR.VR_GetGenericInterface(stringToPointer(OpenVR.IVRSystem_Version), initErrorPtr);
    const overlayPtr = OpenVR.VR_GetGenericInterface(stringToPointer(OpenVR.IVROverlay_Version), initErrorPtr);
    const inputPtr = OpenVR.VR_GetGenericInterface(stringToPointer(OpenVR.IVRInput_Version), initErrorPtr);

    const interfaceError = new Deno.UnsafePointerView(initErrorPtr).getInt32();

    if (interfaceError !== OpenVR.InitError.VRInitError_None) throw new Error(`Failed to get IVRSystem interface: ${OpenVR.InitError[interfaceError]}`)

    state.vrSystemPTR = systemPtr
    state.overlayPTR = overlayPtr
    state.inputPTR = inputPtr

    LogChannel.log("actor", "OpenVR initialized and IVRSystem interface acquired.");
}

