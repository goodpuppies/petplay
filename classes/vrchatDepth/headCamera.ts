/**
 * VRChat's Stream camera pinned to the wearer's head (`markdown/vrchat-depth/README.md`, "VR"): the
 * depth block then comes from (nearly) the eyes' viewpoint, rendered in the same VRChat frame as
 * the eyes, so PetPlay's occlusion in the headset needs only a small reprojection.
 *
 * VRChat has no head-attached camera mode over OSC, so PetPlay writes `/usercamera/Pose` from the
 * headset pose at headset rate, through the inverse of the block's world → tracking alignment.
 * The camera sits `offsetMeters` in front of the eyes: VRChat hides the local head only in the eye
 * view, and a camera inside it would see hair, glasses and the inside of the face. The block reports
 * the pose the camera actually rendered from, so lag here costs coverage, not correctness.
 */
import { cameraPoseFromWorld } from "./flyCamera.ts";
import { quatMul, rotateVec, type WorldToTracking } from "./sync.ts";
import type { TrackedPose, VrcWorldCameraPose } from "../vrcCameraCalibration.ts";

/**
 * The Stream camera's `Zoom` (focal length, mm, sensor ~36.5 mm tall) for the head camera: VRChat's
 * widest, 84.7° vertical, about 120° across the 1920×1000 window, so the depth covers both eyes.
 */
export const HEAD_CAMERA_ZOOM = 18;

/** Ahead of the eyes, along the view: clears a typical avatar's face, fringe and glasses. */
export const DEFAULT_HEAD_CAMERA_OFFSET = 0.15;

/** The inverse of `applyWorldToTracking`: tracking → right-handed VRChat world. */
export function trackingToWorld(t: WorldToTracking, pose: TrackedPose): TrackedPose {
  const unyaw: [number, number, number, number] = [
    0,
    -Math.sin(t.yawRad / 2),
    0,
    Math.cos(t.yawRad / 2),
  ];
  const local = pose.position.map((v, i) => (v - t.translation[i]) / t.scale) as [
    number,
    number,
    number,
  ];
  return { position: rotateVec(unyaw, local), quaternion: quatMul(unyaw, pose.quaternion) };
}

/** `/usercamera/Pose` for a camera `offsetMeters` ahead of the headset, looking where it looks. */
export function headCameraPose(
  hmd: TrackedPose,
  alignment: WorldToTracking,
  offsetMeters = DEFAULT_HEAD_CAMERA_OFFSET,
): VrcWorldCameraPose {
  // Tracking metres ahead of the eyes (the headset looks down −z).
  const ahead = rotateVec(hmd.quaternion, [0, 0, -offsetMeters]);
  const position = hmd.position.map((v, i) => v + ahead[i]) as [number, number, number];
  return cameraPoseFromWorld(trackingToWorld(alignment, { position, quaternion: hmd.quaternion }));
}
