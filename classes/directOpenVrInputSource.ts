/**
 * Single source of truth for app-wide OpenVR input (HMD, controller poses, and
 * eventually button / analog state). Populated from the same
 * `OpenVrOverlayFramePacer` cycle that drives the smooth Raylib debug-cube
 * rendering path, so consumers can share that prediction horizon instead of
 * each computing their own (which is the current source of jitter in the
 * IVRInput / iwer → r3f path).
 *
 * Design notes:
 * - All per-frame updates are **allocation-free**. Pose components are copied
 *   into preallocated `Float32Array` buffers; the snapshot object itself is
 *   stable (same object identity across frames) and its inner hand/hmd objects
 *   are either stable or `null`.
 * - `Float32Array` fields on the returned snapshot are **shared mutating
 *   buffers**. Consumers that need stable copies must `slice()` themselves.
 * - Buttons are read directly from OpenVR IVRInput using the action manifest
 *   when {@link initialize} is called. {@link updateActionState} must be
 *   invoked each frame before consumers read the snapshot.
 */

import { gameInputBlocking } from "./environment/gameInputBlocking.ts";
import type { OpenVrHmdEmulationPose } from "./openVrOverlayFramePacing.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { getSetting } from "./settings.ts";

/** Release band below the grab threshold to prevent chatter while holding a squeeze. */
const GRAB_HYSTERESIS = 0.10;

/** Evaluates an analog grip force (0..1) against `threshold` with hysteresis. */
export function applyGrabThreshold(force: number, wasHeld: boolean, threshold: number): boolean {
  if (!Number.isFinite(force)) return false;
  const clamped = Math.min(0.95, Math.max(0.05, threshold));
  if (wasHeld) {
    return force >= Math.max(0.02, clamped - GRAB_HYSTERESIS);
  }
  return force >= clamped;
}
import { tempFile } from "./utils.ts";
import { type HapticPulse, setHapticSink } from "./environment/haptics.ts";

export type DirectOpenVrHmdPose = {
  /** Column-major 4x4 world-from-HMD matrix. */
  matrix: Float32Array;
  /** XYZ world position. */
  position: Float32Array;
  /** XYZW world-orientation quaternion. */
  quaternion: Float32Array;
};

export type DirectOpenVrControllerPose = {
  /** XYZ world-space position (meters). */
  position: Float32Array;
  /** XYZW world-orientation quaternion. */
  quaternion: Float32Array;
  /** Trigger button state (0-1). */
  trigger: number;
  /** Grab/squeeze button state (0-1). */
  grab: number;
  joystick: Float32Array;
};

export type DirectOpenVrInputSnapshot = {
  hmd: DirectOpenVrHmdPose | null;
  controllers: {
    left: DirectOpenVrControllerPose | null;
    right: DirectOpenVrControllerPose | null;
  };
};

export class DirectOpenVrInputSource {
  private readonly hmdBuffers = {
    matrix: new Float32Array(16),
    position: new Float32Array(3),
    quaternion: new Float32Array(4),
  };
  private readonly leftBuffers = {
    position: new Float32Array(3),
    quaternion: new Float32Array(4),
    trigger: new Float32Array(1),
    grab: new Float32Array(1),
    joystick: new Float32Array(2),
  };
  private readonly rightBuffers = {
    position: new Float32Array(3),
    quaternion: new Float32Array(4),
    trigger: new Float32Array(1),
    grab: new Float32Array(1),
    joystick: new Float32Array(2),
  };

  private readonly hmdView: DirectOpenVrHmdPose = {
    matrix: this.hmdBuffers.matrix,
    position: this.hmdBuffers.position,
    quaternion: this.hmdBuffers.quaternion,
  };
  private readonly leftView: DirectOpenVrControllerPose = {
    position: this.leftBuffers.position,
    quaternion: this.leftBuffers.quaternion,
    trigger: this.leftBuffers.trigger[0],
    grab: this.leftBuffers.grab[0],
    joystick: this.leftBuffers.joystick,
  };
  private readonly rightView: DirectOpenVrControllerPose = {
    position: this.rightBuffers.position,
    quaternion: this.rightBuffers.quaternion,
    trigger: this.rightBuffers.trigger[0],
    grab: this.rightBuffers.grab[0],
    joystick: this.rightBuffers.joystick,
  };

