import { PostMan } from "../submodules/stageforge/mod.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { fillBuffer, readBufferStructured, stringToPointer } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { CustomLogger } from "../classes/customlogger.ts";

//steamvr input handling

const state = {
    id: "",
    db: {},
    TrackingUniverseOriginPTR: null,
    name: "ovrinput",
    inputerror: OpenVR.InputError.VRInputError_None,
    socket: null,
    addressBook: new Set(),
    targetOverlayHandle: 0n,
    leftWasIntersecting: false,
    rightWasIntersecting: false,
    leftWasGrabbing: false,
    rightWasGrabbing: false,
    overlayActor: "",
    laser: ""
};


new PostMan(state, {
    CUSTOMINIT: (_payload: void) => {
        main()
    },
    LOG: (_payload: void) => {
        CustomLogger.log("actor", state.id);
    },
    GETID: (_payload: void) => {
        return state.id
    },
    SETOVERLAYHANDLE: (payload: bigint) => {
        state.targetOverlayHandle = payload;
    },
    SETOVERLAYACTOR: (payload: string) => {
        state.overlayActor = payload;
    },
    SETLASER: (payload: string) => {
        state.laser = payload;
    },
    GETCONTROLLERDATA: (_payload: void) => {
        //console.log("GETCONTROLLERDATA")
        //const addr = address;
        updateActionState();

        //#region pose
        let leftPoseData
        let rightPoseData
        error = vrInput.GetPoseActionDataRelativeToNow(
            handPoseLeftHandle,
            OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding,
            0,
            posedataleftpointer,
            OpenVR.InputPoseActionDataStruct.byteSize,
            OpenVR.k_ulInvalidInputValueHandle
        );
        if (error === OpenVR.InputError.VRInputError_None) {
            leftPoseData = OpenVR.InputPoseActionDataStruct.read(poseDataViewL);
        }
        error = vrInput.GetPoseActionDataRelativeToNow(
            handPoseRightHandle,
            OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding,
            0,
            posedatarightpointer,
            OpenVR.InputPoseActionDataStruct.byteSize,
            OpenVR.k_ulInvalidInputValueHandle
        );
        if (error === OpenVR.InputError.VRInputError_None) {
            rightPoseData = OpenVR.InputPoseActionDataStruct.read(poseDataViewR);
        }

        // Get grab button states
        error = vrInput.GetDigitalActionData(
            grabLeftHandle,
            grabLeftPointer,
            OpenVR.InputDigitalActionDataStruct.byteSize,
            OpenVR.k_ulInvalidInputValueHandle
        );
        const leftGrabData = OpenVR.InputDigitalActionDataStruct.read(grabDataViewL);
        //console.log(leftGrabData)

        error = vrInput.GetDigitalActionData(
            grabRightHandle,
            grabRightPointer,
            OpenVR.InputDigitalActionDataStruct.byteSize,
            OpenVR.k_ulInvalidInputValueHandle
        );
        const rightGrabData = OpenVR.InputDigitalActionDataStruct.read(grabDataViewR);

        // Check for grab release
        if (state.overlayActor) {
            if (state.leftWasGrabbing && !leftGrabData.bState) {
                PostMan.PostMessage({
                    target: state.overlayActor,
                    type: "OVERLAY_GRAB_END",
                    payload: {
                        controller: "left"
                    }
                });
            }
            if (state.rightWasGrabbing && !rightGrabData.bState) {
                PostMan.PostMessage({
                    target: state.overlayActor,
                    type: "OVERLAY_GRAB_END",
                    payload: {
                        controller: "right"
                    }
                });
            }
        }

        // Calculate forward vectors and test intersections only when grab is pressed
        let leftIntersection = null;
        let rightIntersection = null;

        if (leftPoseData && leftGrabData.bState) {
            const m = leftPoseData.pose.mDeviceToAbsoluteTracking.m;
            const leftForward = {
                v: [
                    m[2][0],
                    m[2][1],
                    -m[2][2]
                ]
            };

            // Set up intersection parameters
            OpenVR.OverlayIntersectionParamsStruct.write({
                vSource: {
                    v: [
                        leftPoseData.pose.mDeviceToAbsoluteTracking.m[0][3],
                        leftPoseData.pose.mDeviceToAbsoluteTracking.m[1][3],
                        leftPoseData.pose.mDeviceToAbsoluteTracking.m[2][3]
                    ]
                },
                vDirection: leftForward,
                eOrigin: OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding
            }, intersectionParamsViewL);

            // Test intersection
            const result = vrOverlay.ComputeOverlayIntersection(
                state.targetOverlayHandle,
                intersectionParamsPointerL,
                intersectionResultsPointerL
            );

            if (result) {
                console.log("left intersection")
                leftIntersection = OpenVR.OverlayIntersectionResultsStruct.read(intersectionResultsViewL);

                // If this is the first frame of intersection during grab, send grab event
                if (state.overlayActor && state.laser) { 
                    if (!state.leftWasIntersecting) {
                        PostMan.PostMessage({
                            target: state.overlayActor,
                            type: "OVERLAY_GRAB_START",
                            payload: {
                                controller: "left",
                                intersection: leftIntersection,
                                controllerPose: leftPoseData
                            }
                        });
                    }
                    PostMan.PostMessage({
                        target: state.laser,
                        type: "INTERSECTION",
                        payload: {
                            intersection: leftIntersection,
                        }
                    });
                }
            } else if (state.leftWasIntersecting && !leftGrabData.bState) {
                // If we were intersecting but aren't anymore and grab is released, send release event
                if (state.overlayActor) {
                    PostMan.PostMessage({
                        target: state.overlayActor || "",
                        type: "OVERLAY_GRAB_END",
                        payload: {
                            controller: "left"
                        }
                    });
                }
            }
            state.leftWasIntersecting = !!result;
        } else {
            state.leftWasIntersecting = false;
        }

        if (rightPoseData && rightGrabData.bState) {
            const m = rightPoseData.pose.mDeviceToAbsoluteTracking.m;
            const rightForward = {
                v: [
                    m[2][0],
                    m[2][1],
                    -m[2][2]
                ]
            };

            // Set up intersection parameters
            OpenVR.OverlayIntersectionParamsStruct.write({
                vSource: {
                    v: [
                        rightPoseData.pose.mDeviceToAbsoluteTracking.m[0][3],
                        rightPoseData.pose.mDeviceToAbsoluteTracking.m[1][3],
                        rightPoseData.pose.mDeviceToAbsoluteTracking.m[2][3]
                    ]
                },
                vDirection: rightForward,
                eOrigin: OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding
            }, intersectionParamsViewR);

            // Test intersection
            const result = vrOverlay.ComputeOverlayIntersection(
                state.targetOverlayHandle,
                intersectionParamsPointerR,
                intersectionResultsPointerR
            );

            if (result) {
                rightIntersection = OpenVR.OverlayIntersectionResultsStruct.read(intersectionResultsViewR);

                // If this is the first frame of intersection during grab, send grab event
                if (state.overlayActor && state.laser) {
                    if (!state.rightWasIntersecting) {
                        PostMan.PostMessage({
                            target: state.overlayActor,
                            type: "OVERLAY_GRAB_START",
                            payload: {
                                controller: "right",
                                intersection: rightIntersection,
                                controllerPose: rightPoseData
                            }
                        });
                    }
                    PostMan.PostMessage({
                        target: state.laser,
                        type: "INTERSECTION",
                        payload: {
                            intersection: rightIntersection,
                        }
                    });
                }
            } else if (state.rightWasIntersecting && !rightGrabData.bState) {
                // If we were intersecting but aren't anymore and grab is released, send release event
                if (state.overlayActor) {
                    PostMan.PostMessage({
                        target: state.overlayActor || "",
                        type: "OVERLAY_GRAB_END",
                        payload: {
                            controller: "right"
                        }
                    });
                }
            }
            state.rightWasIntersecting = !!result;
        } else {
            state.rightWasIntersecting = false;
        }
        //#endregion

        //#region button
        error = vrInput.GetDigitalActionData(
            triggerLeftHandle,
            triggerLeftPointer,
            OpenVR.InputDigitalActionDataStruct.byteSize,
            OpenVR.k_ulInvalidInputValueHandle
        );
        const leftTriggerData = OpenVR.InputDigitalActionDataStruct.read(triggerDataViewL);

        error = vrInput.GetDigitalActionData(
            triggerRightHandle,
            triggerRightPointer,
            OpenVR.InputDigitalActionDataStruct.byteSize,
            OpenVR.k_ulInvalidInputValueHandle
        );
        const rightTriggerData = OpenVR.InputDigitalActionDataStruct.read(triggerDataViewR);
        //#endregion

        // Update grab states
        state.leftWasGrabbing = leftGrabData.bState as unknown as boolean;
        state.rightWasGrabbing = rightGrabData.bState as unknown as boolean;

        const payload = [
            leftPoseData,
            rightPoseData,
            leftTriggerData,
            rightTriggerData,
            leftIntersection,
            rightIntersection,
            leftGrabData,
            rightGrabData
        ]
        return payload
        //#endregion
    }
} as const);

