import { PostMan, actorState } from "../submodules/stageforge/mod.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { createStruct, stringToPointer } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { tempFile } from "../classes/utils.ts";
import {
  CONTROLLER_SAB_BYTE_LENGTH,
  type ControllerExternalDataTuple,
  readControllerStateSab,
  writeControllerStateSab,
} from "../classes/controllerStateSab.ts";
import { dirname, join, extname } from "jsr:@std/path";

/**
 * SAB is filled on a **drift-correcting ~1ms timer**; cannot await a cross-actor `sample` in
 * the webxr rAF (would invalidate `XRFrame` before `advance()`).
 */
const CONTROLLER_SAB_PERIOD_MS = 1;

//steamvr input handling

const state = actorState({
  name: "ovrinput",
  TrackingUniverseOriginPTR: null,
  inputerror: OpenVR.InputError.VRInputError_None,
  vrInput: null as null | OpenVR.IVRInput,
  vrOverlay: null as null | OpenVR.IVROverlay,
  targetOverlayHandle: 0n,
  leftWasIntersecting: false,
  rightWasIntersecting: false,
  leftWasGrabbing: false,
  rightWasGrabbing: false,
  overlayActor: "",
  laser: "",
  /** Filled by `webxr` via `SETCONTROLLERSHAREDSTATE`; the writer loop mirrors samples here. */
  controllerSharedBuffer: null as SharedArrayBuffer | null,
  controllerSabLoopActive: false,
  /** `setTimeout` id for the SAB writer, or `null` when not scheduled. */
  controllerSabFrameHandle: null as number | null,
  /**
   * Latest `sampleControllerData` when SAB is on — `GETCONTROLLERDATA` returns this
   * without re-entering OpenVR so other actors (laser, main) do not block the writer.
   */
  lastControllerSample: null as ControllerExternalDataTuple | null,
  /**
   * When set, the **webxr** worker is the only writer (`writeControllerStateSab` each XR rAF);
   * this actor only reads the buffer for `GETCONTROLLERDATA` (e.g. laser), no 1ms loop.
   */
  controllerMirrorFromWebxr: false,
});