  private hmdValid = false;
  private leftValid = false;
  private rightValid = false;

  private vrInput: OpenVR.IVRInput | null = null;
  private inputReady = false;
  private readonly rightClickModifier = { left: false, right: false };
  private readonly middleClickModifier = { left: false, right: false };
  private spaceDragHeld = false;

  private grabLeftHandle = OpenVR.k_ulInvalidActionHandle;
  private grabRightHandle = OpenVR.k_ulInvalidActionHandle;
  private grabForceLeftHandle = OpenVR.k_ulInvalidActionHandle;
  private grabForceRightHandle = OpenVR.k_ulInvalidActionHandle;
  private grabForceLeftHeld = false;
  private grabForceRightHeld = false;
  private triggerLeftHandle = OpenVR.k_ulInvalidActionHandle;
  private triggerRightHandle = OpenVR.k_ulInvalidActionHandle;
  private joystickLeftHandle = OpenVR.k_ulInvalidActionHandle;
  private joystickRightHandle = OpenVR.k_ulInvalidActionHandle;
  private rightClickModifierHandle = OpenVR.k_ulInvalidActionHandle;
  private middleClickModifierHandle = OpenVR.k_ulInvalidActionHandle;
  private spaceDragHandle = OpenVR.k_ulInvalidActionHandle;
  private hapticHandle = OpenVR.k_ulInvalidActionHandle;
  private actionSetHandle = OpenVR.k_ulInvalidActionSetHandle;
  private leftHandPathHandle = OpenVR.k_ulInvalidInputValueHandle;
  private rightHandPathHandle = OpenVR.k_ulInvalidInputValueHandle;

  private readonly grabLeft = createStruct<OpenVR.InputDigitalActionData>(
    null,
    OpenVR.InputDigitalActionDataStruct,
  );
  private readonly grabRight = createStruct<OpenVR.InputDigitalActionData>(
    null,
    OpenVR.InputDigitalActionDataStruct,
  );
  private readonly triggerLeft = createStruct<OpenVR.InputDigitalActionData>(
    null,
    OpenVR.InputDigitalActionDataStruct,
  );
  private readonly triggerRight = createStruct<OpenVR.InputDigitalActionData>(
    null,
    OpenVR.InputDigitalActionDataStruct,
  );
  private readonly rightClickModifierLeft = createStruct<OpenVR.InputDigitalActionData>(
    null,
    OpenVR.InputDigitalActionDataStruct,
  );
  private readonly rightClickModifierRight = createStruct<OpenVR.InputDigitalActionData>(
    null,
    OpenVR.InputDigitalActionDataStruct,
  );
  private readonly middleClickModifierLeft = createStruct<OpenVR.InputDigitalActionData>(
    null,
    OpenVR.InputDigitalActionDataStruct,
  );
  private readonly middleClickModifierRight = createStruct<OpenVR.InputDigitalActionData>(
    null,
    OpenVR.InputDigitalActionDataStruct,
  );
  private readonly spaceDragLeft = createStruct<OpenVR.InputDigitalActionData>(
    null,
    OpenVR.InputDigitalActionDataStruct,
  );
  private readonly joystickLeft = createStruct<OpenVR.InputAnalogActionData>(
    null,
    OpenVR.InputAnalogActionDataStruct,
  );
  private readonly joystickRight = createStruct<OpenVR.InputAnalogActionData>(
    null,
    OpenVR.InputAnalogActionDataStruct,
  );
  private readonly grabForceLeft = createStruct<OpenVR.InputAnalogActionData>(
    null,
    OpenVR.InputAnalogActionDataStruct,
  );
  private readonly grabForceRight = createStruct<OpenVR.InputAnalogActionData>(
    null,
    OpenVR.InputAnalogActionDataStruct,
  );