//#region openvr boilerplate 

//#region input
let error;
const success = await OpenVR.initializeOpenVR("../resources/openvr_api");
const manifestPath = Deno.realPathSync("../resources/actions.json");
const initerrorptr = Deno.UnsafePointer.of<OpenVR.InitError>(new Int32Array(1))!
const TypeSafeINITERRPTR: OpenVR.InitErrorPTRType = initerrorptr
const IVRInputPtr = OpenVR.VR_GetGenericInterface(stringToPointer(OpenVR.IVRInput_Version), TypeSafeINITERRPTR);
const vrInput = new OpenVR.IVRInput(IVRInputPtr);
//#endregion

//#region pose
const poseDataSize = OpenVR.InputPoseActionDataStruct.byteSize;
const bufferL = new ArrayBuffer(poseDataSize);
const bufferR = new ArrayBuffer(poseDataSize);

const poseDataViewL = new DataView(bufferL);
const poseDataViewR = new DataView(bufferR);

const posedataleftpointer = Deno.UnsafePointer.of<OpenVR.InputPoseActionData>(bufferL)!;
const posedatarightpointer = Deno.UnsafePointer.of<OpenVR.InputPoseActionData>(bufferR)!;

const actionSetHandlePTR = P.BigUint64P<OpenVR.ActionSetHandle>();
error = vrInput.GetActionSetHandle("/actions/main", actionSetHandlePTR);
if (error !== OpenVR.InputError.VRInputError_None) {
    CustomLogger.error("actorerr", `Failed to get action set handle: ${OpenVR.InputError[error]}`);
    throw new Error("Failed to get action set handle");
}
if (actionSetHandlePTR === null) throw new Error("Invalid pointer");
const actionSetHandle = new Deno.UnsafePointerView(actionSetHandlePTR).getBigUint64();

