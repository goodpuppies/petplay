import { PostMan } from "../submodules/stageforge/mod.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { createStruct, stringToPointer } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";

//steamvr input handling

const state = {
    name: "ovrinput",
    TrackingUniverseOriginPTR: null,
    inputerror: OpenVR.InputError.VRInputError_None,
    targetOverlayHandle: 0n,
    leftWasIntersecting: false,
    rightWasIntersecting: false,
    leftWasGrabbing: false,
    rightWasGrabbing: false,
    overlayActor: "",
    laser: ""
};

new PostMan(state, {
    CUSTOMINIT: (_payload: void) => {main()},
    SETOVERLAYHANDLE: (payload: bigint) => { state.targetOverlayHandle = payload },
    SETOVERLAYACTOR: (payload: string) => {state.overlayActor = payload},
    SETLASER: (payload: string) => {state.laser = payload},
    GETCONTROLLERDATA: (_payload: void) => {
        updateActionState();

        //#region pose
        error = vrInput.GetPoseActionDataRelativeToNow(
            handPoseLeftHandle,
            OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding,
            0,
            posedataleftpointer,
            OpenVR.InputPoseActionDataStruct.byteSize,
            OpenVR.k_ulInvalidInputValueHandle
        );
        if (error !== OpenVR.InputError.VRInputError_None) throw new Error("fail to get pose data")
        error = vrInput.GetPoseActionDataRelativeToNow(
            handPoseRightHandle, // bigint of type OpenVR.ActionHandle
            OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding, //enum
            0, //regular number
            posedatarightpointer, //created by createStruct is type Deno.PointerValue<OpenVR.InputPoseActionData>
            OpenVR.InputPoseActionDataStruct.byteSize, //sized structs have a bytesize
            OpenVR.k_ulInvalidInputValueHandle // not a pointer just a bigint from type export const k_ulInvalidInputValueHandle: InputValueHandle = 0n;//uint64_t
        );
        if (error !== OpenVR.InputError.VRInputError_None) throw new Error("fail to get pose data") //openvr uses return error enum style and instead of return modify a pointer
        const leftPoseData = OpenVR.InputPoseActionDataStruct.read(poseDataViewL);
        const rightPoseData = OpenVR.InputPoseActionDataStruct.read(poseDataViewR);
        //#endregion

        //#region grab
        error = vrInput.GetDigitalActionData(
            grabLeftHandle,
            grabLeftPointer,
            OpenVR.InputDigitalActionDataStruct.byteSize,
            OpenVR.k_ulInvalidInputValueHandle
        );
        //if (error !== OpenVR.InputError.VRInputError_None) throw new Error("fail to get action data")
        error = vrInput.GetDigitalActionData(
            grabRightHandle,
            grabRightPointer,
            OpenVR.InputDigitalActionDataStruct.byteSize,
            OpenVR.k_ulInvalidInputValueHandle
        );
        //if (error !== OpenVR.InputError.VRInputError_None) throw new Error("fail to get action data")
        const leftGrabData = OpenVR.InputDigitalActionDataStruct.read(grabDataViewL);
        const rightGrabData = OpenVR.InputDigitalActionDataStruct.read(grabDataViewR);

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
        //#endregion

        //#region trigger
        error = vrInput.GetDigitalActionData(
            triggerLeftHandle,
            triggerLeftPointer,
            OpenVR.InputDigitalActionDataStruct.byteSize,
            OpenVR.k_ulInvalidInputValueHandle
        );
        if (error !== OpenVR.InputError.VRInputError_None) throw new Error("fail to get action data")
        error = vrInput.GetDigitalActionData(
            triggerRightHandle,
            triggerRightPointer,
            OpenVR.InputDigitalActionDataStruct.byteSize,
            OpenVR.k_ulInvalidInputValueHandle
        );
        if (error !== OpenVR.InputError.VRInputError_None) throw new Error("fail to get action data")
        const leftTriggerData = OpenVR.InputDigitalActionDataStruct.read(triggerDataViewL);
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
            leftGrabData,
            rightGrabData
        ]
        return payload
    },
    CHECKINTERSECTION: (payload: [OpenVR.InputPoseActionData, OpenVR.InputPoseActionData, OpenVR.InputDigitalActionData, OpenVR.InputDigitalActionData]) => {
        const leftPoseData = payload[0]
        const rightPoseData = payload[1]
        const leftGrabData = payload[2]
        const rightGrabData = payload[3]
        if (leftGrabData.bState && !rightGrabData.bState) {
            const m = leftPoseData.pose.mDeviceToAbsoluteTracking.m;
            const leftForward = {
                v: [
                    m[2][0],
                    m[2][1],
                    -m[2][2]
                ]
            };
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
            const result = vrOverlay.ComputeOverlayIntersection(
                state.targetOverlayHandle,
                intersectionParamsPointerL,
                intersectionResultsPointerL
            );

            if (result) {
                console.log("left intersection")
                return OpenVR.OverlayIntersectionResultsStruct.read(intersectionResultsViewL);
            } 
        }
        if (!leftGrabData.bState && rightGrabData.bState) {
            const m = rightPoseData.pose.mDeviceToAbsoluteTracking.m;
            const rightForward = {
                v: [
                    m[2][0],
                    m[2][1],
                    -m[2][2]
                ]
            };
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
            const result = vrOverlay.ComputeOverlayIntersection(
                state.targetOverlayHandle,
                intersectionParamsPointerR,
                intersectionResultsPointerR
            );

            if (result) {
                return OpenVR.OverlayIntersectionResultsStruct.read(intersectionResultsViewR);
            } 
        }
        //if both left overwrites
        if (leftGrabData.bState && rightGrabData.bState) {
            const m = leftPoseData.pose.mDeviceToAbsoluteTracking.m;
            const leftForward = {
                v: [
                    m[2][0],
                    m[2][1],
                    -m[2][2]
                ]
            };
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
            const result = vrOverlay.ComputeOverlayIntersection(
                state.targetOverlayHandle,
                intersectionParamsPointerL,
                intersectionResultsPointerL
            );

            if (result) {
                console.log("left intersection")
                return OpenVR.OverlayIntersectionResultsStruct.read(intersectionResultsViewL);
            }
        }
    }
} as const);


