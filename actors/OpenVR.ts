import {
    BaseState,
    worker,
    MessageAddressReal,
} from "../stageforge/src/lib/types.ts";
import { PostMan } from "../stageforge/mod.ts";
import * as OpenVR from "../OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../OpenVR_TS_Bindings_Deno/pointers.ts";
import { stringToPointer } from "../OpenVR_TS_Bindings_Deno/utils.ts";
import { CustomLogger } from "../classes/customlogger.ts";

const state = {
    id: "",
    db: {},
    name: "openvr",
    socket: null,
    sync: false,
    vrSystemPTR: null as Deno.PointerValue | null,
    overlayPTR: null as Deno.PointerValue | null,
    addressBook: new Set(),
};

new PostMan(state.name, {
    CUSTOMINIT: (_payload) => {
        //PostMan.setTopic("muffin")
        initializeOpenVR();
    },
    LOG: (_payload) => {
        CustomLogger.log("actor", state.id);
    },
    GETID: (_payload) => {
        return state.id
    },
    GETOPENVRPTR: (_payload) => {
        if (!state.vrSystemPTR) {
            CustomLogger.error("actorerr", `OpenVR system not initialized in actor ${state.id}`);
            return;
        }

        const ivrsystem = state.vrSystemPTR

        const systemPtrNumeric = Deno.UnsafePointer.value(ivrsystem);

        return systemPtrNumeric
    },
    GETOVERLAYPTR: (_payload) => {
        if (!state.overlayPTR) {
            CustomLogger.error("actorerr", `OpenVR system not initialized in actor ${state.id}`);
            return;
        }
        const overlay = state.overlayPTR

        const overlayPtrNumeric = Deno.UnsafePointer.value(overlay);

        return overlayPtrNumeric
    }
} as const)

function initializeOpenVR() {
    const initErrorPtr = P.Int32P<OpenVR.InitError>();
    OpenVR.VR_InitInternal(initErrorPtr, OpenVR.ApplicationType.VRApplication_Overlay);
    const initError = new Deno.UnsafePointerView(initErrorPtr).getInt32();

    if (initError !== OpenVR.InitError.VRInitError_None) {
        CustomLogger.error("actorerr", `Failed to initialize OpenVR: ${OpenVR.InitError[initError]}`);
        throw new Error("Failed to initialize OpenVR");
    }

    const systemPtr = OpenVR.VR_GetGenericInterface(stringToPointer(OpenVR.IVRSystem_Version), initErrorPtr);
    const overlayPtr = OpenVR.VR_GetGenericInterface(stringToPointer(OpenVR.IVROverlay_Version), initErrorPtr);

    const interfaceError = new Deno.UnsafePointerView(initErrorPtr).getInt32();

    if (interfaceError !== OpenVR.InitError.VRInitError_None) {
        CustomLogger.error("actorerr", `Failed to get IVRSystem interface: ${OpenVR.InitError[interfaceError]}`);
        throw new Error("Failed to get IVRSystem interface");
    }

    const initerrorptr = Deno.UnsafePointer.of<OpenVR.InitError>(new Int32Array(1))!
    const TypeSafeINITERRPTR: OpenVR.InitErrorPTRType = initerrorptr


    const errorX = Deno.UnsafePointer.of(new Int32Array(1))!;


    state.vrSystemPTR = systemPtr
    state.overlayPTR = overlayPtr



    CustomLogger.log("actor", "OpenVR initialized and IVRSystem interface acquired.");
}