let handPoseLeftHandle: OpenVR.ActionHandle = OpenVR.k_ulInvalidActionHandle;
const handPoseLeftHandlePTR = P.BigUint64P<OpenVR.ActionHandle>();
let handPoseRightHandle: OpenVR.ActionHandle = OpenVR.k_ulInvalidActionHandle;
const handPoseRightHandlePTR = P.BigUint64P<OpenVR.ActionHandle>();
//#endregion

//#region button

let triggerLeftHandle: OpenVR.ActionHandle = OpenVR.k_ulInvalidActionHandle;
let triggerRightHandle: OpenVR.ActionHandle = OpenVR.k_ulInvalidActionHandle;
const triggerLeftHandlePTR = P.BigUint64P<OpenVR.ActionHandle>();
const triggerRightHandlePTR = P.BigUint64P<OpenVR.ActionHandle>();

let grabLeftHandle: OpenVR.ActionHandle = OpenVR.k_ulInvalidActionHandle;
let grabRightHandle: OpenVR.ActionHandle = OpenVR.k_ulInvalidActionHandle;
const grabLeftHandlePTR = P.BigUint64P<OpenVR.ActionHandle>();
const grabRightHandlePTR = P.BigUint64P<OpenVR.ActionHandle>();

const triggerDataSize = OpenVR.InputDigitalActionDataStruct.byteSize;
const triggerDataBufferL = new ArrayBuffer(triggerDataSize);
const triggerDataBufferR = new ArrayBuffer(triggerDataSize);
const triggerDataViewL = new DataView(triggerDataBufferL);
const triggerDataViewR = new DataView(triggerDataBufferR);
const triggerLeftPointer = Deno.UnsafePointer.of<OpenVR.InputDigitalActionData>(triggerDataBufferL)!;
const triggerRightPointer = Deno.UnsafePointer.of<OpenVR.InputDigitalActionData>(triggerDataBufferR)!;