function main() {

    //get action handles
    error = vrInput.SetActionManifestPath(manifestPath);
    if (error !== OpenVR.InputError.VRInputError_None) throw new Error("Failed to set action manifest path");

    error = vrInput.GetActionHandle("/actions/main/in/HandPoseLeft", handPoseLeftHandlePTR);
    if (error !== OpenVR.InputError.VRInputError_None) throw new Error("Failed to get action handle");
    handPoseLeftHandle = new Deno.UnsafePointerView(handPoseLeftHandlePTR).getBigUint64()

    error = vrInput.GetActionHandle("/actions/main/in/HandPoseRight", handPoseRightHandlePTR);
    if (error !== OpenVR.InputError.VRInputError_None) throw new Error("Failed to get action handle");
    handPoseRightHandle = new Deno.UnsafePointerView(handPoseRightHandlePTR).getBigUint64()

    error = vrInput.GetActionHandle("/actions/main/in/GrabLeft", grabLeftHandlePTR);
    if (error !== OpenVR.InputError.VRInputError_None) throw new Error("Failed to get left grab action handle");
    grabLeftHandle = new Deno.UnsafePointerView(grabLeftHandlePTR).getBigUint64();

    error = vrInput.GetActionHandle("/actions/main/in/GrabRight", grabRightHandlePTR);
    if (error !== OpenVR.InputError.VRInputError_None) throw new Error("Failed to get right grab action handle");
    grabRightHandle = new Deno.UnsafePointerView(grabRightHandlePTR).getBigUint64();

    error = vrInput.GetActionHandle("/actions/main/in/TriggerLeft", triggerLeftHandlePTR);
    if (error !== OpenVR.InputError.VRInputError_None) throw new Error("Failed to get left trigger action handle");
    triggerLeftHandle = new Deno.UnsafePointerView(triggerLeftHandlePTR).getBigUint64();

    error = vrInput.GetActionHandle("/actions/main/in/TriggerRight", triggerRightHandlePTR);
    if (error !== OpenVR.InputError.VRInputError_None) throw new Error("Failed to get left trigger action handle");
    triggerRightHandle = new Deno.UnsafePointerView(triggerRightHandlePTR).getBigUint64();
}


function updateActionState() {
    const activeActionSet: OpenVR.ActiveActionSet = {
        ulActionSet: actionSetHandle,
        ulRestrictedToDevice: OpenVR.k_ulInvalidInputValueHandle,
        ulSecondaryActionSet: 0n,
        unPadding: 0,
        nPriority: 0
    };
    const [activeActionSetPtr, _activeActionSetView] = createStruct<OpenVR.ActiveActionSet>(activeActionSet, OpenVR.ActiveActionSetStruct)
    error = vrInput.UpdateActionState(activeActionSetPtr, OpenVR.ActiveActionSetStruct.byteSize, 1);
    if (error !== OpenVR.InputError.VRInputError_None) throw new Error("Failed to update action state");
}

