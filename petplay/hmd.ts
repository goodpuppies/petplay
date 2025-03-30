import { PostMan } from "../submodules/stageforge/mod.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { CustomLogger } from "../classes/customlogger.ts";
import { wait } from "../classes/utils.ts";

const state = {
  name: "hmd_position_actor",
  vrSystem: null as OpenVR.IVRSystem | null,
  web: null as string | null
};

new PostMan(state, {
  CUSTOMINIT: (_payload) => { },
  GETHMDPOSITION: (_payload) => { return getHMDPose(); },
  INITOPENVR: (payload) => {
    const ptrn = payload;
    const systemPtr = Deno.UnsafePointer.create(ptrn); 
    state.vrSystem = new OpenVR.IVRSystem(systemPtr);  

    CustomLogger.log("actor", `OpenVR system initialized in actor ${PostMan.state.id} with pointer ${ptrn}`);
  },
  ASSIGNWEB: (payload: string) => {
    state.web = payload
    webloop()
  },
} as const);

async function webloop() {
  while (true) {
    const pose = getHMDPose()
    PostMan.PostMessage({
      target: state.web as string,
      type: "HMDPOSE",
      payload: pose
    })
    await wait(10)
  }
}

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

