
import {
    TypedActorFunctions,
    BaseState,
    worker,
    MessageAddressReal,
} from "../actorsystem/types.ts";
import { OnMessage, Postman } from "../classes/PostMan.ts";
import * as OpenVR from "../OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { fillBuffer, readBufferStructured, stringToPointer } from "../OpenVR_TS_Bindings_Deno/utils.ts";
import { P } from "../OpenVR_TS_Bindings_Deno/pointers.ts";
import { CustomLogger } from "../classes/customlogger.ts";

//steamvr input handling

type State = {
    id: string;
    db: Record<string, unknown>;
    [key: string]: unknown;
};

const state: State & BaseState = {
    id: "",
    db: {},
    TrackingUniverseOriginPTR: null,
    name: "ovrinput",
    inputerror: OpenVR.InputError.VRInputError_None,
    socket: null,
    addressBook: new Set(),
};

const functions: TypedActorFunctions = {
    CUSTOMINIT: (_payload) => {
        //Postman.functions?.HYPERSWARM?.(null, state.id);
        main()
    },
    LOG: (_payload) => {
        CustomLogger.log("actor", state.id);
    },
    GETID: (_payload, address) => {
        // use a check here
        const addr = address as MessageAddressReal;
        Postman.PostMessage({
            address: { fm: state.id, to: addr.fm },
            type: "CB:GETID",
            payload: state.id,
        }, false);
    },
    GETCONTROLLERDATA: (_payload, address) => {
        const addr = address as MessageAddressReal;
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

        Postman.PostMessage({
            address: { fm: state.id, to: addr.fm },
            type: "CB:GETCONTROLLERDATA",
            payload: [leftPoseData, rightPoseData, leftTriggerData, rightTriggerData]
        });
    }
};

//#region openvr boilerplate 

//#region input
let error;
const manifestPath = Deno.realPathSync("./resources/actions.json");
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




const triggerDataSize = OpenVR.InputDigitalActionDataStruct.byteSize;
const triggerDataBufferL = new ArrayBuffer(triggerDataSize);
const triggerDataBufferR = new ArrayBuffer(triggerDataSize);
const triggerDataViewL = new DataView(triggerDataBufferL);
const triggerDataViewR = new DataView(triggerDataBufferR);
const triggerLeftPointer = Deno.UnsafePointer.of<OpenVR.InputDigitalActionData>(triggerDataBufferL)!;
const triggerRightPointer = Deno.UnsafePointer.of<OpenVR.InputDigitalActionData>(triggerDataBufferR)!;


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
    handPoseLeftHandle = new Deno.UnsafePointerView(handPoseLeftHandlePTR).getBigUint64();


    error = vrInput.GetActionHandle("/actions/main/in/HandPoseRight", handPoseRightHandlePTR);
    if (error !== OpenVR.InputError.VRInputError_None) {
        CustomLogger.error("actorerr", `Failed to get action handle: ${OpenVR.InputError[error]}`);
        throw new Error("Failed to get action handle");
    }
    if (handPoseRightHandlePTR === null) throw new Error("Invalid pointer");
    handPoseRightHandle = new Deno.UnsafePointerView(handPoseRightHandlePTR).getBigUint64();


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


new Postman(worker, functions, state);

OnMessage((message) => {
    Postman.runFunctions(message);
});
