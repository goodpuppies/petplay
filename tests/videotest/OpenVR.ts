import {
    BaseState,
    worker,
} from "../../submodules/stageforge/src/lib/types.ts";
import { actorState, PostMan } from "../../submodules/stageforge/mod.ts";
import * as OpenVR from "../../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { stringToPointer } from "../../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel"

const state = actorState({
    id: "",
    db: {},
    name: "openvr",
    socket: null,
    sync: false,
    vrSystemPTR: null as Deno.PointerValue | null,
    overlayPTR: null as Deno.PointerValue | null,
    addressBook: new Set(),
});

new PostMan(state, {
    __INIT__: (_payload) => {
        //PostMan.setTopic("muffin")
        initializeOpenVR();
    },
    LOG: (_payload) => {
        LogChannel.log("actor", state.id);
    },
    GETID: (_payload) => {
        return state.id
    },
    GETOPENVRPTR: (_payload) => {
        if (!state.vrSystemPTR) {
            LogChannel.error("actorerr", `OpenVR system not initialized in actor ${state.id}`);
            return;
        }

        const ivrsystem = state.vrSystemPTR

        const systemPtrNumeric = Deno.UnsafePointer.value(ivrsystem);

        return systemPtrNumeric
    },
    GETOVERLAYPTR: (_payload) => {
        if (!state.overlayPTR) {
            LogChannel.error("actorerr", `OpenVR system not initialized in actor ${state.id}`);
            return;
        }
        const overlay = state.overlayPTR

        const overlayPtrNumeric = Deno.UnsafePointer.value(overlay);

        return overlayPtrNumeric
    }
} as const)

async function initializeOpenVR() {

    const success = OpenVR.initializeOpenVR("../../resources/openvr_api.dll", import.meta.url);
    if (!success) {
        console.error("Failed to initialize OpenVR library");
        return;
    }

    const initErrorPtr = P.Int32P<OpenVR.InitError>();
    OpenVR.VR_InitInternal(initErrorPtr, OpenVR.ApplicationType.VRApplication_Overlay);
    const initError = new Deno.UnsafePointerView(initErrorPtr).getInt32();

    if (initError !== OpenVR.InitError.VRInitError_None) {
        LogChannel.error("actorerr", `Failed to initialize OpenVR: ${OpenVR.InitError[initError]}`);
        throw new Error("Failed to initialize OpenVR");
    }

    const systemPtr = OpenVR.VR_GetGenericInterface(stringToPointer(OpenVR.IVRSystem_Version), initErrorPtr);
    const overlayPtr = OpenVR.VR_GetGenericInterface(stringToPointer(OpenVR.IVROverlay_Version), initErrorPtr);

    const interfaceError = new Deno.UnsafePointerView(initErrorPtr).getInt32();

    if (interfaceError !== OpenVR.InitError.VRInitError_None) {
        LogChannel.error("actorerr", `Failed to get IVRSystem interface: ${OpenVR.InitError[interfaceError]}`);
        throw new Error("Failed to get IVRSystem interface");
    }

    const initerrorptr = Deno.UnsafePointer.of<OpenVR.InitError>(new Int32Array(1))!
    const TypeSafeINITERRPTR: OpenVR.InitErrorPTRType = initerrorptr


    const errorX = Deno.UnsafePointer.of(new Int32Array(1))!;


    state.vrSystemPTR = systemPtr
    state.overlayPTR = overlayPtr



    LogChannel.log("actor", "OpenVR initialized and IVRSystem interface acquired.");
}

