/**
 * Recipes for VRChat's user camera driven by the synthetic hands, as worked out against VRChat
 * 2025-10 under the lab's fixed synthetic head (0, 1.6, 0) looking down −Z.
 *
 * The Action Menu path (hold menu → Tools → Camera) depends on VRChat's menu layout; when it
 * changes, the joystick directions below are the knobs. Positions are driver (raw tracking) space.
 */
import * as THREE from "three";
import { euler, type Hand, type HandPose, SyntheticDriver, type Vec3 } from "./driver.ts";
import { message } from "./petplay.ts";
import { oscQuery, sendOsc } from "./vrchat.ts";
import { sleep, waitFor } from "./util.ts";
import {
  applyVrcCameraCalibration,
  type TrackedPose,
  unityPoseToRightHanded,
  type VrcCameraCalibration,
  type VrcCameraTrackerStatus,
} from "../../classes/vrcCameraCalibration.ts";

/**
 * The Action Menu recipe from the first working run (markdown/vrlab-vrchat-radial-menu.md):
 * open with the hand level in front of the eyes, then pitch it +45° so the menu faces the head.
 */
export const MENU_OPEN_POSE: HandPose = {
  position: [-0.02, 1.58, -0.35],
  rotation: euler(0, 0, 0),
};
export const MENU_VIEW_POSE: HandPose = {
  position: [-0.02, 1.5, -0.35],
  rotation: euler(Math.PI / 4, 0, 0),
};
/** Where the hand sits while picking entries. */
export const MENU_HAND_POSE: HandPose = {
  position: [-0.06, 1.55, -0.35],
  rotation: euler(Math.PI / 4, 0, 0),
};
/** Out of the way of the menu and the camera's spawn point. */
export const RIGHT_HAND_ASIDE: HandPose = { position: [0.3, 1.2, -0.3], rotation: euler(0, 0, 0) };
/** Joystick directions of the Action Menu entries used here (left hand). */
export const ACTION_MENU = { tools: [-0.8, 0.6], camera: [-0.85, 0.5] } as const;
export const CAMERA_MODE = {
  off: 0,
  photo: 1,
  stream: 2,
  emoji: 3,
  multilayer: 4,
  print: 5,
  drone: 6,
} as const;

type WorldPose = { position: Vec3; rotationDeg: Vec3; receivedAt: number };

/** Latest `/usercamera/Pose` PetPlay received over OSC (VRChat world space, Unity Euler). */
export function cameraWorldPose(): Promise<WorldPose | null> {
  return message<WorldPose | null>("cameraOrigin", "GETCAMERAPOSE");
}

export function calibrationStatus(): Promise<VrcCameraTrackerStatus> {
  return message<VrcCameraTrackerStatus>("webxr", "GETVRCCAMERACALIBRATION");
}

/** The camera's tracking-space pose through PetPlay's current calibration. */
export async function cameraTrackingPose(): Promise<TrackedPose> {
  const calibration = (await calibrationStatus()).calibration as VrcCameraCalibration | null;
  if (!calibration) throw new Error("no VRC camera calibration yet");
  const world = await cameraWorldPose();
  if (!world) throw new Error("no VRChat camera pose received");
  return applyVrcCameraCalibration(calibration, unityPoseToRightHanded(world));
}

/**
 * Opens the Action Menu: hold left B (Y) ~900 ms and release; it opens on the release, so a
 * capture taken while the button is held never shows it. The menu toggles and reopens on the
 * page it was last on: only call this with the menu closed, ideally on a fresh VRChat.
 */
export async function openActionMenu(driver: SyntheticDriver): Promise<void> {
  await driver.setPose("right", RIGHT_HAND_ASIDE);
  await driver.setPose("left", MENU_OPEN_POSE);
  await sleep(500);
  await driver.press("left", { b: true }, 900);
  await sleep(1_000);
  await driver.setPose("left", MENU_VIEW_POSE);
  await sleep(500);
}

/**
 * Selects one Action Menu entry, with the reference run's timing: stick toward it 400 ms, trigger
 * 200 ms with the stick held, stick alone 200 ms (the entry is chosen as the trigger releases),
 * then centre and wait `settleMs`. The left stick is also locomotion: centring right after
 * matters, since a tilt left over once the menu closes walks the avatar away.
 */
export async function pickActionMenu(
  driver: SyntheticDriver,
  direction: readonly [number, number],
  settleMs = 800,
  /**
   * How long the stick is held on the entry before the trigger. 400 ms was enough at the lab's
   * default resolution; at the beyond75 profile VRChat runs slower and the highlight had not
   * landed when the trigger came (2026-11-07), so the default is now longer.
   */
  holdMs = 900,
  hand: Hand = "left",
): Promise<void> {
  const joystick: [number, number] = [direction[0], direction[1]];
  await driver.setPose(hand, MENU_HAND_POSE);
  await sleep(300);
  // Flick, trigger while the stick is still on the entry, then the stick back to neutral.
  await driver.setInput(hand, { joystick });
  await sleep(holdMs);
  await driver.setInput(hand, { joystick, trigger: 1 });
  await sleep(400);
  await driver.setInput(hand, { joystick });
  await sleep(300);
  await driver.setInput(hand);
  await sleep(settleMs);
}

