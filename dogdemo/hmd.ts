import { PostMan } from "../stageforge/mod.ts";
import * as OpenVR from "../OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { CustomLogger } from "../classes/customlogger.ts";


const state = {
    id: "",
    db: {},
    name: "hmd_position_actor",
    socket: null,
    sync: false,
    vrSystem: null as OpenVR.IVRSystem | null,
    addressBook: new Set(),
};

new PostMan(state.name, {
    CUSTOMINIT: (_payload) => {
        ////PostMan.setTopic("muffin")
    },
    LOG: (_payload) => {
        CustomLogger.log("actor", state.id);
    },
    GETID: (_payload) => {
        return state.id
    },
    INITOPENVR: (payload) => {
        const ptrn = payload;
        const systemPtr = Deno.UnsafePointer.create(ptrn);  // Recreate the pointer
        state.vrSystem = new OpenVR.IVRSystem(systemPtr);   // Create the OpenVR instance

        CustomLogger.log("actor", `OpenVR system initialized in actor ${state.id} with pointer ${ptrn}`);
    },
    GETHMDPOSITION: (_payload) => {
        const hmdPose = getHMDPose();
        return hmdPose
    },
} as const);

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