new PostMan(state, {
  __INIT__: (_payload: void) => {},
  SETOVERLAYHANDLE: (payload: bigint) => { state.targetOverlayHandle = payload },
  SETOVERLAYACTOR: (payload: string) => {state.overlayActor = payload},
  SETLASER: (payload: string) => { state.laser = payload },
  INITINPUT: (payload)  => {
    const inputPtr = Deno.UnsafePointer.create(payload[0]);
    const overlayPtr = Deno.UnsafePointer.create(payload[1])
    state.vrInput = new OpenVR.IVRInput(inputPtr);
    state.vrOverlay = new OpenVR.IVROverlay(overlayPtr)
    main()
  },
  /**
   * - `null`: detach.
   * - `SharedArrayBuffer` (legacy): this actor’s **~1ms** loop writes OpenVR → SAB; webxr rAF
   *   only *reads* (can’t `await` a cross-actor `sample` without invalidating `XRFrame`).
   * - `{ sab, webxrPacedWriter: true }`: **webxr** writes each XR rAF (display-paced); this
   *   actor only reads for `GETCONTROLLERDATA`.
   */
  SETCONTROLLERSHAREDSTATE: (
    payload: SharedArrayBuffer | null | { sab: SharedArrayBuffer; webxrPacedWriter: true },
  ) => {
    if (payload === null) {
      state.controllerSabLoopActive = false;
      state.controllerSharedBuffer = null;
      state.controllerMirrorFromWebxr = false;
      state.lastControllerSample = null;
      if (state.controllerSabFrameHandle != null) {
        clearTimeout(state.controllerSabFrameHandle);
        state.controllerSabFrameHandle = null;
      }
      return true;
    }
    if (state.controllerSabFrameHandle != null) {
      clearTimeout(state.controllerSabFrameHandle);
      state.controllerSabFrameHandle = null;
    }
    if (
      typeof payload === "object" &&
      payload !== null &&
      "sab" in payload &&
      (payload as { webxrPacedWriter?: boolean }).webxrPacedWriter === true
    ) {
      const { sab } = payload as { sab: SharedArrayBuffer; webxrPacedWriter: true };
      if (!(sab instanceof SharedArrayBuffer) || sab.byteLength !== CONTROLLER_SAB_BYTE_LENGTH) {
        throw new Error(
          `SETCONTROLLERSHAREDSTATE: expected SharedArrayBuffer of ${CONTROLLER_SAB_BYTE_LENGTH} bytes`,
        );
      }
      state.controllerSharedBuffer = sab;
      state.controllerMirrorFromWebxr = true;
      state.controllerSabLoopActive = false;
      state.lastControllerSample = null;
      return true;
    }
    if (!(payload instanceof SharedArrayBuffer) || payload.byteLength !== CONTROLLER_SAB_BYTE_LENGTH) {
      throw new Error(
        `SETCONTROLLERSHAREDSTATE: expected SharedArrayBuffer of ${CONTROLLER_SAB_BYTE_LENGTH} bytes`,
      );
    }
    state.controllerSharedBuffer = payload;
    state.controllerMirrorFromWebxr = false;
    state.controllerSabLoopActive = true;
    state.lastControllerSample = null;
    scheduleControllerSabFrame();
    return true;
  },
  /**
   * When SAB is active, returns the last sample from the SAB writer (no OpenVR call)
   * so polling actors do not starve the writer. If no sample yet, runs one `sampleControllerData()`.
   * When SAB is off, does a full OpenVR sample.
   */
  GETCONTROLLERDATA: (_payload: void) => {
    if (state.controllerSharedBuffer && state.controllerMirrorFromWebxr) {
      const r = readControllerStateSab(state.controllerSharedBuffer);
      if (r) {
        return r.data;
      }
      return sampleControllerData();
    }
    if (state.controllerSharedBuffer) {
      if (state.lastControllerSample) {
        return state.lastControllerSample;
      }
      return sampleControllerData();
    }
    return sampleControllerData();
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
    if (!state.vrOverlay) { throw new Error("write a better error") }
  const result = state.vrOverlay.ComputeOverlayIntersection(
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
    if (!state.vrOverlay) { throw new Error("write a better error") }
  const result = state.vrOverlay.ComputeOverlayIntersection(
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
    if (!state.vrOverlay) { throw new Error("write a better error") }
  const result = state.vrOverlay.ComputeOverlayIntersection(
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

let actionSetHandle: bigint
let error;
const manifestPath = tempFile("./resources/actions.json", import.meta.dirname!)
console.log("manifestPath: ", manifestPath)

function main() {

  //get action handles
  
  if (!state.vrInput) { throw new Error("write a better error") }
  if (!state.vrOverlay) { throw new Error("write a better error") }
  error = state.vrInput.SetActionManifestPath(manifestPath);
  if (error !== OpenVR.InputError.VRInputError_None) throw new Error("Failed to set action manifest path");

  error = state.vrInput.GetActionHandle("/actions/main/in/HandPoseLeft", handPoseLeftHandlePTR);
  if (error !== OpenVR.InputError.VRInputError_None) throw new Error("Failed to get action handle");
  handPoseLeftHandle = new Deno.UnsafePointerView(handPoseLeftHandlePTR).getBigUint64()

  error = state.vrInput.GetActionHandle("/actions/main/in/HandPoseRight", handPoseRightHandlePTR);
  if (error !== OpenVR.InputError.VRInputError_None) throw new Error("Failed to get action handle");
  handPoseRightHandle = new Deno.UnsafePointerView(handPoseRightHandlePTR).getBigUint64()

  error = state.vrInput.GetActionHandle("/actions/main/in/GrabLeft", grabLeftHandlePTR);
  if (error !== OpenVR.InputError.VRInputError_None) throw new Error("Failed to get left grab action handle");
  grabLeftHandle = new Deno.UnsafePointerView(grabLeftHandlePTR).getBigUint64();

  error = state.vrInput.GetActionHandle("/actions/main/in/GrabRight", grabRightHandlePTR);
  if (error !== OpenVR.InputError.VRInputError_None) throw new Error("Failed to get right grab action handle");
  grabRightHandle = new Deno.UnsafePointerView(grabRightHandlePTR).getBigUint64();

  error = state.vrInput.GetActionHandle("/actions/main/in/TriggerLeft", triggerLeftHandlePTR);
  if (error !== OpenVR.InputError.VRInputError_None) throw new Error("Failed to get left trigger action handle");
  triggerLeftHandle = new Deno.UnsafePointerView(triggerLeftHandlePTR).getBigUint64();

  error = state.vrInput.GetActionHandle("/actions/main/in/TriggerRight", triggerRightHandlePTR);
  if (error !== OpenVR.InputError.VRInputError_None) throw new Error("Failed to get left trigger action handle");
  triggerRightHandle = new Deno.UnsafePointerView(triggerRightHandlePTR).getBigUint64();

  if (!state.vrInput) { throw new Error("write a better error") }
  const actionSetHandlePTR = P.BigUint64P<OpenVR.ActionSetHandle>();
  error = state.vrInput.GetActionSetHandle("/actions/main", actionSetHandlePTR);
  if (error !== OpenVR.InputError.VRInputError_None) throw new Error("Failed to get action set handle");
  actionSetHandle = new Deno.UnsafePointerView(actionSetHandlePTR).getBigUint64();

  let hErr = state.vrInput.GetInputSourceHandle("/user/hand/left", leftHandPathHandlePTR);
  if (hErr === OpenVR.InputError.VRInputError_None) {
    leftHandPathHandle = new Deno.UnsafePointerView(leftHandPathHandlePTR).getBigUint64();
  } else {
    leftHandPathHandle = OpenVR.k_ulInvalidInputValueHandle;
    console.warn(`[ovrinput] GetInputSourceHandle /user/hand/left: ${hErr}`);
  }
  hErr = state.vrInput.GetInputSourceHandle("/user/hand/right", rightHandPathHandlePTR);
  if (hErr === OpenVR.InputError.VRInputError_None) {
    rightHandPathHandle = new Deno.UnsafePointerView(rightHandPathHandlePTR).getBigUint64();
  } else {
    rightHandPathHandle = OpenVR.k_ulInvalidInputValueHandle;
    console.warn(`[ovrinput] GetInputSourceHandle /user/hand/right: ${hErr}`);
  }
  dualActiveActionSetBuffer = new ArrayBuffer(OpenVR.ActiveActionSetStruct.byteSize * 2);
}


function updateActionState() {
  if (!state.vrInput) { throw new Error("write a better error") }
  if (dualActiveActionSetBuffer) {
    const b = dualActiveActionSetBuffer;
    const w = OpenVR.ActiveActionSetStruct.byteSize;
    const view0 = new DataView(b, 0, w);
    const view1 = new DataView(b, w, w);
    const base = {
      ulActionSet: actionSetHandle,
      ulSecondaryActionSet: 0n as OpenVR.ActionSetHandle,
      unPadding: 0,
      nPriority: 0,
    };
    OpenVR.ActiveActionSetStruct.write(
      { ...base, ulRestrictedToDevice: leftHandPathHandle },
      view0,
    );
    OpenVR.ActiveActionSetStruct.write(
      { ...base, ulRestrictedToDevice: rightHandPathHandle },
      view1,
    );
    const ptr = Deno.UnsafePointer.of(b) as Deno.PointerValue<OpenVR.ActiveActionSet>;
    error = state.vrInput.UpdateActionState(ptr, w, 2);
    if (error !== OpenVR.InputError.VRInputError_None) {
      throw new Error("Failed to update action state (dual set)");
    }
    return;
  }
  const activeActionSet: OpenVR.ActiveActionSet = {
    ulActionSet: actionSetHandle,
    ulRestrictedToDevice: OpenVR.k_ulInvalidInputValueHandle,
    ulSecondaryActionSet: 0n,
    unPadding: 0,
    nPriority: 0,
  };
  const [activeActionSetPtr, _activeActionSetView] = createStruct<OpenVR.ActiveActionSet>(
    activeActionSet,
    OpenVR.ActiveActionSetStruct,
  );
  error = state.vrInput.UpdateActionState(activeActionSetPtr, OpenVR.ActiveActionSetStruct.byteSize, 1);
  if (error !== OpenVR.InputError.VRInputError_None) throw new Error("Failed to update action state");
}

//#region boilerplate data setup





//get action set handle



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

/** Aardvark `doInputWork`: `UpdateActionState` ×2 with `ulRestrictedToDevice` per hand. */
let leftHandPathHandle: OpenVR.InputValueHandle = OpenVR.k_ulInvalidInputValueHandle;
let rightHandPathHandle: OpenVR.InputValueHandle = OpenVR.k_ulInvalidInputValueHandle;
const leftHandPathHandlePTR = P.BigUint64P<OpenVR.InputValueHandle>();
const rightHandPathHandlePTR = P.BigUint64P<OpenVR.InputValueHandle>();
let dualActiveActionSetBuffer: ArrayBuffer | null = null;

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

//#endregion

function poseReadOk(e: OpenVR.InputError): boolean {
  return e === OpenVR.InputError.VRInputError_None ||
    e === OpenVR.InputError.VRInputError_NoData ||
    e === OpenVR.InputError.VRInputError_InvalidDevice;
}

function sampleControllerData(): ControllerExternalDataTuple {
  if (!state.vrInput) { throw new Error("write a better error") }
  if (!state.vrOverlay) { throw new Error("write a better error") }
  updateActionState();

  // Aardvark `getActionStateForHand`: GetPoseActionDataForNextFrame(..., pathDevice per hand).
  error = state.vrInput.GetPoseActionDataForNextFrame(
    handPoseLeftHandle,
    OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding,
    posedataleftpointer,
    OpenVR.InputPoseActionDataStruct.byteSize,
    leftHandPathHandle,
  );
  if (!poseReadOk(error)) throw new Error(`fail to get left pose data: ${error}`);
  error = state.vrInput.GetPoseActionDataForNextFrame(
    handPoseRightHandle,
    OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding,
    posedatarightpointer,
    OpenVR.InputPoseActionDataStruct.byteSize,
    rightHandPathHandle,
  );
  if (!poseReadOk(error)) throw new Error(`fail to get right pose data: ${error}`);
  const leftPoseData = OpenVR.InputPoseActionDataStruct.read(poseDataViewL);
  const rightPoseData = OpenVR.InputPoseActionDataStruct.read(poseDataViewR);

  error = state.vrInput.GetDigitalActionData(
    grabLeftHandle,
    grabLeftPointer,
    OpenVR.InputDigitalActionDataStruct.byteSize,
    leftHandPathHandle,
  );
  error = state.vrInput.GetDigitalActionData(
    grabRightHandle,
    grabRightPointer,
    OpenVR.InputDigitalActionDataStruct.byteSize,
    rightHandPathHandle,
  );
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

  error = state.vrInput.GetDigitalActionData(
    triggerLeftHandle,
    triggerLeftPointer,
    OpenVR.InputDigitalActionDataStruct.byteSize,
    leftHandPathHandle,
  );
  if (error !== OpenVR.InputError.VRInputError_None) throw new Error("fail to get action data");
  error = state.vrInput.GetDigitalActionData(
    triggerRightHandle,
    triggerRightPointer,
    OpenVR.InputDigitalActionDataStruct.byteSize,
    rightHandPathHandle,
  );
  if (error !== OpenVR.InputError.VRInputError_None) throw new Error("fail to get action data");
  const leftTriggerData = OpenVR.InputDigitalActionDataStruct.read(triggerDataViewL);
  const rightTriggerData = OpenVR.InputDigitalActionDataStruct.read(triggerDataViewR);

  state.leftWasGrabbing = leftGrabData.bState as unknown as boolean;
  state.rightWasGrabbing = rightGrabData.bState as unknown as boolean;

  return [
  leftPoseData,
  rightPoseData,
  leftTriggerData,
  rightTriggerData,
  leftGrabData,
  rightGrabData
  ];
}

function scheduleControllerSabFrame() {
  if (!state.controllerSabLoopActive || !state.controllerSharedBuffer) {
    state.controllerSabFrameHandle = null;
    return;
  }
  const t0 = performance.now();
  const buf = state.controllerSharedBuffer;
  if (state.vrInput) {
    try {
      const payload = sampleControllerData();
      state.lastControllerSample = payload;
      writeControllerStateSab(buf, payload);
    } catch {
      // OpenVR not ready; keep scheduling so we recover when it is.
    }
  }
  const workMs = performance.now() - t0;
  const delay = Math.max(0, CONTROLLER_SAB_PERIOD_MS - workMs);
  state.controllerSabFrameHandle = setTimeout(
    scheduleControllerSabFrame,
    delay,
  ) as unknown as number;
}