/**
 * Opens the camera from the Action Menu (Tools → Camera) and switches it to `mode`, following the
 * reference run step for step. `/usercamera/Mode` alone does not open it. Expects the menu and
 * the camera closed (a fresh VRChat): the entries toggle and the menu reopens on its last page.
 * `observe` runs after each step, e.g. to capture `vrlab eye`.
 */
export async function openCamera(
  driver: SyntheticDriver,
  mode: number = CAMERA_MODE.stream,
  observe: (step: string) => Promise<void> = async () => {},
): Promise<WorldPose> {
  const before = (await cameraWorldPose())?.receivedAt ?? 0;
  await openActionMenu(driver);
  await observe("menu-root");
  await pickActionMenu(driver, ACTION_MENU.tools);
  await observe("menu-tools");
  await pickActionMenu(driver, ACTION_MENU.camera, 1_200);
  await observe("camera-open");
  const opened = (await oscQuery("/usercamera/Mode"))?.[0];
  if (!opened) {
    throw new Error("the camera did not open (OSCQuery /usercamera/Mode is 0): check the captures");
  }
  await sendOsc("/usercamera/Mode", { i: mode });
  await sleep(500);
  // VRChat reports the pose only when the camera moves; nudging the menu hand moves it.
  await driver.setPose("left", { ...MENU_HAND_POSE, position: [-0.1, 1.5, -0.35] });
  return await waitFor("VRChat to report the opened camera", async () => {
    const pose = await cameraWorldPose();
    return pose && pose.receivedAt > before ? pose : null;
  }, 8_000);
}

/**
 * Finds the camera with `hand` by grid search: close the grip at each point, move 8 cm, and treat
 * it as grabbed when VRChat's camera followed. Leaves the grip held on success.
 */
export async function grabCamera(
  driver: SyntheticDriver,
  hand: Hand = "right",
  grid = { x: [0.05, -0.05, 0.15, -0.15], y: [1.35, 1.45, 1.25, 1.55], z: [-0.35, -0.45, -0.25] },
): Promise<HandPose> {
  const rotation = euler(0, 0, 0);
  for (const z of grid.z) {
    for (const y of grid.y) {
      for (const x of grid.x) {
        await driver.setInput(hand);
        await driver.setPose(hand, { position: [x, y, z], rotation });
        await sleep(250);
        await driver.setInput(hand, { grip: 1 });
        await sleep(300);
        const a = (await cameraWorldPose())?.position;
        const moved: HandPose = { position: [x + 0.08, y, z], rotation };
        await driver.setPose(hand, moved);
        await sleep(400);
        const b = (await cameraWorldPose())?.position;
        if (a && b && Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) > 0.04) return moved;
      }
    }
  }
  await driver.setInput(hand);
  throw new Error("could not grab the VRChat camera: is it open and within the search grid?");
}

/**
 * Smooth translation plus pitch/yaw/roll around `base` — every rotation axis, so the grip offset is
 * observable — while PetPlay's grab-to-calibrate capture runs. Keeps the grip closed.
 */
export async function sweepForCalibration(
  driver: SyntheticDriver,
  base: Vec3,
  seconds = 14,
  hand: Hand = "right",
): Promise<VrcCameraTrackerStatus> {
  await message("webxr", "STARTVRCCAMERACALIBRATION", { durationMs: seconds * 1000 });
  await driver.follow(hand, seconds + 0.5, (t) => ({
    position: [
      base[0] + 0.1 * Math.sin(0.5 * t),
      base[1] + 0.06 * Math.sin(0.7 * t),
      base[2] + 0.08 * Math.sin(0.4 * t),
    ],
    rotation: euler(0.35 * Math.sin(0.6 * t), 0.6 * Math.sin(0.45 * t), 0.25 * Math.sin(0.8 * t)),
  }));
  let status = await calibrationStatus();
  if (status.calibrating) status = await message("webxr", "STOPVRCCAMERACALIBRATION");
  return status;
}

/**
 * Moves the held camera to `position` looking at `target` (tracking space). Measures the hand →
 * camera offset from the current pose first, so it needs a calibration. Returns where VRChat put it.
 */
export async function aimCamera(
  driver: SyntheticDriver,
  position: Vec3,
  target: Vec3,
  hand: Hand = "right",
): Promise<{ requested: Vec3; reached: Vec3; errorMeters: number }> {
  const handPose = await driver.handPose(hand);
  const camera = await cameraTrackingPose();
  const qd = new THREE.Quaternion(...handPose.rotation);
  const qdInverse = qd.clone().invert();
  const offsetQ = qdInverse.clone().multiply(new THREE.Quaternion(...camera.quaternion));
  const offsetP = new THREE.Vector3(...camera.position).sub(new THREE.Vector3(...handPose.position))
    .applyQuaternion(qdInverse);
  const P = new THREE.Vector3(...position);
  const look = new THREE.Matrix4().lookAt(
    P,
    new THREE.Vector3(...target),
    new THREE.Vector3(0, 1, 0),
  );
  const newQd = new THREE.Quaternion().setFromRotationMatrix(look).multiply(offsetQ.invert());
  const newPd = P.clone().sub(offsetP.applyQuaternion(newQd));
  await driver.setPose(hand, {
    position: newPd.toArray() as Vec3,
    rotation: [newQd.x, newQd.y, newQd.z, newQd.w],
  });
  await sleep(1_200);
  const reached = (await cameraTrackingPose()).position;
  return { requested: position, reached, errorMeters: P.distanceTo(new THREE.Vector3(...reached)) };
}
