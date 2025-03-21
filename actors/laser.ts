import {
    BaseState,
    worker,
    MessageAddressReal,
} from "../stageforge/src/lib/types.ts";
import { PostMan } from "../stageforge/mod.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_DenoX/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_DenoX/pointers.ts";
import { CustomLogger } from "../classes/customlogger.ts";

const LASER_POINTER_WIDTH = 0.002; // 2mm wide
const LASER_POINTER_LENGTH = 0.2; // 20cm long


const state = {
    id: "",
    name: "laserpointer",
    socket: null,
    overlayClass: null as OpenVR.IVROverlay | null,
    intersectionOverlayHandle: null as bigint | null,
    vrSystem: null as OpenVR.IVRSystem | null,
    leftLaserHandle: 0n as OpenVR.OverlayHandle,
    rightLaserHandle: 0n as OpenVR.OverlayHandle,
    inputActor: null as string | null,
    isRunning: false,
    addressBook: new Set(),
};


new PostMan(state.name, {
    CUSTOMINIT: (_payload: void) => {
        //PostMan.setTopic("muffin")
    },

    INITOPENVR: (payload: bigint) => {
        const ptrn = payload;
        const systemPtr = Deno.UnsafePointer.create(ptrn);
        state.vrSystem = new OpenVR.IVRSystem(systemPtr);
        state.overlayClass = new OpenVR.IVROverlay(systemPtr);
        CustomLogger.log("actor", `OpenVR system initialized in actor ${state.id}`);
    },

    SETINPUTACTOR: (payload: string) => {
        state.inputActor = payload;
    },

    STARTLASERS: () => {
        createLaserOverlays();
        state.isRunning = true;
        updateLoop();
    },

    STOPLASERS: () => {
        state.isRunning = false;
        destroyLaserOverlays();
    },
    INTERSECTION: (payload: { intersection: OpenVR.OverlayIntersectionResults }) => {

        if (!state.intersectionOverlayHandle) {
            state.intersectionOverlayHandle = createIntersectionOverlay();
        }
        updateIntersectionOverlay(payload);

    },
} as const);

function createLaserOverlays() {
    if (!state.overlayClass) {
        CustomLogger.error("actor", "Overlay class not initialized");
        return;
    }

    // Create simple 2x2 blue-ish texture
    const pixels = new Uint32Array([0xFFBFA75F, 0xFFBFA75F, 0xFFBFA75F, 0xFFBFA75F]);
    const pixelBuffer = pixels.buffer;

    // Create left laser overlay
    const leftHandlePTR = P.BigUint64P<OpenVR.OverlayHandle>();
    let error = state.overlayClass.CreateOverlay("laser.left", "Left Laser Pointer", leftHandlePTR);
    state.leftLaserHandle = new Deno.UnsafePointerView(leftHandlePTR).getBigUint64();

    if (error !== OpenVR.OverlayError.VROverlayError_None) {
        CustomLogger.error("actor", `Failed to create left laser overlay: ${OpenVR.OverlayError[error]}`);
        return;
    }

    error = state.overlayClass.SetOverlayRaw(state.leftLaserHandle, Deno.UnsafePointer.of(pixelBuffer)!, 2, 2, 4);
    state.overlayClass.SetOverlayWidthInMeters(state.leftLaserHandle, LASER_POINTER_WIDTH);

    // Create right laser overlay
    const rightHandlePTR = P.BigUint64P<OpenVR.OverlayHandle>();
    error = state.overlayClass.CreateOverlay("laser.right", "Right Laser Pointer", rightHandlePTR);
    state.rightLaserHandle = new Deno.UnsafePointerView(rightHandlePTR).getBigUint64();

    if (error !== OpenVR.OverlayError.VROverlayError_None) {
        CustomLogger.error("actor", `Failed to create right laser overlay: ${OpenVR.OverlayError[error]}`);
        return;
    }

    error = state.overlayClass.SetOverlayRaw(state.rightLaserHandle, Deno.UnsafePointer.of(pixelBuffer)!, 2, 2, 4);
    state.overlayClass.SetOverlayWidthInMeters(state.rightLaserHandle, LASER_POINTER_WIDTH);
}

function createIntersectionOverlay(): bigint {
    if (!state.overlayClass) {
        throw new Error("Overlay class not initialized");
    }

    // Create the intersection overlay
    const intersectionHandlePTR = P.BigUint64P<OpenVR.OverlayHandle>();
    const error = state.overlayClass.CreateOverlay("intersection.point", "Intersection Point", intersectionHandlePTR);
    const intersectionHandle = new Deno.UnsafePointerView(intersectionHandlePTR).getBigUint64();
    if (error !== OpenVR.OverlayError.VROverlayError_None) {
        throw new Error("failed to create intersection overlay");
    }

    const pixels = new Uint32Array([0xFF0000FF, 0xFF0000FF, 0xFF0000FF, 0xFF0000FF]);
    const pixelBuffer = pixels.buffer;
    state.overlayClass.SetOverlayRaw(intersectionHandle, Deno.UnsafePointer.of(pixelBuffer)!, 2, 2, 4);
    state.overlayClass.SetOverlayWidthInMeters(intersectionHandle, 0.05);
    state.overlayClass.SetOverlayFlag(intersectionHandle, OpenVR.OverlayFlags.VROverlayFlags_SortWithNonSceneOverlays, true);

    state.intersectionOverlayHandle = intersectionHandle

    state.overlayClass.ShowOverlay(state.intersectionOverlayHandle);

    return intersectionHandle as bigint;
}

