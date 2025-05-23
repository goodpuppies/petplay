import { ActorId, PostMan, actorState } from "../submodules/stageforge/mod.ts";
import { tempFile, wait } from "../classes/utils.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import { getOverlayTransformAbsolute, setOverlayTransformAbsolute } from "../classes/openvrTransform.ts";
import { TransformStabilizer2 } from "../classes/transformStabilizer2.ts";

const state = actorState({
  origin: null as OpenVR.HmdMatrix34 | null,
  name: "origin",
  vrc: "",
  hmd: "",
  overlayClass: null as OpenVR.IVROverlay | null,
  overlayHandle: 0n as OpenVR.OverlayHandle,
  overlayerror: OpenVR.OverlayError.VROverlayError_None,
  originChangeCount: 0,
  transformStabilizer: null as TransformStabilizer2 | null,
  overlays: [] as string[],
});

new PostMan(state, {
  __INIT__: (_payload: void) => {},
  ASSIGNVRC: (payload: string) => { state.vrc = payload; },
  ASSIGNHMD: (payload: string) => { state.hmd = payload; },
  ADDADDRESS: (payload: ActorId) => { state.addressBook.add(payload); },
  GETVRCORIGIN: (_payload: void) => { return state.origin },
  STARTORIGIN: (payload: { name: string, texture: string }) => {
    main(payload.name, payload.texture);
  },
  GETOVERLAYLOCATION: (_payload: void) => {
    if (!state.overlayClass || !state.overlayHandle) {
    throw new Error("Overlay not initialized");
    }
    return getOverlayTransformAbsolute(state.overlayClass, state.overlayHandle);
  },
  INITOVROVERLAY: (payload: bigint) => {
    const systemPtr = Deno.UnsafePointer.create(payload);
    state.overlayClass = new OpenVR.IVROverlay(systemPtr);
  },
  ADDOVERLAY: (payload: string) => {
    state.overlays.push(payload);
  }
} as const);

const PositionX: string = "/avatar/parameters/CustomObjectSync/PositionX";
const PositionY: string = "/avatar/parameters/CustomObjectSync/PositionY";
const PositionZ: string = "/avatar/parameters/CustomObjectSync/PositionZ";
const RotationY: string = "/avatar/parameters/CustomObjectSync/RotationY";

const lastKnownPosition: LastKnownPosition = { x: 0, y: 0, z: 0 };
const lastKnownRotation: LastKnownRotation = { y: 0 };

function originReaction() {
  if (state.overlays.length > 0) {
    PostMan.PostMessage({
      target: state.overlays,
      type: "ORIGINUPDATE",
      payload: state.origin
    })
  }
}

async function main(overlaymame: string, overlaytexture: string) {
  try {
    state.transformStabilizer = new TransformStabilizer2();  
    LogChannel.log("vrcorigin", "Creating origin...");
    const overlay = state.overlayClass as OpenVR.IVROverlay;
    const overlayHandlePTR = P.BigUint64P<OpenVR.OverlayHandle>();
    const error = overlay.CreateOverlay(overlaymame, overlaymame, overlayHandlePTR);
    if (error !== OpenVR.OverlayError.VROverlayError_None) throw new Error(`Failed to create overlay: ${OpenVR.OverlayError[error]}`);
    const overlayHandle = new Deno.UnsafePointerView(overlayHandlePTR).getBigUint64();
    state.overlayHandle = overlayHandle;
    const path = tempFile(overlaytexture, import.meta.dirname!)
    console.log(path)
    const e = overlay.SetOverlayFromFile(overlayHandle, path);
    if (e !== OpenVR.OverlayError.VROverlayError_None) {console.error(e)}
    overlay.SetOverlayWidthInMeters(overlayHandle, 0.5);
    overlay.ShowOverlay(overlayHandle);  
    const initialTransform: OpenVR.HmdMatrix34 = {
      m: [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 1.0],
        [0.0, 0.0, 1.0, -2.0]
      ]
    };
    setTransform(initialTransform);  

    let lastOrigin: OpenVR.HmdMatrix34 | null = null;
    let lastLogTime = Date.now();  
    function isOriginChanged(newOrigin: OpenVR.HmdMatrix34): boolean {
      if (!lastOrigin) return true;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 4; j++) {
          if (newOrigin.m[i][j] !== lastOrigin.m[i][j]) return true;
        }
      }
      return false;
    }  
    while (true) {
      if (state.vrc != "") {
        const [finalMatrix, pureMatrix, hmdTransform] = await extractOrigin()
        
        if (state.transformStabilizer) {
          const stabilizedMatrix = state.transformStabilizer.getStabilizedTransform(
            pureMatrix,
            hmdTransform,
            finalMatrix
          );
          setTransform(finalMatrix);  
          // Use stabilized matrix for origin updates too
          if (isOriginChanged(stabilizedMatrix)) {
            state.origin = stabilizedMatrix;
            originReaction()
            state.originChangeCount++;
            lastOrigin = stabilizedMatrix;
          }
        } else {
          setTransform(finalMatrix);  
          if (isOriginChanged(pureMatrix)) {
            state.origin = pureMatrix;
            originReaction()
            state.originChangeCount++;
            lastOrigin = pureMatrix;
          }
        }  
        const currentTime = Date.now();
        if (currentTime - lastLogTime >= 1000) {
          LogChannel.log("origin", `Origin changed ${state.originChangeCount} times in the last second`);
          state.originChangeCount = 0;
          lastLogTime = currentTime;
        }  
        await wait(11);
      }
      await wait(11);
    }
  } catch (e) {
    LogChannel.error("vrcorigin", `Error in origin: ${(e as Error).message}`);
  }
}

