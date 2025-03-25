import { PostMan } from "../submodules/stageforge/mod.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { CustomLogger } from "../classes/customlogger.ts";

const state = {
    name: "hmd_position_actor",
    vrSystem: null as OpenVR.IVRSystem | null,
};

new PostMan(state, {
    CUSTOMINIT: (_payload) => {
    },
    LOG: (_payload) => {
        CustomLogger.log("actor", PostMan.state.id);
    },
    GETID: (_payload) => {
        return PostMan.state.id
    },
    INITOPENVR: (payload) => {
        const ptrn = payload;
        const systemPtr = Deno.UnsafePointer.create(ptrn); 
        state.vrSystem = new OpenVR.IVRSystem(systemPtr);  

        CustomLogger.log("actor", `OpenVR system initialized in actor ${PostMan.state.id} with pointer ${ptrn}`);
    },
    GETHMDPOSITION: (_payload) => {
        return getHMDPose();
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

