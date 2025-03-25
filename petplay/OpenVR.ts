import { PostMan } from "../submodules/stageforge/mod.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { stringToPointer } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { CustomLogger } from "../classes/customlogger.ts";

const state = {
    name: "openvr",
    sync: false,
    vrSystemPTR: null as Deno.PointerValue | null,
    overlayPTR: null as Deno.PointerValue | null,
};

new PostMan(state, {
    CUSTOMINIT: (_payload) => {
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
    }
} as const)

async function initializeOpenVR() {

    const success = await OpenVR.initializeOpenVR("../resources/openvr_api");
    if (!success) throw new Error("failed to initialize openvr")

    const initErrorPtr = P.Int32P<OpenVR.InitError>();
    OpenVR.VR_InitInternal(initErrorPtr, OpenVR.ApplicationType.VRApplication_Overlay);
    const initError = new Deno.UnsafePointerView(initErrorPtr).getInt32();

    if (initError !== OpenVR.InitError.VRInitError_None) throw new Error(`Failed to initialize OpenVR: ${OpenVR.InitError[initError]}`)

    const systemPtr = OpenVR.VR_GetGenericInterface(stringToPointer(OpenVR.IVRSystem_Version), initErrorPtr);
    const overlayPtr = OpenVR.VR_GetGenericInterface(stringToPointer(OpenVR.IVROverlay_Version), initErrorPtr);

    const interfaceError = new Deno.UnsafePointerView(initErrorPtr).getInt32();

    if (interfaceError !== OpenVR.InitError.VRInitError_None) throw new Error(`Failed to get IVRSystem interface: ${OpenVR.InitError[interfaceError]}`)

    state.vrSystemPTR = systemPtr
    state.overlayPTR = overlayPtr

    CustomLogger.log("actor", "OpenVR initialized and IVRSystem interface acquired.");
}

