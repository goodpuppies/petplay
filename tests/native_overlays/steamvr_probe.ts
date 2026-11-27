/**
 * Live check of native overlays against a running SteamVR, without PetPlay and without showing
 * anything in the headset: the test scene sits 40 m below the floor.
 *
 *   deno run -A --no-check tests/native_overlays/steamvr_probe.ts
 *
 * It runs the production path (plan, eye image, `NativeOverlayLayer`) and then asks SteamVR what
 * it holds, quad by quad: that it exists and is visible, where it is, and **which picture it
 * has** (`GetOverlayImageData`), compared with the picture that was drawn for it.
 *
 * - A panel in the room and a panel that rides the real headset: placed once, drawn once.
 * - A stereo group on a head-facing quad, and a grab box's outline on a quad in the box's face:
 *   the outline is placed once and drawn again only when the eyes have moved far enough.
 * - A laser beam and its cursor dot on plain quads of their own, over everything else; a beam that
 *   rides the headset, as a laser rides its controller, is attached to that device.
 * - Panels come and go, the eye targets are rebuilt, new content of other sizes appears, a panel
 *   changes its size, an overlay slot comes back that SteamVR knows at another size: every quad
 *   still has its own picture. (A SteamVR overlay keeps the size of its first texture for good,
 *   and its slot keeps it beyond the overlay; a quad given a picture of another size went on
 *   showing an old one. See classes/openVrNativeOverlays.ts.)
 *
 * What it cannot check is how SteamVR *draws* a side-by-side quad: that is judged in the headset
 * (see `StereoSizing` in classes/openVrNativeOverlays.ts).
 */
import * as THREE from "three";
import * as OpenVR from "../../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { createStruct } from "../../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import raylib from "../../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import { OpenVrRuntime } from "../../classes/openVrRuntime.ts";
import { NativeOverlayLayer } from "../../classes/nativeOverlayLayer.ts";
import {
  nativePanelCamera,
  nativeStereoBoxQuad,
  planNativeContent,
} from "../../classes/nativeOverlayMath.ts";
import { resolveRenderAnchors } from "../../classes/overlayRenderTracking.ts";
import { WebXROverlayRaylib } from "../../classes/webxrOverlayRaylib.ts";
import { addHeadPanel, BOX, createTestScene, DOT_RADIUS, EYE, IPD } from "./scene.ts";

const origin = new THREE.Vector3(0, -40, 0);
const keyPrefix = `petplay.nativeprobe.${Deno.pid}`;

const runtime = new OpenVrRuntime("PetPlay native overlay probe");
let pointers;
try {
  pointers = runtime.initialize({ system: "required", overlay: "required" });
} catch (error) {
  console.log(`SKIP: SteamVR is not running (${(error as Error).message})`);
  Deno.exit(0);
}
const overlay = new OpenVR.IVROverlay(pointers.overlay!);
const system = new OpenVR.IVRSystem(pointers.system!);
const { payload, frame, panelWorld, beamFrom, beamTo } = createTestScene(origin);
// The eyes the native quads are drawn for: in front of the panel, a little to the side, where a
// box outline's quad can lie in the box's face. `eyeShift` moves them along the panel.
const panelRotation = new THREE.Matrix4().extractRotation(panelWorld);
const panelCenter = new THREE.Vector3().setFromMatrixPosition(panelWorld);
let eyeShift = 0;
const eyeAt = (x: number) =>
  new THREE.Vector3(0.22 + x + eyeShift, 0.1, 1.1).applyMatrix4(panelRotation).add(panelCenter);
