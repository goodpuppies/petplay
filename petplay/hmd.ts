import { PostMan } from "../submodules/stageforge/mod.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { CustomLogger } from "../classes/customlogger.ts";
import { wait } from "../classes/utils.ts";
import { setImmediate } from "node:timers";


const state = {
  name: "hmd_position_actor",
  vrSystem: null as OpenVR.IVRSystem | null,
  web: null as string | null,
  socket: null as WebSocket | null
};

new PostMan(state, {
  CUSTOMINIT: (_payload) => { },
  GETHMDPOSITION: (_payload) => { return getHMDPose(); },
  INITOPENVR: (payload) => {
    const ptrn = payload;
    const systemPtr = Deno.UnsafePointer.create(ptrn); 
    state.vrSystem = new OpenVR.IVRSystem(systemPtr);  

    CustomLogger.log("actor", `OpenVR system initialized in actor ${PostMan.state.id} with pointer ${ptrn}`);
    main() 
  },
  ASSIGNWEB: (payload: string) => {
    //state.web = payload
    //webloop()
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



function main() {
  Deno.serve({ port: 8887 }, (req) => {
    if (req.headers.get("upgrade") != "websocket") {
      return new Response(null, { status: 501 }); // Not a WebSocket request
    }

    const { socket, response } = Deno.upgradeWebSocket(req);

    socket.addEventListener("open", () => {
      console.log("WebSocket client connected!");
      if (state.socket && state.socket.readyState !== WebSocket.CLOSED) {
        console.warn("Replacing existing WebSocket connection.");
        state.socket.close();
      }
      state.socket = socket;
    });

    socket.addEventListener("message", (event) => {
      console.log("Received message:", event.data);
      if (event.data === "ping") {
        socket.send("pong");
      }

    });
    socket.addEventListener("close", () => {
      console.log("WebSocket client disconnected.");
      if (state.socket === socket) {
        state.socket = null; 
      }
    });
    socket.addEventListener("error", (err) => {
      console.error("WebSocket error:", err);
      if (state.socket === socket) {
        state.socket = null; 
      }
    });

    return response; // Return the response to complete the upgrade
  })
  dwebloop()
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

async function dwebloop() {
  while (true) {
    const pose = getHMDPoseX()
    sendpose(pose)
    await wait(0)
  }
}

function sendpose(pose: OpenVR.TrackedDevicePose) {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    try {
      const m = pose.mDeviceToAbsoluteTracking.m;
      const flat = new Float32Array([
        m[0][0], m[0][1], m[0][2], m[0][3],
        m[1][0], m[1][1], m[1][2], m[1][3],
        m[2][0], m[2][1], m[2][2], m[2][3],
      ]);
      state.socket.send(flat.buffer)

    } catch (error) {
      throw new Error("wtf")
    }
  } else {
    //throw new Error("wtf")
  }
}

function getHMDPoseX(): OpenVR.TrackedDevicePose {
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


