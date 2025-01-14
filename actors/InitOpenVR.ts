import {
    TypedActorFunctions,
    BaseState,
    worker,
    MessageAddressReal,
} from "../actorsystem/types.ts";
import { OnMessage, Postman } from "../classes/PostMan.ts";
import * as OpenVR from "../OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../OpenVR_TS_Bindings_Deno/pointers.ts";
import { stringToPointer } from "../OpenVR_TS_Bindings_Deno/utils.ts";
import { CustomLogger } from "../classes/customlogger.ts";

// HMD Position actor module
type State = {
    id: string;
    db: Record<string, unknown>;
    vrSystemPTR: Deno.PointerValue | null;
    overlayPTR: Deno.PointerValue | null;
    [key: string]: unknown;
};

const state: State & BaseState = {
    id: "",
    db: {},
    name: "hmd_position_actor",
    socket: null,
    sync: false,
    vrSystemPTR: null,
    overlayPTR: null,
    addressBook: new Set(),
};

const functions: TypedActorFunctions = {
    CUSTOMINIT: (_payload) => {
        Postman.functions?.HYPERSWARM?.(null, state.id);
        initializeOpenVR();
    },
    LOG: (_payload) => {
        CustomLogger.log("actor", state.id);
    },
    GETID: (_payload, address) => {
        const addr = address as MessageAddressReal;
        Postman.PostMessage({
            address: { fm: state.id, to: addr.fm },
            type: "CB:GETID",
            payload: state.id,
        }, false);
    },
    GETOPENVRPTR: (_payload, address) => {
        const addr = address as MessageAddressReal;

        if (!state.vrSystemPTR) {
            CustomLogger.error("actorerr", `OpenVR system not initialized in actor ${state.id}`);
            return;
        }

        const ivrsystem = state.vrSystemPTR

        const systemPtrNumeric = Deno.UnsafePointer.value(ivrsystem);

        Postman.PostMessage({
            address: { fm: state.id, to: addr.fm },
            type: "CB:GETOPENVRPTR",
            payload: systemPtrNumeric,
        }, false);

        CustomLogger.log("actor", `Sent OpenVR pointer: ${systemPtrNumeric}`);
    },
    GETOVERLAYPTR: (_payload, address) => {
        const addr = address as MessageAddressReal;

        if (!state.overlayPTR) {
            CustomLogger.error("actorerr", `OpenVR system not initialized in actor ${state.id}`);
            return;
        }

        const overlay = state.overlayPTR

        const overlayPtrNumeric = Deno.UnsafePointer.value(overlay);
        console.log("xd2", overlayPtrNumeric)

        Postman.PostMessage({
            address: { fm: state.id, to: addr.fm },
            type: "CB:GETOPENVRPTR",
            payload: overlayPtrNumeric,
        }, false);

        CustomLogger.log("actor", `Sent OpenVR pointer: ${overlayPtrNumeric}`);
    }
};

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


new Postman(worker, functions, state);

OnMessage((message) => {
    Postman.runFunctions(message);
});