const grabDataBufferL = new ArrayBuffer(OpenVR.InputDigitalActionDataStruct.byteSize);
const grabDataBufferR = new ArrayBuffer(OpenVR.InputDigitalActionDataStruct.byteSize);
const grabDataViewL = new DataView(grabDataBufferL);
const grabDataViewR = new DataView(grabDataBufferR);
const grabLeftPointer = Deno.UnsafePointer.of<OpenVR.InputDigitalActionData>(grabDataBufferL)!;
const grabRightPointer = Deno.UnsafePointer.of<OpenVR.InputDigitalActionData>(grabDataBufferR)!;

//#endregion

//#region intersection testing
const intersectionParamsBufferL = new ArrayBuffer(OpenVR.OverlayIntersectionParamsStruct.byteSize);
const intersectionParamsBufferR = new ArrayBuffer(OpenVR.OverlayIntersectionParamsStruct.byteSize);
const intersectionResultsBufferL = new ArrayBuffer(OpenVR.OverlayIntersectionResultsStruct.byteSize);
const intersectionResultsBufferR = new ArrayBuffer(OpenVR.OverlayIntersectionResultsStruct.byteSize);

const intersectionParamsViewL = new DataView(intersectionParamsBufferL);
const intersectionParamsViewR = new DataView(intersectionParamsBufferR);
const intersectionResultsViewL = new DataView(intersectionResultsBufferL);
const intersectionResultsViewR = new DataView(intersectionResultsBufferR);

const intersectionParamsPointerL = Deno.UnsafePointer.of<OpenVR.OverlayIntersectionParams>(intersectionParamsBufferL)!;
const intersectionParamsPointerR = Deno.UnsafePointer.of<OpenVR.OverlayIntersectionParams>(intersectionParamsBufferR)!;
const intersectionResultsPointerL = Deno.UnsafePointer.of<OpenVR.OverlayIntersectionResults>(intersectionResultsBufferL)!;
const intersectionResultsPointerR = Deno.UnsafePointer.of<OpenVR.OverlayIntersectionResults>(intersectionResultsBufferR)!;

// Get IVROverlay interface
const IVROverlayPtr = OpenVR.VR_GetGenericInterface(stringToPointer(OpenVR.IVROverlay_Version), TypeSafeINITERRPTR);
const vrOverlay = new OpenVR.IVROverlay(IVROverlayPtr);
//#endregion

//#endregion

