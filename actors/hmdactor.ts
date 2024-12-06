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
    vrSystem: OpenVR.IVRSystem | null;
    [key: string]: unknown;
};

const state: State & BaseState = {
    id: "",
    db: {},
    name: "hmd_position_actor",
    socket: null,
    sync: false,
    vrSystem: null,
    addressBook: new Set(),
};

const functions: TypedActorFunctions = {
    CUSTOMINIT: (_payload) => {
        Postman.functions?.HYPERSWARM?.(null, state.id);
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
    INITOPENVR: (payload) => {
        const ptrn = payload;
        const systemPtr = Deno.UnsafePointer.create(ptrn);  // Recreate the pointer
        state.vrSystem = new OpenVR.IVRSystem(systemPtr);   // Create the OpenVR instance

        CustomLogger.log("actor", `OpenVR system initialized in actor ${state.id} with pointer ${ptrn}`);
    },
    GETHMDPOSITION: (_payload, address) => {
        const addr = address as MessageAddressReal;
        const hmdPose = getHMDPose();
        Postman.PostMessage({
            address: { fm: state.id, to: addr.fm },
            type: "CB:GETHMDPOSITION",
            payload: hmdPose,
        });
    },
};
function getHMDPose(): OpenVR.TrackedDevicePose {
    const vrSystem = state.vrSystem!;
    const posesSize = OpenVR.TrackedDevicePoseStruct.byteSize * OpenVR.k_unMaxTrackedDeviceCount;
    const poseArrayBuffer = new ArrayBuffer(posesSize);
    const posePtr = Deno.UnsafePointer.of(poseArrayBuffer) as Deno.PointerValue<OpenVR.TrackedDevicePose>;

    vrSystem.GetDeviceToAbsoluteTrackingPose(
        OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding,
        0,
        posePtr,
        OpenVR.k_unMaxTrackedDeviceCount
    );

    const hmdIndex = OpenVR.k_unTrackedDeviceIndex_Hmd;
    const poseView = new DataView(
        poseArrayBuffer,
        hmdIndex * OpenVR.TrackedDevicePoseStruct.byteSize,
        OpenVR.TrackedDevicePoseStruct.byteSize
    );
    const hmdPose = OpenVR.TrackedDevicePoseStruct.read(poseView) as OpenVR.TrackedDevicePose;

    return hmdPose;
}

new Postman(worker, functions, state);

OnMessage((message) => {
    Postman.runFunctions(message);
});