const eyePose = (x: number) => new THREE.Matrix4().setPosition(eyeAt(x));
// 40 m under the wearer's head.
const hudLocal = new THREE.Matrix4().makeTranslation(0, -40, -1);
addHeadPanel(payload, hudLocal);
// A second laser beam, 60 cm long, that rides the head the way a laser rides its controller.
const hudBeamLocal = new THREE.Matrix4().compose(
  new THREE.Vector3(0.3, -40, -1),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.2, 0)),
  new THREE.Vector3(0.002, 0.002, 0.6),
);
{
  type Marked = (typeof payload.leftEye.frame.instances)[number] & {
    nativeQuad?: { key: string; shape: string; extent: number[] };
    renderAnchor?: unknown;
  };
  const instances = payload.leftEye.frame.instances as Marked[];
  const sceneBeam = instances.find((instance) => instance.nativeQuad?.key === "beam")!;
  instances.push({
    ...sceneBeam,
    worldMatrix: new Float64Array(hudBeamLocal.elements),
    normalMatrix: new Float64Array(sceneBeam.normalMatrix),
    renderAnchor: { space: "head", localMatrix: new Float64Array(hudBeamLocal.elements) },
    nativeQuad: { key: "hudbeam", shape: "beam", extent: [0.5, 0.5, 0.5] },
  } as Marked);
}

const poses = new ArrayBuffer(OpenVR.TrackedDevicePoseStruct.byteSize);
/** The headset's pose right now, column-major, in the standing universe the quads are placed in. */
function hmdPose(): Float32Array | null {
  system.GetDeviceToAbsoluteTrackingPose(
    OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding,
    0,
    Deno.UnsafePointer.of(poses) as Deno.PointerValue<OpenVR.TrackedDevicePose>,
    1,
  );
  const pose = OpenVR.TrackedDevicePoseStruct.read(
    new DataView(poses),
  ) as unknown as OpenVR.TrackedDevicePose;
  if (!pose.bPoseIsValid) return null;
  const m = pose.mDeviceToAbsoluteTracking.m;
  return new Float32Array([
    m[0][0],
    m[1][0],
    m[2][0],
    0,
    m[0][1],
    m[1][1],
    m[2][1],
    0,
    m[0][2],
    m[1][2],
    m[2][2],
    0,
    m[0][3],
    m[1][3],
    m[2][3],
    1,
  ]);
}

