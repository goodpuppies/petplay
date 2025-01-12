import {
    TypedActorFunctions,
    BaseState,
    worker,
    MessageAddressReal,
} from "../actorsystem/types.ts";
import { OnMessage, Postman } from "../classes/PostMan.ts";
import * as OpenVR from "../OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../OpenVR_TS_Bindings_Deno/pointers.ts";
import { CustomLogger } from "../classes/customlogger.ts";

const LASER_POINTER_WIDTH = 0.002; // 2mm wide
const LASER_POINTER_LENGTH = 0.2; // 20cm long

type State = {
    id: string;
    overlayClass: OpenVR.IVROverlay | null;
    vrSystem: OpenVR.IVRSystem | null;
    leftLaserHandle: OpenVR.OverlayHandle;
    rightLaserHandle: OpenVR.OverlayHandle;
    inputActor: string | null; // To get controller poses
    isRunning: boolean;
    [key: string]: unknown;
};

const state: State & BaseState = {
    id: "",
    name: "laserpointer",
    socket: null,
    overlayClass: null,
    vrSystem: null,
    leftLaserHandle: 0n,
    rightLaserHandle: 0n,
    inputActor: null,
    isRunning: false,
    addressBook: new Set(),
};

const functions = {
    CUSTOMINIT: (_payload: void) => {
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
    }
};

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
            const controllerData = await Postman.PostMessage({
                address: { fm: state.id, to: state.inputActor },
                type: "GETCONTROLLERDATA",
                payload: null
            }, true);

            if (controllerData) {
                const [leftPose, rightPose] = controllerData;

                if (leftPose) {
                    updateLaserOverlay(state.leftLaserHandle, leftPose.pose.mDeviceToAbsoluteTracking);
                }
                if (rightPose) {
                    updateLaserOverlay(state.rightLaserHandle, rightPose.pose.mDeviceToAbsoluteTracking);
                }
            }

            await new Promise(resolve => setTimeout(resolve, 1000/90)); // 90hz update rate
        } catch (error) {
            CustomLogger.error("updateLoop", `Error in update loop: ${(error as Error).message}`);
        }
    }
}

function updateLaserOverlay(handle: OpenVR.OverlayHandle, controllerPose: OpenVR.HmdMatrix34) {
    if (!state.overlayClass) return;

    // Create a modified transform that positions and orients the laser
    const laserTransform: OpenVR.HmdMatrix34 = {
        m: [
            [...controllerPose.m[0]],
            [...controllerPose.m[1]],
            [...controllerPose.m[2]]
        ]
    };

    // Offset the laser forward by half its length (since the overlay is centered)
    laserTransform.m[0][3] += controllerPose.m[0][2] * LASER_POINTER_LENGTH / 2;
    laserTransform.m[1][3] += controllerPose.m[1][2] * LASER_POINTER_LENGTH / 2;
    laserTransform.m[2][3] += controllerPose.m[2][2] * LASER_POINTER_LENGTH / 2;

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

new Postman(worker, functions, state);

OnMessage((message) => {
    Postman.runFunctions(message);
});