  private dualActiveActionSetBuffer: ArrayBuffer | null = null;

  /** Stable snapshot object. Inner `hmd` / `controllers.left|right` are toggled between the stable view and `null`. */
  private readonly snapshot: DirectOpenVrInputSnapshot = {
    hmd: null,
    controllers: { left: null, right: null },
  };

  /**
   * Update the snapshot from freshly-read pacer poses. Pass `null` for any
   * role that is unavailable / invalid this frame. Does not allocate.
   */
  update(
    hmd: OpenVrHmdEmulationPose | null,
    left: OpenVrHmdEmulationPose | null,
    right: OpenVrHmdEmulationPose | null,
  ): void {
    if (hmd) {
      this.hmdBuffers.matrix.set(hmd.matrix);
      this.hmdBuffers.position[0] = hmd.position[0];
      this.hmdBuffers.position[1] = hmd.position[1];
      this.hmdBuffers.position[2] = hmd.position[2];
      this.hmdBuffers.quaternion[0] = hmd.quaternion[0];
      this.hmdBuffers.quaternion[1] = hmd.quaternion[1];
      this.hmdBuffers.quaternion[2] = hmd.quaternion[2];
      this.hmdBuffers.quaternion[3] = hmd.quaternion[3];
      this.hmdValid = true;
    } else {
      this.hmdValid = false;
    }

    if (left) {
      this.leftBuffers.position[0] = left.position[0];
      this.leftBuffers.position[1] = left.position[1];
      this.leftBuffers.position[2] = left.position[2];
      this.leftBuffers.quaternion[0] = left.quaternion[0];
      this.leftBuffers.quaternion[1] = left.quaternion[1];
      this.leftBuffers.quaternion[2] = left.quaternion[2];
      this.leftBuffers.quaternion[3] = left.quaternion[3];
      this.leftValid = true;
    } else {
      this.leftValid = false;
    }

    if (right) {
      this.rightBuffers.position[0] = right.position[0];
      this.rightBuffers.position[1] = right.position[1];
      this.rightBuffers.position[2] = right.position[2];
      this.rightBuffers.quaternion[0] = right.quaternion[0];
      this.rightBuffers.quaternion[1] = right.quaternion[1];
      this.rightBuffers.quaternion[2] = right.quaternion[2];
      this.rightBuffers.quaternion[3] = right.quaternion[3];
      this.rightValid = true;
    } else {
      this.rightValid = false;
    }

    this.snapshot.hmd = this.hmdValid ? this.hmdView : null;
    this.snapshot.controllers.left = this.leftValid ? this.leftView : null;
    this.snapshot.controllers.right = this.rightValid ? this.rightView : null;
  }