function transformCoordinate(value: number): number {
  return (value - 0.5) * 340;
}
function transformRotation(value: number): number {
  return value * 2 * Math.PI;
}  
async function extractOrigin() { 
  interface coord {
    [key: string]: number;
  }
  const hmdPose = await PostMan.PostMessage({
    target: state.hmd,
    type: "GETHMDPOSITION",
    payload: null,
  }, true) as OpenVR.TrackedDevicePose;
  const hmdMatrix = hmdPose.mDeviceToAbsoluteTracking.m;
  const hmdYaw = Math.atan2(hmdMatrix[0][2], hmdMatrix[0][0]);
  const coordinate = await PostMan.PostMessage({
    target: state.vrc,
    type: "GETCOORDINATE",
    payload: null,
  }, true) as coord;
  if (coordinate[PositionX] !== undefined) lastKnownPosition.x = coordinate[PositionX];
  if (coordinate[PositionY] !== undefined) lastKnownPosition.y = coordinate[PositionY];
  if (coordinate[PositionZ] !== undefined) lastKnownPosition.z = coordinate[PositionZ];
  if (coordinate[RotationY] !== undefined) lastKnownRotation.y = coordinate[RotationY];
  const hmdX = hmdMatrix[0][3];  // Extract HMD X position
  const hmdY = hmdMatrix[1][3];  // Extract HMD Y position
  const hmdZ = hmdMatrix[2][3];  // Extract HMD Z position
  const vrChatYaw = transformRotation(lastKnownRotation.y);
  const correctedYaw = hmdYaw + vrChatYaw;
  const cosVrChatYaw = Math.cos(correctedYaw);
  const sinVrChatYaw = Math.sin(correctedYaw);
  const rotatedHmdX = hmdX * cosVrChatYaw - hmdZ * sinVrChatYaw;
  const rotatedHmdZ = hmdX * sinVrChatYaw + hmdZ * cosVrChatYaw;
  const transformedX = transformCoordinate(lastKnownPosition.x) + rotatedHmdX;
  const transformedY = transformCoordinate(lastKnownPosition.y);
  const transformedZ = transformCoordinate(lastKnownPosition.z) - rotatedHmdZ;
  const cosCorrectedYaw = Math.cos(correctedYaw);
  const sinCorrectedYaw = Math.sin(correctedYaw);
  const rotatedX = transformedX * cosCorrectedYaw - transformedZ * sinCorrectedYaw;
  const rotatedZ = transformedX * sinCorrectedYaw + transformedZ * cosCorrectedYaw;
  const pureMatrix: OpenVR.HmdMatrix34 = {
    m: [
      [cosCorrectedYaw, 0, sinCorrectedYaw, rotatedX],
      [0, 1, 0, -transformedY],
      [-sinCorrectedYaw, 0, cosCorrectedYaw, -rotatedZ]
    ]
  };
  const hmdTransform: OpenVR.HmdMatrix34 = {
    m: [
      [hmdMatrix[0][0], hmdMatrix[0][1], hmdMatrix[0][2], hmdX],
      [hmdMatrix[1][0], hmdMatrix[1][1], hmdMatrix[1][2], hmdY],
      [hmdMatrix[2][0], hmdMatrix[2][1], hmdMatrix[2][2], hmdZ]
    ]
  };
  const angle = -Math.PI / 2; // -90 degrees, pointing straight down
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  const finalMatrix: OpenVR.HmdMatrix34 = {
    m: [
      [cosCorrectedYaw, sinCorrectedYaw * s, sinCorrectedYaw * c, rotatedX],
      [0, c, -s, -transformedY + 2.9],
      [-sinCorrectedYaw, cosCorrectedYaw * s, cosCorrectedYaw * c, -rotatedZ]
    ]
  };
  return [finalMatrix, pureMatrix, hmdTransform]
}

interface LastKnownPosition {
  x: number;
  y: number;
  z: number;
}
interface LastKnownRotation {
  y: number;
}

function setTransform(transform: OpenVR.HmdMatrix34) {
  if (!state.overlayClass || !state.overlayHandle) return;
  setOverlayTransformAbsolute(state.overlayClass, state.overlayHandle, transform);
}