function main() {

    //#region more boilerplate


    //set action manifest path
    error = vrInput.SetActionManifestPath(manifestPath);
    if (error !== OpenVR.InputError.VRInputError_None) {
        CustomLogger.error("actorerr", `Failed to set action manifest path: ${OpenVR.InputError[error]}`);
        throw new Error("Failed to set action manifest path");
    }


    //
    error = vrInput.GetActionHandle("/actions/main/in/HandPoseLeft", handPoseLeftHandlePTR);
    if (error !== OpenVR.InputError.VRInputError_None) {
        CustomLogger.error("actorerr", `Failed to get action handle: ${OpenVR.InputError[error]}`);
        throw new Error("Failed to get action handle");
    }
    if (handPoseLeftHandlePTR === null) throw new Error("Invalid pointer");
    handPoseLeftHandle = new Deno.UnsafePointerView(handPoseLeftHandlePTR).getBigUint64()


    error = vrInput.GetActionHandle("/actions/main/in/HandPoseRight", handPoseRightHandlePTR);
    if (error !== OpenVR.InputError.VRInputError_None) {
        CustomLogger.error("actorerr", `Failed to get action handle: ${OpenVR.InputError[error]}`);
        throw new Error("Failed to get action handle");
    }
    if (handPoseRightHandlePTR === null) throw new Error("Invalid pointer");
    handPoseRightHandle = new Deno.UnsafePointerView(handPoseRightHandlePTR).getBigUint64()


    error = vrInput.GetActionHandle("/actions/main/in/GrabLeft", grabLeftHandlePTR);
    if (error !== OpenVR.InputError.VRInputError_None) {
        CustomLogger.error("actorerr", `Failed to get left grab action handle: ${OpenVR.InputError[error]}`);
        throw new Error("Failed to get left grab action handle");
    }
    if (grabLeftHandlePTR === null) throw new Error("Invalid pointer");
    grabLeftHandle = new Deno.UnsafePointerView(grabLeftHandlePTR).getBigUint64();

    error = vrInput.GetActionHandle("/actions/main/in/GrabRight", grabRightHandlePTR);
    if (error !== OpenVR.InputError.VRInputError_None) {
        CustomLogger.error("actorerr", `Failed to get right grab action handle: ${OpenVR.InputError[error]}`);
        throw new Error("Failed to get right grab action handle");
    }
    if (grabRightHandlePTR === null) throw new Error("Invalid pointer");
    grabRightHandle = new Deno.UnsafePointerView(grabRightHandlePTR).getBigUint64();

    error = vrInput.GetActionHandle("/actions/main/in/TriggerLeft", triggerLeftHandlePTR);
    if (error !== OpenVR.InputError.VRInputError_None) {
        CustomLogger.error("actorerr", `Failed to get left trigger action handle: ${OpenVR.InputError[error]}`);
        throw new Error("Failed to get left trigger action handle");
    }
    if (triggerLeftHandlePTR === null) throw new Error("Invalid pointer");
    triggerLeftHandle = new Deno.UnsafePointerView(triggerLeftHandlePTR).getBigUint64();

    error = vrInput.GetActionHandle("/actions/main/in/TriggerRight", triggerRightHandlePTR);
    if (error !== OpenVR.InputError.VRInputError_None) {
        CustomLogger.error("actorerr", `Failed to get left trigger action handle: ${OpenVR.InputError[error]}`);
        throw new Error("Failed to get left trigger action handle");
    }
    if (triggerRightHandlePTR === null) throw new Error("Invalid pointer");
    triggerRightHandle = new Deno.UnsafePointerView(triggerRightHandlePTR).getBigUint64();

    //#endregion

}


function updateActionState() {
    const activeActionSet: OpenVR.ActiveActionSet = {
        ulActionSet: actionSetHandle,
        ulRestrictedToDevice: OpenVR.k_ulInvalidInputValueHandle,
        ulSecondaryActionSet: 0n,
        unPadding: 0,
        nPriority: 0
    };
    const activeActionSetSize = OpenVR.ActiveActionSetStruct.byteSize;
    const activeActionSetBuffer = new ArrayBuffer(activeActionSetSize);
    const activeActionSetView = new DataView(activeActionSetBuffer);
    const activeActionSetPtr = Deno.UnsafePointer.of<OpenVR.ActiveActionSet>(activeActionSetBuffer)!;

    OpenVR.ActiveActionSetStruct.write(activeActionSet, activeActionSetView)

    error = vrInput.UpdateActionState(activeActionSetPtr, activeActionSetSize, 1);
    if (error !== OpenVR.InputError.VRInputError_None) {
        CustomLogger.error("actorerr", `Failed to update action state: ${OpenVR.InputError[error]}`);
        throw new Error("Failed to update action state");
    }
}