const compositor = new WebXROverlayRaylib(EYE);
compositor.initialize("PetPlay native overlay probe");
const layer = new NativeOverlayLayer(pointers.overlay!, keyPrefix, "PetPlay native overlay probe");
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${what}`);
  if (!ok) failures.push(what);
};

/** The SteamVR overlay showing quad `key` at the moment. */
const find = (key: string): OpenVR.OverlayHandle | null => layer.overlayHandle(key);
/** Whether SteamVR knows an overlay under this name of ours. */
function known(overlayKey: string): boolean {
  const pointer = P.BigUint64P<OpenVR.OverlayHandle>();
  return overlay.FindOverlay(`${keyPrefix}.${overlayKey}`, pointer) ===
    OpenVR.OverlayError.VROverlayError_None;
}
function width(handle: OpenVR.OverlayHandle): number {
  const value = new Float32Array(1);
  overlay.GetOverlayWidthInMeters(
    handle,
    Deno.UnsafePointer.of(value) as Deno.PointerValue<number>,
  );
  return value[0]!;
}
function position(handle: OpenVR.OverlayHandle): number[] {
  const universe = new Int32Array(1);
  const rows = new Float32Array(12);
  overlay.GetOverlayTransformAbsolute(
    handle,
    Deno.UnsafePointer.of(universe) as Deno.PointerValue<OpenVR.TrackingUniverseOrigin>,
    Deno.UnsafePointer.of(rows) as Deno.PointerValue<OpenVR.HmdMatrix34>,
  );
  return [rows[3]!, rows[7]!, rows[11]!];
}
function flag(handle: OpenVR.OverlayHandle, which: OpenVR.OverlayFlags): boolean {
  const value = new Uint8Array(1);
  overlay.GetOverlayFlag(handle, which, Deno.UnsafePointer.of(value) as Deno.PointerValue<boolean>);
  return value[0] !== 0;
}
function attachedTo(handle: OpenVR.OverlayHandle): { device: number; at: number[] } | null {
  const type = new Int32Array(1);
  overlay.GetOverlayTransformType(
    handle,
    Deno.UnsafePointer.of(type) as Deno.PointerValue<OpenVR.OverlayTransformType>,
  );
  if (type[0] !== OpenVR.OverlayTransformType.VROverlayTransform_TrackedDeviceRelative) return null;
  const device = new Uint32Array(1);
  const rows = new Float32Array(12);
  overlay.GetOverlayTransformTrackedDeviceRelative(
    handle,
    Deno.UnsafePointer.of(device) as Deno.PointerValue<OpenVR.TrackedDeviceIndex>,
    Deno.UnsafePointer.of(rows) as Deno.PointerValue<OpenVR.HmdMatrix34>,
  );
  return { device: device[0]!, at: [rows[3]!, rows[7]!, rows[11]!] };
}
function texelAspect(handle: OpenVR.OverlayHandle): number {
  const value = new Float32Array(1);
  overlay.GetOverlayTexelAspect(handle, Deno.UnsafePointer.of(value) as Deno.PointerValue<number>);
  return value[0]!;
}
const frames = (count: number) => {
  for (let i = 0; i < count; i++) overlay.WaitFrameSync(50);
};

/**
 * Compares the picture SteamVR holds for the quad `key` with the one last drawn for it. Both come
 * in OpenGL's row order. Returns what differs, or null when they are the same picture.
 */
function wrongPicture(key: string): string | null {
  const handle = find(key);
  if (handle == null) return "SteamVR does not know the quad";
  const size = new Uint32Array(2);
  const sizeAt = (i: number) => Deno.UnsafePointer.of(size.subarray(i, i + 1)) as never;
  overlay.GetOverlayImageData(handle, null as never, 0, sizeAt(0), sizeAt(1));
  const drawn = compositor.readNativeTargetRgba(key);
  if (size[0] !== drawn.width || size[1] !== drawn.height) {
    return `SteamVR holds ${size[0]}x${size[1]}, drawn was ${drawn.width}x${drawn.height}`;
  }
  const held = new Uint8Array(drawn.width * drawn.height * 4);
  const error = overlay.GetOverlayImageData(
    handle,
    Deno.UnsafePointer.of(held) as never,
    held.length,
    sizeAt(0),
    sizeAt(1),
  );
  if (error !== OpenVR.OverlayError.VROverlayError_None) return OpenVR.OverlayError[error]!;
  let differing = 0, covered = 0;
  for (let i = 0; i < held.length; i += 4) {
    if (drawn.data[i + 3]! > 8) covered++;
    if (
      Math.abs(held[i]! - drawn.data[i]!) > 3 || Math.abs(held[i + 1]! - drawn.data[i + 1]!) > 3 ||
      Math.abs(held[i + 2]! - drawn.data[i + 2]!) > 3 ||
      Math.abs(held[i + 3]! - drawn.data[i + 3]!) > 3
    ) differing++;
  }
  if (covered === 0) return "the drawn picture is empty";
  return differing > 0 ? `${differing} of ${held.length / 4} pixels differ` : null;
}
function checkPictures(when: string) {
  frames(6);
  const live = Object.entries(layer.status().overlays).filter(([, quad]) => !quad.hidden);
  const wrong = live.map(([key]) => [key, wrongPicture(key)] as const).filter(([, why]) => why);
  check(
    wrong.length === 0,
    `${when}: SteamVR holds the right picture for all ${live.length} quads` +
      (wrong.length ? ` (${wrong.map(([key, why]) => `${key}: ${why}`).join("; ")})` : ""),
  );
}

let completed = false;
try {
  let headTravel = 0, headTracked = 0;
  let lastHead: Float32Array | null = null;
  const step = () => {
    frame.frameCount++;
    // As the renderer does each frame: fresh tracking re-poses what rides a tracked space.
    const hmd = hmdPose();
    if (hmd) {
      resolveRenderAnchors(payload, { head: hmd });
      if (lastHead) {
        headTravel += Math.hypot(
          hmd[12]! - lastHead[12]!,
          hmd[13]! - lastHead[13]!,
          hmd[14]! - lastHead[14]!,
        );
      }
      lastHead = hmd;
      headTracked++;
    }
    const plan = planNativeContent(payload, { panels: true, stereo: true });
    compositor.renderRaythreeFrame(plan?.eyePayload ?? payload, { skipCombine: true });
    layer.present(plan, compositor, {
      head: eyePose(0).elements,
      leftEyeViewMatrix: eyePose(-IPD / 2).invert().elements,
      rightEyeViewMatrix: eyePose(IPD / 2).invert().elements,
      devices: hmd ? { head: { index: OpenVR.k_unTrackedDeviceIndex_Hmd, pose: hmd } } : {},
    });
    overlay.WaitFrameSync(50);
    if (runtime.pollRuntimeEvents().exiting) throw new Error("SteamVR is closing");
  };
  const steps = (count: number) => {
    for (let i = 0; i < count; i++) step();
  };

  steps(20);
  const still = layer.stats.panelRedraws;
  // A hover: one panel item changes colour, which must redraw that panel and no other.
  payload.ui.panels[1]!.data[5] = 0.9;
  steps(40);
  const status = layer.status();
  console.log("layer status:", JSON.stringify(status));
  check(
    status.panels === 2 && status.stereo === 2,
    "two panel quads and two stereo quads are live",
  );
  check(still === 2, `unchanged panels are drawn once each (${still} in 20 frames)`);
  check(
    status.panelRedraws === 3,
    `the colour change redrew one of them once more (${status.panelRedraws})`,
  );
  checkPictures("at first");

  const panel = find("panel.test");
  check(panel != null, "SteamVR knows the panel quad");
  if (panel != null) {
    const camera = nativePanelCamera(payload.ui.nativePanels![0]!)!;
    check(overlay.IsOverlayVisible(panel), "the panel quad is visible");
    check(Math.abs(width(panel) - camera.widthMeters) < 1e-4, `panel width ${width(panel)} m`);
    const at = position(panel);
    const want = [camera.pose[12]!, camera.pose[13]!, camera.pose[14]!];
    check(
      at.every((value, axis) => Math.abs(value - want[axis]!) < 1e-4),
      `panel position ${at.map((v) => v.toFixed(3))} (wanted ${want.map((v) => v.toFixed(3))})`,
    );
    check(status.overlays["panel.test"]?.transforms === 1, "it was placed once");
    check(
      flag(panel, OpenVR.OverlayFlags.VROverlayFlags_IsPremultiplied),
      "the panel quad is marked premultiplied",
    );
  }

  // The head panel: attached to the HMD, and placed once however the wearer moved meanwhile.
  const hud = find("panel.hud");
  check(hud != null, "SteamVR knows the head panel's quad");
  if (hud != null && headTracked > 0) {
    const attached = attachedTo(hud);
    check(
      attached?.device === OpenVR.k_unTrackedDeviceIndex_Hmd,
      `it is attached to the headset (device ${attached?.device})`,
    );
    const want = [hudLocal.elements[12]!, hudLocal.elements[13]!, hudLocal.elements[14]!];
    check(
      attached != null && attached.at.every((value, axis) => Math.abs(value - want[axis]!) < 1e-3),
      `at ${attached?.at.map((v) => v.toFixed(3))} in the headset's frame (wanted ${want})`,
    );
    const drawn = status.overlays["panel.hud"];
    check(
      drawn?.transforms === 1 && drawn.presents === 1,
      `placed once, with one picture, while the head travelled ${
        (headTravel * 100).toFixed(1)
      } cm ` +
        `over ${headTracked} tracked frames (${drawn?.transforms} placements, ${drawn?.presents} pictures)`,
    );
  } else if (hud != null) console.log("SKIP: the headset is not tracked; attachment not checked");

  const cube = find("stereo.cube");
  check(cube != null, "SteamVR knows the stereo group's quad");
  if (cube != null) {
    check(overlay.IsOverlayVisible(cube), "it is visible");
    check(
      flag(cube, OpenVR.OverlayFlags.VROverlayFlags_SideBySide_Parallel),
      "and marked side by side",
    );
    // The sizing choice is a texel aspect that can be switched while the quad is shown.
    layer.stereoSizing = "full";
    steps(2);
    const full = texelAspect(cube);
    layer.stereoSizing = "halved";
    steps(2);
    check(
      Math.abs(full - 0.5) < 1e-6 && Math.abs(texelAspect(cube) - 1) < 1e-6,
      `the sizing choice switches its texel aspect (full ${full}, halved ${texelAspect(cube)})`,
    );
  }

  // The pointer: the laser beam on a quad along itself, its dot on a quad of its own, both over
  // the panels (0) and the head-locked image (1).
  const sortOrder = (handle: OpenVR.OverlayHandle) => {
    const value = new Uint32Array(1);
    overlay.GetOverlaySortOrder(handle, Deno.UnsafePointer.of(value) as Deno.PointerValue<number>);
    return value[0]!;
  };
  const beam = find("quad.beam"), dot = find("quad.dot"), hudBeam = find("quad.hudbeam");
  check(
    status.pointer === 3 && beam != null && dot != null && hudBeam != null,
    `the laser beams and the dot have a quad each (${status.pointer})`,
  );
  if (beam != null) {
    const length = beamFrom.distanceTo(beamTo);
    const middle = beamFrom.clone().lerp(beamTo, 0.5).toArray();
    const at = position(beam);
    check(
      overlay.IsOverlayVisible(beam) && Math.abs(width(beam) - length) < 1e-4 &&
        at.every((value, axis) => Math.abs(value - middle[axis]!) < 1e-4),
      `the beam's quad is as long as the beam (${width(beam).toFixed(3)} m) and centred on it`,
    );
    const aspect = texelAspect(beam);
    check(
      aspect >= 0.4 && aspect <= 2.5,
      `its texels are within reach of square (aspect ${aspect.toFixed(2)})`,
    );
    const drawn = status.overlays["quad.beam"];
    check(
      drawn?.presents === 1 && drawn.transforms === 1 && sortOrder(beam) === 2,
      `drawn once, placed once, over the panels and the head-locked image (${drawn?.presents} ` +
        `pictures, ${drawn?.transforms} placements, sort order ${sortOrder(beam)})`,
    );
  }
  if (dot != null) {
    check(
      overlay.IsOverlayVisible(dot) && Math.abs(width(dot) - DOT_RADIUS * 2.5) < 1e-5 &&
        sortOrder(dot) === 3 && status.overlays["quad.dot"]?.presents === 1,
      `the dot's quad is ${(width(dot) * 1000).toFixed(1)} mm wide, drawn once, over the beam`,
    );
  }
  if (hudBeam != null && headTracked > 0) {
    const attached = attachedTo(hudBeam);
    const want = [0.3, -40, -1];
    check(
      attached?.device === OpenVR.k_unTrackedDeviceIndex_Hmd &&
        attached.at.every((value, axis) => Math.abs(value - want[axis]!) < 1e-3),
      `a beam that rides a tracked device is attached to it (device ${attached?.device}, at ` +
        `${attached?.at.map((v) => v.toFixed(3))})`,
    );
    check(
      status.overlays["quad.hudbeam"]?.presents === 1 && Math.abs(width(hudBeam) - 0.6) < 1e-4,
      "with one picture, 0.6 m long",
    );
  }

  // A grab box's outline: on a quad in the box's face, which never moves, with a picture that is
  // drawn again only when the eyes have moved far enough to show.
  const box = find("stereo.box");
  check(box != null, "SteamVR knows the box outline's quad");
  if (box != null) {
    const outline = planNativeContent(payload, { panels: true, stereo: true })!.stereo
      .find((group) => group.key === "box")!;
    const quad = nativeStereoBoxQuad(
      outline.instances,
      BOX,
      eyeAt(0).toArray(),
      eyeAt(-IPD / 2).toArray(),
      eyeAt(IPD / 2).toArray(),
    )!;
    const drawn = layer.status().overlays["stereo.box"];
    check(
      drawn?.presents === 1 && drawn.transforms === 1,
      `while the eyes stood still it was drawn once and placed once (${drawn?.presents} pictures, ` +
        `${drawn?.transforms} placements)`,
    );
    check(Math.abs(width(box) - quad.width) < 1e-4, `it is ${width(box).toFixed(3)} m wide`);
    const at = position(box);
    check(
      at.every((value, axis) => Math.abs(value - quad.pose[12 + axis]!) < 1e-4),
      "and lies in the box's nearer face",
    );
    eyeShift = quad.redrawAfter! * 0.5;
    steps(3);
    check(
      layer.status().overlays["stereo.box"]?.presents === 1,
      `eyes ${(eyeShift * 1000).toFixed(1)} mm further on: no new picture`,
    );
    eyeShift = 0.03;
    steps(3);
    const moved = layer.status().overlays["stereo.box"];
    check(
      moved?.presents === 2 && moved.transforms === 1,
      `eyes 30 mm further on: one new picture, the quad still where it was ` +
        `(${moved?.presents} pictures, ${moved?.transforms} placements)`,
    );
  }
  checkPictures("after the eyes moved");

  // A panel that leaves the scene (a wrist menu turned away, a toolbar deselected) is hidden and
  // kept, and comes back with the picture SteamVR still has.
  const hudPanel = payload.ui.nativePanels!.pop()!;
  const hudItem = payload.ui.panels.pop()!;
  if (hud != null) {
    steps(5);
    check(
      find("panel.hud") != null && !overlay.IsOverlayVisible(hud),
      "a panel that left the scene is hidden, not destroyed",
    );
    payload.ui.nativePanels!.push(hudPanel);
    payload.ui.panels.push(hudItem);
    steps(5);
    const back = layer.status().overlays["panel.hud"];
    check(
      overlay.IsOverlayVisible(hud) && back?.presents === 1 && back.hidden === undefined,
      `back in the scene it is visible again with the picture it had (${back?.presents} drawn in all)`,
    );
    payload.ui.nativePanels!.pop();
    payload.ui.panels.pop();
  }

  // What went wrong in a headset: quads go, the eye targets are rebuilt, and new content of other
  // sizes appears. Each quad must still get its own picture.
  layer.unusedFramesBeforeParking = 3;
  steps(8);
  check(
    find("panel.hud") == null && layer.status().spareOverlays === 1,
    "a panel gone for good gives up its overlay, which is kept for the next picture of its size",
  );
  const before = compositor.getNativeTargetCounts();
  compositor.setRequestedEyeSize(EYE / 2);
  steps(3);
  checkPictures("after the eye targets were rebuilt");

  /** A head-anchored panel of `size` metres (1000 pixels to the metre), `index` metres aside. */
  const latePanel = (key: string, index: number, size: readonly [number, number]) => {
    const local = new THREE.Matrix4().makeTranslation(index, -40, -1);
    const square = local.clone().multiply(new THREE.Matrix4().makeScale(size[0], size[1], 0));
    const anchor = () => ({
      space: "head" as const,
      localMatrix: new Float64Array(square.elements),
    });
    const data = new Float32Array(16);
    data.set([0.2 + 0.25 * index, 0.9 - 0.25 * index, 0.5, 1], 4);
    data[14] = size[0] * 1000;
    data[15] = size[1] * 1000;
    payload.ui.panels.push({
      ...hudItem,
      worldMatrix: new Float32Array(square.elements),
      data,
      rootIndex: 20 + index,
      renderAnchor: anchor(),
    });
    payload.ui.nativePanels!.push({
      key,
      rootIndices: [20 + index],
      worldMatrix: new Float32Array(square.elements),
      pixelWidth: size[0] * 1000,
      pixelHeight: size[1] * 1000,
      renderAnchor: anchor(),
    });
  };
  const dropLatePanel = () => {
    payload.ui.nativePanels!.pop();
    payload.ui.panels.pop();
  };
  // New panels of sizes nothing had yet, one after another, each replacing the last; the third
  // has the head panel's size again.
  for (const [index, size] of ([[0.2, 0.3], [0.36, 0.12], [0.3, 0.2]] as const).entries()) {
    latePanel(`late-${index}`, index, size);
    steps(4);
    checkPictures(`with a new ${size[0] * 1000} x ${size[1] * 1000} pixel panel`);
    dropLatePanel();
    steps(8);
  }
  check(
    layer.status().spareOverlays === 3,
    `three sizes came and went, the third on the head panel's overlay: ` +
      `${layer.status().spareOverlays} overlays are kept for them`,
  );

  // One panel that changes its size while it is shown: its quad moves to another overlay.
  const sizes = [[0.25, 0.25], [0.4, 0.15], [0.25, 0.25], [0.52, 0.31]] as const;
  for (const [index, size] of sizes.entries()) {
    latePanel("resized", 3, size);
    steps(4);
    checkPictures(`a panel resized to ${size[0] * 1000} x ${size[1] * 1000} pixels`);
    if (index === 0) {
      const first = layer.status().overlays["panel.resized"];
      check(first?.presents === 1, "the resized panel started with one picture");
    }
    dropLatePanel();
  }
  steps(8);

  // An overlay slot that SteamVR knows at another size: something else in the process had an
  // overlay there. The next quad lands in that slot, finds out, and takes another overlay.
  const foreign = raylib.H.LoadRenderTexture(224, 96);
  const foreignHandle = P.BigUint64P<OpenVR.OverlayHandle>();
  overlay.CreateOverlay(
    `${keyPrefix}.foreign`,
    "PetPlay native overlay probe (foreign)",
    foreignHandle,
  );
  const foreignOverlay = new Deno.UnsafePointerView(foreignHandle).getBigUint64();
  const foreignTexture = createStruct<OpenVR.Texture>({
    handle: BigInt(foreign.texture.id),
    eType: OpenVR.TextureType.TextureType_OpenGL,
    eColorSpace: OpenVR.ColorSpace.ColorSpace_Auto,
  }, OpenVR.TextureStruct);
  overlay.SetOverlayTexture(foreignOverlay, foreignTexture[0]);
  frames(4);
  overlay.ClearOverlayTexture(foreignOverlay);
  overlay.DestroyOverlay(foreignOverlay);
  frames(2);
  const mismatchesBefore = layer.status().sizeMismatches;
  latePanel("after-foreign", 4, [0.44, 0.44]);
  steps(4);
  check(
    layer.status().sizeMismatches === mismatchesBefore + 1,
    `a quad made in a slot SteamVR knows at another size noticed ` +
      `(${layer.status().sizeMismatches - mismatchesBefore} overlay set aside)`,
  );
  checkPictures("with a quad that first landed in a used slot");
  dropLatePanel();
  steps(8);
  raylib.H.UnloadRenderTexture(foreign);

  const after = compositor.getNativeTargetCounts();
  console.log(
    `native textures: ${JSON.stringify(before)} before, ${JSON.stringify(after)} after; ` +
      `${layer.status().spareOverlays} spare overlays`,
  );
  completed = true;
} finally {
  layer.clear(compositor);
  check(
    layer.overlayKeys().length === 0 && layer.status().spareOverlays === 0 &&
      ![0, 1, 2, 3, 4, 5, 6, 7].some((index) => known(`quad${index}`)),
    "all quads are gone again, the spare overlays too",
  );
  try {
    compositor.cleanup();
  } catch (error) {
    if (completed) console.error("Renderer cleanup:", error);
  }
  runtime.shutdown();
}
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed`);
  Deno.exit(1);
}
console.log("All SteamVR checks passed");
