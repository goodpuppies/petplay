/**
 * Desktop view controls, shared by every view that owns its camera (the browser scene viewer
 * now; the raylib desktop preview next). DOM-free: an adapter turns its platform's input into
 * the calls below, so the bindings and camera behaviour are defined once.
 *
 * Interaction with the scene itself (hover, press, drag, grab) is not handled here: it goes to
 * the scene's pmndrs pointer events, as VR controllers' rays do. This module only decides which
 * input is navigation and which is interaction, and moves the camera.
 *
 * Bindings:
 * - left button: scene interaction
 * - right drag: orbit around the target
 * - middle drag, or shift + right drag: pan
 * - wheel: scene interaction (scrolling UI); ctrl + wheel (or a pinch): dolly toward the target
 * - F: toggle following the headset's pose; G: frame the content
 */
import * as THREE from "npm:three@0.186.1";

export type NavAction = "scene" | "orbit" | "pan";

/** Which drag a button press starts. `button` follows DOM numbering (0 left, 1 middle, 2 right). */
export function dragAction(button: number, shiftKey: boolean): NavAction {
  if (button === 2) return shiftKey ? "pan" : "orbit";
  if (button === 1) return "pan";
  return "scene";
}

/** Whether a wheel event navigates (true) or scrolls the scene (false). */
export function wheelNavigates(ctrlKey: boolean, metaKey: boolean): boolean {
  return ctrlKey || metaKey; // browsers report trackpad pinches as ctrl + wheel
}

const ORBIT_RADIANS_PER_PIXEL = 0.005;
const MIN_DISTANCE = 0.05;
const MAX_DISTANCE = 50;
const MAX_PITCH = Math.PI / 2 - 0.01;

/**
 * Orbit camera around a target, or following an external pose (the headset). Writes the
 * camera's matrices directly; the camera must have `matrixAutoUpdate = false`.
 */
export class ViewCameraController {
  readonly target = new THREE.Vector3(0, 1.2, 0);
  /** Yaw and pitch of the camera around the target, and its distance. */
  yaw = 0;
  pitch = 0;
  distance = 2;
  mode: "free" | "head" = "free";

  constructor(private readonly camera: THREE.Camera) {}

  orbit(dxPixels: number, dyPixels: number): void {
    this.mode = "free";
    this.yaw -= dxPixels * ORBIT_RADIANS_PER_PIXEL;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dyPixels * ORBIT_RADIANS_PER_PIXEL, -MAX_PITCH, MAX_PITCH);
  }

  /** Moves camera and target together so the point under the cursor follows it. */
  pan(dxPixels: number, dyPixels: number, viewportHeight: number, fovRadians: number): void {
    this.mode = "free";
    const metresPerPixel = 2 * this.distance * Math.tan(fovRadians / 2) / Math.max(viewportHeight, 1);
    const rotation = this.rotation();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(rotation);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rotation);
    this.target.addScaledVector(right, -dxPixels * metresPerPixel).addScaledVector(up, dyPixels * metresPerPixel);
  }

  /** `factor` > 1 moves away, < 1 moves closer. */
  dolly(factor: number): void {
    this.mode = "free";
    this.distance = THREE.MathUtils.clamp(this.distance * factor, MIN_DISTANCE, MAX_DISTANCE);
  }

  /** Looks at `center` from `distance` along `facing` (a world direction from center to camera). */
  frame(center: THREE.Vector3, facing: THREE.Vector3, distance: number): void {
    this.mode = "free";
    this.target.copy(center);
    const d = facing.clone().normalize();
    this.yaw = Math.atan2(d.x, d.z);
    this.pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)), -MAX_PITCH, MAX_PITCH);
    this.distance = THREE.MathUtils.clamp(distance, MIN_DISTANCE, MAX_DISTANCE);
  }

  /** Leaves head mode at the head's current pose, orbiting a point a metre ahead of it. */
  freeFrom(pose: THREE.Matrix4): void {
    const position = new THREE.Vector3().setFromMatrixPosition(pose);
    const forward = new THREE.Vector3(0, 0, -1).transformDirection(pose);
    this.frame(position.clone().add(forward), forward.negate(), 1);
  }

  /** Writes the camera for this frame. `head` is the headset pose, used in head mode. */
  apply(head: THREE.Matrix4 | undefined): void {
    const camera = this.camera;
    if (this.mode === "head" && head) {
      camera.matrix.copy(head);
    } else {
      const rotation = this.rotation();
      const position = new THREE.Vector3(0, 0, this.distance).applyQuaternion(rotation).add(this.target);
      camera.matrix.compose(position, rotation, new THREE.Vector3(1, 1, 1));
    }
    camera.matrixWorld.copy(camera.matrix);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  }

  private rotation(): THREE.Quaternion {
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(-this.pitch, this.yaw, 0, "YXZ"));
  }
}