  /**
   * Initialise IVRInput, action handles, and the action manifest.
   * Call once before the first {@link updateActionState}.
   */
  initialize(vrInputPointer: number | bigint): void {
    if (this.inputReady) return;
    const ptr = Deno.UnsafePointer.create(
      typeof vrInputPointer === "bigint" ? vrInputPointer : BigInt(vrInputPointer),
    );
    if (!ptr) throw new Error("DirectOpenVrInputSource: invalid IVRInput pointer");
    this.vrInput = new OpenVR.IVRInput(ptr);

    const manifestPath = tempFile("./resources/actions.json", import.meta.dirname!);
    let error = this.vrInput.SetActionManifestPath(manifestPath);
    if (error !== OpenVR.InputError.VRInputError_None) {
      throw new Error("DirectOpenVrInputSource: failed to set action manifest path");
    }

    const getActionHandle = (name: string): bigint => {
      const hptr = P.BigUint64P<OpenVR.ActionHandle>();
      const e = this.vrInput!.GetActionHandle(name, hptr);
      if (e !== OpenVR.InputError.VRInputError_None) {
        throw new Error(`DirectOpenVrInputSource: failed to get action handle ${name}`);
      }
      return new Deno.UnsafePointerView(hptr).getBigUint64();
    };

    this.grabLeftHandle = getActionHandle("/actions/main/in/GrabLeft");
    this.grabRightHandle = getActionHandle("/actions/main/in/GrabRight");
    try {
      this.grabForceLeftHandle = getActionHandle("/actions/main/in/GrabForceLeft");
      this.grabForceRightHandle = getActionHandle("/actions/main/in/GrabForceRight");
    } catch {
      this.grabForceLeftHandle = OpenVR.k_ulInvalidActionHandle;
      this.grabForceRightHandle = OpenVR.k_ulInvalidActionHandle;
    }
    this.triggerLeftHandle = getActionHandle("/actions/main/in/TriggerLeft");
    this.triggerRightHandle = getActionHandle("/actions/main/in/TriggerRight");
    this.joystickLeftHandle = getActionHandle("/actions/main/in/JoystickLeft");
    this.joystickRightHandle = getActionHandle("/actions/main/in/JoystickRight");
    this.rightClickModifierHandle = getActionHandle("/actions/main/in/RightClickModifier");
    this.middleClickModifierHandle = getActionHandle("/actions/main/in/MiddleClickModifier");
    try {
      this.spaceDragHandle = getActionHandle("/actions/main/in/SpaceDrag");
    } catch {
      // An older manifest copy without space move; everything else still works.
      this.spaceDragHandle = OpenVR.k_ulInvalidActionHandle;
    }
    try {
      this.hapticHandle = getActionHandle("/actions/main/out/Haptic");
    } catch {
      // Haptics are feedback only; input works without them.
      this.hapticHandle = OpenVR.k_ulInvalidActionHandle;
    }

    const actionSetPtr = P.BigUint64P<OpenVR.ActionSetHandle>();
    error = this.vrInput.GetActionSetHandle("/actions/main", actionSetPtr);
    if (error !== OpenVR.InputError.VRInputError_None) {
      throw new Error("DirectOpenVrInputSource: failed to get action set handle");
    }
    this.actionSetHandle = new Deno.UnsafePointerView(actionSetPtr).getBigUint64();

    const leftPathPtr = P.BigUint64P<OpenVR.InputValueHandle>();
    const leftPathErr = this.vrInput.GetInputSourceHandle("/user/hand/left", leftPathPtr);
    this.leftHandPathHandle = leftPathErr === OpenVR.InputError.VRInputError_None
      ? new Deno.UnsafePointerView(leftPathPtr).getBigUint64()
      : OpenVR.k_ulInvalidInputValueHandle;

    const rightPathPtr = P.BigUint64P<OpenVR.InputValueHandle>();
    const rightPathErr = this.vrInput.GetInputSourceHandle("/user/hand/right", rightPathPtr);
    this.rightHandPathHandle = rightPathErr === OpenVR.InputError.VRInputError_None
      ? new Deno.UnsafePointerView(rightPathPtr).getBigUint64()
      : OpenVR.k_ulInvalidInputValueHandle;

    this.dualActiveActionSetBuffer = new ArrayBuffer(OpenVR.ActiveActionSetStruct.byteSize * 2);
    this.inputReady = true;
    if (this.hapticHandle !== OpenVR.k_ulInvalidActionHandle) {
      setHapticSink((hand, pulse) => this.vibrate(hand, pulse));
    }
  }

  /** One vibration pulse on a hand (see `classes/environment/haptics.ts`). */
  vibrate(hand: "left" | "right", pulse: HapticPulse): void {
    if (!this.vrInput || !this.inputReady) return;
    const device = hand === "left" ? this.leftHandPathHandle : this.rightHandPathHandle;
    if (device === OpenVR.k_ulInvalidInputValueHandle) return;
    this.vrInput.TriggerHapticVibrationAction(
      this.hapticHandle,
      0,
      pulse.durationS,
      pulse.frequency,
      pulse.amplitude,
      device,
    );
  }

