import * as THREE from "three";
import type { TrackedPose, VrcWorldCameraPose } from "../vrcCameraCalibration.ts";

export type FlyCameraInput = {
  forward?: number;
  right?: number;
  up?: number;
  mouseX?: number;
  mouseY?: number;
  fast?: boolean;
};

/** Camera controls in Unity world coordinates, directly usable by /usercamera/Pose. */
export function cameraPoseFromWorld(pose: TrackedPose): VrcWorldCameraPose {
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...pose.quaternion), "YXZ");
  return {
    position: [pose.position[0], pose.position[1], -pose.position[2]],
    rotationDeg: [-e.x * 180 / Math.PI, -e.y * 180 / Math.PI, e.z * 180 / Math.PI],
  };
}

export function stepFlyCamera(
  pose: VrcWorldCameraPose,
  input: FlyCameraInput,
  seconds: number,
  speed = 3,
): VrcWorldCameraPose {
  const pitch = Math.max(-89, Math.min(89, pose.rotationDeg[0] + (input.mouseY ?? 0) * 0.15));
  const yaw = (pose.rotationDeg[1] + (input.mouseX ?? 0) * 0.15) % 360;
  const p = pitch * Math.PI / 180, y = yaw * Math.PI / 180;
  const f = input.forward ?? 0, r = input.right ?? 0, u = input.up ?? 0;
  const direction = [
    Math.sin(y) * Math.cos(p) * f + Math.cos(y) * r,
    -Math.sin(p) * f + u,
    Math.cos(y) * Math.cos(p) * f - Math.sin(y) * r,
  ];
  const distance = Math.min(0.1, Math.max(0, seconds)) * speed * (input.fast ? 4 : 1);
  const weight = distance / Math.max(1, Math.hypot(...direction));
  return {
    position: pose.position.map((v, i) => v + direction[i] * weight) as [number, number, number],
    rotationDeg: [pitch, yaw, 0],
  };
}