//#region boilerplate data setup
let error;
await OpenVR.initializeOpenVR("../resources/openvr_api");
const manifestPath = Deno.realPathSync("../resources/actions.json");
const initerrorptr = Deno.UnsafePointer.of<OpenVR.InitError>(new Int32Array(1))!
const TypeSafeINITERRPTR: OpenVR.InitErrorPTRType = initerrorptr
const IVRInputPtr = OpenVR.VR_GetGenericInterface(stringToPointer(OpenVR.IVRInput_Version), TypeSafeINITERRPTR);
const vrInput = new OpenVR.IVRInput(IVRInputPtr);

//get action set handle
const actionSetHandlePTR = P.BigUint64P<OpenVR.ActionSetHandle>();
error = vrInput.GetActionSetHandle("/actions/main", actionSetHandlePTR);
if (error !== OpenVR.InputError.VRInputError_None) throw new Error("Failed to get action set handle");
const actionSetHandle = new Deno.UnsafePointerView(actionSetHandlePTR).getBigUint64();

let handPoseLeftHandle: OpenVR.ActionHandle = OpenVR.k_ulInvalidActionHandle;
let handPoseRightHandle: OpenVR.ActionHandle = OpenVR.k_ulInvalidActionHandle;
const handPoseLeftHandlePTR = P.BigUint64P<OpenVR.ActionHandle>();
const handPoseRightHandlePTR = P.BigUint64P<OpenVR.ActionHandle>();

let triggerLeftHandle: OpenVR.ActionHandle = OpenVR.k_ulInvalidActionHandle;
let triggerRightHandle: OpenVR.ActionHandle = OpenVR.k_ulInvalidActionHandle;
const triggerLeftHandlePTR = P.BigUint64P<OpenVR.ActionHandle>();
const triggerRightHandlePTR = P.BigUint64P<OpenVR.ActionHandle>();

let grabLeftHandle: OpenVR.ActionHandle = OpenVR.k_ulInvalidActionHandle;
let grabRightHandle: OpenVR.ActionHandle = OpenVR.k_ulInvalidActionHandle;
const grabLeftHandlePTR = P.BigUint64P<OpenVR.ActionHandle>();
const grabRightHandlePTR = P.BigUint64P<OpenVR.ActionHandle>();


const [posedataleftpointer, poseDataViewL] = createStruct<OpenVR.InputPoseActionData>(null, OpenVR.InputPoseActionDataStruct)
const [posedatarightpointer, poseDataViewR] = createStruct<OpenVR.InputPoseActionData>(null, OpenVR.InputPoseActionDataStruct)

const [triggerLeftPointer, triggerDataViewL] = createStruct<OpenVR.InputDigitalActionData>(null, OpenVR.InputDigitalActionDataStruct)
const [triggerRightPointer, triggerDataViewR] = createStruct<OpenVR.InputDigitalActionData>(null, OpenVR.InputDigitalActionDataStruct)

const [grabLeftPointer, grabDataViewL] = createStruct<OpenVR.InputDigitalActionData>(null, OpenVR.InputDigitalActionDataStruct)
const [grabRightPointer, grabDataViewR] = createStruct<OpenVR.InputDigitalActionData>(null, OpenVR.InputDigitalActionDataStruct)

const [intersectionParamsPointerL, intersectionParamsViewL] = createStruct<OpenVR.OverlayIntersectionParams>(null, OpenVR.OverlayIntersectionParamsStruct)
const [intersectionParamsPointerR, intersectionParamsViewR] = createStruct<OpenVR.OverlayIntersectionParams>(null, OpenVR.OverlayIntersectionParamsStruct)
const [intersectionResultsPointerL, intersectionResultsViewL] = createStruct<OpenVR.OverlayIntersectionResults>(null, OpenVR.OverlayIntersectionResultsStruct)
const [intersectionResultsPointerR, intersectionResultsViewR] = createStruct<OpenVR.OverlayIntersectionResults>(null, OpenVR.OverlayIntersectionResultsStruct)

const vrOverlay = new OpenVR.IVROverlay(OpenVR.VR_GetGenericInterface(stringToPointer(OpenVR.IVROverlay_Version), TypeSafeINITERRPTR));
//#endregion