  /**
   * Call OpenVR `UpdateActionState` and sample digital action data for
   * trigger / grab. Must be invoked each frame before {@link getSnapshot}.
   * Does not allocate.
   */
  updateActionState(): void {
    if (!this.vrInput || !this.inputReady) return;

    const b = this.dualActiveActionSetBuffer!;
    const w = OpenVR.ActiveActionSetStruct.byteSize;
    const view0 = new DataView(b, 0, w);
    const view1 = new DataView(b, w, w);
    const priority = (hand: "left" | "right") => {
      const controller = hand === "left" ? this.leftView : this.rightView;
      return gameInputBlocking.priority(
        hand,
        controller.trigger > 0 || controller.grab > 0 ||
          Math.abs(controller.joystick[0]) > 0.1 || Math.abs(controller.joystick[1]) > 0.1 ||
          this.rightClickModifier[hand] || this.middleClickModifier[hand],
      );
    };
    const base = {
      ulActionSet: this.actionSetHandle,
      ulSecondaryActionSet: 0n as OpenVR.ActionSetHandle,
      unPadding: 0,
      nPriority: 0,
    };
    OpenVR.ActiveActionSetStruct.write(
      {
        ...base,
        ulRestrictedToDevice: this.leftHandPathHandle,
        nPriority: this.leftHandPathHandle === OpenVR.k_ulInvalidInputValueHandle
          ? 0
          : priority("left"),
      },
      view0,
    );
    OpenVR.ActiveActionSetStruct.write(
      {
        ...base,
        ulRestrictedToDevice: this.rightHandPathHandle,
        nPriority: this.rightHandPathHandle === OpenVR.k_ulInvalidInputValueHandle
          ? 0
          : priority("right"),
      },
      view1,
    );
    const ptr = Deno.UnsafePointer.of(b) as Deno.PointerValue<OpenVR.ActiveActionSet>;
    const error = this.vrInput.UpdateActionState(ptr, w, 2);
    if (error !== OpenVR.InputError.VRInputError_None) return;

    this.vrInput.GetDigitalActionData(
      this.grabLeftHandle,
      this.grabLeft[0],
      OpenVR.InputDigitalActionDataStruct.byteSize,
      this.leftHandPathHandle,
    );
    this.vrInput.GetDigitalActionData(
      this.grabRightHandle,
      this.grabRight[0],
      OpenVR.InputDigitalActionDataStruct.byteSize,
      this.rightHandPathHandle,
    );
    this.vrInput.GetDigitalActionData(
      this.triggerLeftHandle,
      this.triggerLeft[0],
      OpenVR.InputDigitalActionDataStruct.byteSize,
      this.leftHandPathHandle,
    );
    this.vrInput.GetDigitalActionData(
      this.triggerRightHandle,
      this.triggerRight[0],
      OpenVR.InputDigitalActionDataStruct.byteSize,
      this.rightHandPathHandle,
    );
    this.vrInput.GetDigitalActionData(
      this.rightClickModifierHandle,
      this.rightClickModifierLeft[0],
      OpenVR.InputDigitalActionDataStruct.byteSize,
      this.leftHandPathHandle,
    );
    this.vrInput.GetDigitalActionData(
      this.rightClickModifierHandle,
      this.rightClickModifierRight[0],
      OpenVR.InputDigitalActionDataStruct.byteSize,
      this.rightHandPathHandle,
    );
    this.vrInput.GetDigitalActionData(
      this.middleClickModifierHandle,
      this.middleClickModifierLeft[0],
      OpenVR.InputDigitalActionDataStruct.byteSize,
      this.leftHandPathHandle,
    );
    this.vrInput.GetDigitalActionData(
      this.middleClickModifierHandle,
      this.middleClickModifierRight[0],
      OpenVR.InputDigitalActionDataStruct.byteSize,
      this.rightHandPathHandle,
    );
    if (this.spaceDragHandle !== OpenVR.k_ulInvalidActionHandle) {
      this.vrInput.GetDigitalActionData(
        this.spaceDragHandle,
        this.spaceDragLeft[0],
        OpenVR.InputDigitalActionDataStruct.byteSize,
        this.leftHandPathHandle,
      );
      const drag = OpenVR.InputDigitalActionDataStruct.read(this.spaceDragLeft[1]);
      this.spaceDragHeld = Boolean(drag.bActive && drag.bState);
    }
    this.vrInput.GetAnalogActionData(
      this.joystickLeftHandle,
      this.joystickLeft[0],
      OpenVR.InputAnalogActionDataStruct.byteSize,
      this.leftHandPathHandle,
    );
    this.vrInput.GetAnalogActionData(
      this.joystickRightHandle,
      this.joystickRight[0],
      OpenVR.InputAnalogActionDataStruct.byteSize,
      this.rightHandPathHandle,
    );
    let grabForceLActive = false;
    let grabForceRActive = false;
    if (this.grabForceLeftHandle !== OpenVR.k_ulInvalidActionHandle) {
      this.vrInput.GetAnalogActionData(
        this.grabForceLeftHandle,
        this.grabForceLeft[0],
        OpenVR.InputAnalogActionDataStruct.byteSize,
        this.leftHandPathHandle,
      );
      const forceL = OpenVR.InputAnalogActionDataStruct.read(this.grabForceLeft[1]);
      if (forceL.bActive) {
        grabForceLActive = true;
        this.grabForceLeftHeld = applyGrabThreshold(
          forceL.x,
          this.grabForceLeftHeld,
          getSetting("grabThreshold"),
        );
      } else {
        this.grabForceLeftHeld = false;
      }
    }
    if (this.grabForceRightHandle !== OpenVR.k_ulInvalidActionHandle) {
      this.vrInput.GetAnalogActionData(
        this.grabForceRightHandle,
        this.grabForceRight[0],
        OpenVR.InputAnalogActionDataStruct.byteSize,
        this.rightHandPathHandle,
      );
      const forceR = OpenVR.InputAnalogActionDataStruct.read(this.grabForceRight[1]);
      if (forceR.bActive) {
        grabForceRActive = true;
        this.grabForceRightHeld = applyGrabThreshold(
          forceR.x,
          this.grabForceRightHeld,
          getSetting("grabThreshold"),
        );
      } else {
        this.grabForceRightHeld = false;
      }
    }

    const grabL = OpenVR.InputDigitalActionDataStruct.read(this.grabLeft[1]);
    const grabR = OpenVR.InputDigitalActionDataStruct.read(this.grabRight[1]);
    const trigL = OpenVR.InputDigitalActionDataStruct.read(this.triggerLeft[1]);
    const trigR = OpenVR.InputDigitalActionDataStruct.read(this.triggerRight[1]);
    const joystickL = OpenVR.InputAnalogActionDataStruct.read(this.joystickLeft[1]);
    const joystickR = OpenVR.InputAnalogActionDataStruct.read(this.joystickRight[1]);
    const rightModL = OpenVR.InputDigitalActionDataStruct.read(this.rightClickModifierLeft[1]);
    const rightModR = OpenVR.InputDigitalActionDataStruct.read(this.rightClickModifierRight[1]);
    const middleModL = OpenVR.InputDigitalActionDataStruct.read(this.middleClickModifierLeft[1]);
    const middleModR = OpenVR.InputDigitalActionDataStruct.read(this.middleClickModifierRight[1]);

    const leftGrabDown = grabForceLActive
      ? this.grabForceLeftHeld
      : Boolean(grabL.bActive && grabL.bState);
    const rightGrabDown = grabForceRActive
      ? this.grabForceRightHeld
      : Boolean(grabR.bActive && grabR.bState);

    // Index starts space drag with a grip chord: the grip must not also grab what it points at.
    this.leftBuffers.grab[0] = leftGrabDown && !this.spaceDragHeld ? 1 : 0;
    this.rightBuffers.grab[0] = rightGrabDown ? 1 : 0;
    this.leftBuffers.trigger[0] = trigL.bActive && trigL.bState ? 1 : 0;
    this.rightBuffers.trigger[0] = trigR.bActive && trigR.bState ? 1 : 0;
    this.leftBuffers.joystick[0] = joystickL.bActive ? joystickL.x : 0;
    this.leftBuffers.joystick[1] = joystickL.bActive ? joystickL.y : 0;
    this.rightBuffers.joystick[0] = joystickR.bActive ? joystickR.x : 0;
    this.rightBuffers.joystick[1] = joystickR.bActive ? joystickR.y : 0;
    this.rightClickModifier.left = Boolean(rightModL.bActive && rightModL.bState);
    this.rightClickModifier.right = Boolean(rightModR.bActive && rightModR.bState);
    this.middleClickModifier.left = Boolean(middleModL.bActive && middleModL.bState);
    this.middleClickModifier.right = Boolean(middleModR.bActive && middleModR.bState);

    // Sync scalar snapshot properties (they are not live references like Float32Arrays)
    this.leftView.grab = this.leftBuffers.grab[0];
    this.leftView.trigger = this.leftBuffers.trigger[0];
    this.rightView.grab = this.rightBuffers.grab[0];
    this.rightView.trigger = this.rightBuffers.trigger[0];
  }