function updateIntersectionOverlay(intersectionWrapper: { intersection: OpenVR.OverlayIntersectionResults }) {
    if (!state.overlayClass || !state.intersectionOverlayHandle) return;

    const point = intersectionWrapper.intersection.vPoint;

    // Adjust the point to move the overlay closer to the user's viewpoint
    const offsetDistance = 0.09; // Adjust distance as needed (e.g., 5 cm closer)
    const adjustedPoint = {
        v: [
            point.v[0],
            point.v[1],
            point.v[2] //+ offsetDistance // Move closer along the Z-axis
        ]
    };

    // Create a transformation matrix for the adjusted intersection point
    const intersectionTransform: OpenVR.HmdMatrix34 = {
        m: [
            [1, 0, 0, adjustedPoint.v[0]], // X-axis
            [0, 1, 0, adjustedPoint.v[1]], // Y-axis
            [0, 0, 1, adjustedPoint.v[2]]  // Z-axis
        ]
    };

    // Convert transform to pointer
    const transformBuffer = new ArrayBuffer(OpenVR.HmdMatrix34Struct.byteSize);
    const transformView = new DataView(transformBuffer);
    OpenVR.HmdMatrix34Struct.write(intersectionTransform, transformView);
    const transformPtr = Deno.UnsafePointer.of<OpenVR.HmdMatrix34>(transformBuffer)!;

    // Update overlay transform 
    state.overlayClass.SetOverlayTransformAbsolute(
        state.intersectionOverlayHandle,
        OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding,
        transformPtr
    );

    // Show the intersection overlay
    //state.overlayClass.ShowOverlay(state.intersectionOverlayHandle);
}

function destroyLaserOverlays() {
    if (!state.overlayClass) return;

    if (state.leftLaserHandle !== 0n) {
        state.overlayClass.DestroyOverlay(state.leftLaserHandle);
        state.leftLaserHandle = 0n;
    }

    if (state.rightLaserHandle !== 0n) {
        state.overlayClass.DestroyOverlay(state.rightLaserHandle);
        state.rightLaserHandle = 0n;
    }
}

async function updateLoop() {
    while (state.isRunning) {
        try {
            if (!state.inputActor) {
                CustomLogger.log("actor", "No input actor set");
                continue;
            }

            // Get controller poses from input actor
            const controllerData = await PostMan.PostMessage({
                target: state.inputActor,
                type: "GETCONTROLLERDATA",
                payload: null
            }, true) as [OpenVR.InputPoseActionData, OpenVR.InputPoseActionData];

            if (controllerData) {
                const [leftPose, rightPose] = controllerData;

                if (leftPose) {
                    updateLaserOverlay(state.leftLaserHandle, leftPose.pose.mDeviceToAbsoluteTracking);
                }
                if (rightPose) {
                    updateLaserOverlay(state.rightLaserHandle, rightPose.pose.mDeviceToAbsoluteTracking);
                }
            }

            await new Promise(resolve => setTimeout(resolve, 1000 / 90)); // 90hz update rate
        } catch (error) {
            CustomLogger.error("updateLoop", `Error in update loop: ${(error as Error).message}`);
        }
    }
}


function updateLaserOverlay(handle: OpenVR.OverlayHandle, controllerPose: OpenVR.HmdMatrix34) {
    if (!state.overlayClass) return;




    // Convert transform to pointer
    const transformBuffer = new ArrayBuffer(OpenVR.HmdMatrix34Struct.byteSize);
    const transformView = new DataView(transformBuffer);
    OpenVR.HmdMatrix34Struct.write(laserTransform, transformView);
    const transformPtr = Deno.UnsafePointer.of<OpenVR.HmdMatrix34>(transformBuffer)!;

    // Update overlay transform 
    state.overlayClass.SetOverlayTransformAbsolute(
        handle,
        OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding,
        transformPtr
    );

    // Set texture bounds to control laser length 
    const texBoundsBuffer = new ArrayBuffer(OpenVR.TextureBoundsStruct.byteSize);
    const texBoundsView = new DataView(texBoundsBuffer);
    OpenVR.TextureBoundsStruct.write({
        uMin: 0,
        vMin: 0,
        uMax: 1,
        vMax: LASER_POINTER_LENGTH / LASER_POINTER_WIDTH // Stretch texture to make laser longer 
    }, texBoundsView);
    const texBoundsPtr = Deno.UnsafePointer.of<OpenVR.TextureBounds>(texBoundsBuffer)!;

    state.overlayClass.SetOverlayTextureBounds(handle, texBoundsPtr);
    state.overlayClass.ShowOverlay(handle);
}