  /** Left stick click, held: drag the playspace (`classes/playspaceMover.ts`). */
  isSpaceDragHeld(): boolean {
    return this.spaceDragHeld;
  }

  getDesktopMouseButton(hand: "left" | "right"): "left" | "middle" | "right" {
    if (this.rightClickModifier[hand]) return "right";
    if (this.middleClickModifier[hand]) return "middle";
    return "left";
  }

  /** Reset IVRInput state so the source stops reading actions. */
  resetInput(): void {
    gameInputBlocking.reset();
    setHapticSink(null);
    this.hapticHandle = OpenVR.k_ulInvalidActionHandle;
    this.vrInput = null;
    this.inputReady = false;
    this.grabLeftHandle = OpenVR.k_ulInvalidActionHandle;
    this.grabRightHandle = OpenVR.k_ulInvalidActionHandle;
    this.grabForceLeftHandle = OpenVR.k_ulInvalidActionHandle;
    this.grabForceRightHandle = OpenVR.k_ulInvalidActionHandle;
    this.grabForceLeftHeld = false;
    this.grabForceRightHeld = false;
    this.triggerLeftHandle = OpenVR.k_ulInvalidActionHandle;
    this.triggerRightHandle = OpenVR.k_ulInvalidActionHandle;
    this.joystickLeftHandle = OpenVR.k_ulInvalidActionHandle;
    this.joystickRightHandle = OpenVR.k_ulInvalidActionHandle;
    this.rightClickModifierHandle = OpenVR.k_ulInvalidActionHandle;
    this.middleClickModifierHandle = OpenVR.k_ulInvalidActionHandle;
    this.spaceDragHandle = OpenVR.k_ulInvalidActionHandle;
    this.spaceDragHeld = false;
    this.rightClickModifier.left = false;
    this.rightClickModifier.right = false;
    this.middleClickModifier.left = false;
    this.middleClickModifier.right = false;
    this.actionSetHandle = OpenVR.k_ulInvalidActionSetHandle;
    this.leftHandPathHandle = OpenVR.k_ulInvalidInputValueHandle;
    this.rightHandPathHandle = OpenVR.k_ulInvalidInputValueHandle;
    this.dualActiveActionSetBuffer = null;
  }

  /** Clear all validity flags without zeroing buffers. */
  clear(): void {
    this.hmdValid = false;
    this.leftValid = false;
    this.rightValid = false;
    this.snapshot.hmd = null;
    this.snapshot.controllers.left = null;
    this.snapshot.controllers.right = null;
  }

  /**
   * Read-only snapshot accessor. The returned object identity is stable across
   * frames and its inner `Float32Array` fields are shared mutating buffers.
   */
  getSnapshot(): DirectOpenVrInputSnapshot {
    return this.snapshot;
  }

  hasHmd(): boolean {
    return this.hmdValid;
  }

  hasLeftController(): boolean {
    return this.leftValid;
  }

  hasRightController(): boolean {
    return this.rightValid;
  }
}
