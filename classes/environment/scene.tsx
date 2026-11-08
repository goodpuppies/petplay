import React, { useRef } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import {
  extend,
  type ThreeToJSXElements,
  useFrame,
  type UseFrameNextOptions,
  useThree,
} from "@react-three/fiber/webgpu";
import { vrcCameraStore } from "./vrcCameraStore.ts";
import { readVrcCameraDebugSnapshot } from "../vrcCameraDebugState.ts";
import { DisplayInstance } from "./displayInstance/logic.tsx";
import {
  DEFAULT_DISPLAY_DEPTH,
  DEFAULT_DISPLAY_HEIGHT,
  DISPLAY_PANEL_WIDTH,
} from "./displayMetrics.ts";
import {
  createSmoothedDisplayMouseSink,
  windowsSystemDisplayMouseSink,
} from "./displayInstance/mouse.ts";
import type { DisplayMouseLogicEvent, DisplayMouseSink } from "./displayInstance/mouse.ts";
import { KeyboardPanel, windowsSystemKeyboardSink } from "./keyboard/keyboard.tsx";
import type { KeyboardLogicEvent, KeyboardSink } from "./keyboard/types.ts";
import { KEYBOARD_LOCALES, useKeyboardLocale } from "./keyboard/keyboardLocale.ts";
import { PostMan } from "../../submodules/stageforge/mod.ts";
import { SpatialAudioProvider } from "./spatialAudio.tsx";
import { setSetting, useSetting } from "../settings.ts";
import { getPointerById } from "../../submodules/threewebxrwebgpudeno/submodules/xr/packages/pointer-events/src/pointer.ts";
import { ConstructWithPropsContext } from "../../submodules/threewebxrwebgpudeno/uikit-r3f.tsx";
import {
  loadAllMsdfFonts,
  MSDF_FONTS,
  type MsdfFontId,
  peekMsdfFontAssets,
} from "../../submodules/threewebxrwebgpudeno/msdf-text.tsx";
import type { PointerEvent as PenPointerEvent } from "@pmndrs/pointer-events";
import {
  defaultApply,
  type HandleOptions,
  type HandleState,
  type HandleStore,
} from "@pmndrs/handle";
import { subscribeLayoutRecenter, useWindowLayerVisible } from "./windowLayerMode.ts";
import { setGrabboxOutlineVisible, useGrabboxOutlineVisible } from "./grabboxOutlineMode.ts";
import { useHingedOneHandScaleMaxGrabOffset } from "./spatialManipulationMode.ts";
import { GrabBox } from "./grabbox.tsx";
import { pushPullGrab } from "./pushPull.ts";
import { consumeOneHandScaleEnd, withOneHandScale } from "./oneHandScale.ts";
import {
  assignWorkspaceOutput,
  commitHingePose,
  commitNodeTransform,
  commitSpatialNodeTransformAndSnap,
  type ControlSpatialNode,
  createInitialSpatialGraph,
  deleteSpatialNode,
  detachDisplayHierarchy,
  detachFromParent,
  type DisplaySpatialNode,
  displayToolbarSide,
  getDisplayAttachmentRole,
  getSpatialChildren,
  getSpatialRootId,
  hasAvailableDisplayAttachmentSlot,
  type HingeConstraint,
  IDENTITY_SPATIAL_TRANSFORM,
  initializeWorkspaceLayoutOutputs,
  type KeyboardSpatialNode,
  recenterSpatialRoots,
  reconcileWorkspaceOutputs,
  releaseHinge,
  resetSpatialNodeTransform,
  SCENE_ORIGIN_ID,
  setHingeAngle,
  setSpatialNodeAutoHide,
  setSpatialNodeCurvature,
  setSpatialNodeLocked,
  setSpatialNodeMouseBlocked,
  setSpatialNodeOpacity,
  setSpatialRootOrigin,
  type SpatialGraph,
  type SpatialNode,
  type SpatialTransform,
  spawnDisplayForWorkspaceOutput,
  spawnHingedDisplay,
  spawnHingedDisplayWithAutomaticOutput,
  updateSnapSourceSize,
} from "./spatialGraph.ts";
import { loadWorkspaceOutputs, type WorkspaceOutput } from "./workspaceDisplays.ts";
import { publishWorkspaceLayout, registerWorkspaceLayoutActions } from "./workspaceLayoutStore.ts";
import {
  getLayoutSlotPath,
  listLayoutSlots,
  loadSpatialLayoutSync,
  saveSpatialLayoutSync,
  spatialLayoutPersistenceEnabled,
} from "./spatialLayoutPersistence.ts";
import { isDesktopMousePointerType } from "./spatialPointer.ts";
import type { DirectOpenVrInputSource } from "../directOpenVrInputSource.ts";
import { penHandler } from "./penEvents.ts";
import { ToastOverlay } from "./toastOverlay.tsx";
import { pushToast } from "./toastStore.ts";
import { startXsoNotificationReceiver } from "./xsoNotificationReceiver.ts";
import { startDesktopNotificationFollow } from "./desktopNotifications.ts";
import { startMediaFollow } from "./mediaStore.ts";
import {
  getHeadObject,
  getTrackedOriginWorldMatrix,
  isTrackedOriginId,
  SPATIAL_ORIGIN_IDS,
  SPATIAL_ORIGIN_LABEL,
  type SpatialOriginId,
  type TrackedOriginId,
} from "./trackedOrigins.ts";
import {
  type SpatialContextAction,
  SpatialContextToolbar,
  SpatialHierarchyIndicator,
  SpatialSettingsButton,
  SpatialSettingsSection,
} from "./spatialContextToolbar.tsx";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

// The handle package expects this pointer-events side effect on the *same*
// Three Object3D constructor used by our scene. Pinning Three to a commit made
// its implicit load order unreliable, so make the bridge explicit here.
const object3DPrototype = THREE.Object3D.prototype as THREE.Object3D & {
  setPointerCapture?: (pointerId: number) => void;
  releasePointerCapture?: (pointerId: number) => void;
  hasPointerCapture?: (pointerId: number) => boolean;
};
object3DPrototype.setPointerCapture ??= function (this: THREE.Object3D, pointerId: number) {
  getPointerById(pointerId)?.setCapture(this as never);
};
object3DPrototype.releasePointerCapture ??= function (this: THREE.Object3D, pointerId: number) {
  const pointer = getPointerById(pointerId);
  if (pointer?.hasCaptured(this as never)) pointer.setCapture(undefined);
};
object3DPrototype.hasPointerCapture ??= function (this: THREE.Object3D, pointerId: number) {
  return getPointerById(pointerId)?.hasCaptured(this as never) ?? false;
};

declare module "@react-three/fiber/webgpu" {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

type WebXRSceneProps = {
  XROrigin: React.ComponentType;
  displayOverlayHostActor?: string | null;
  directOpenVrInputSource?: DirectOpenVrInputSource;
};

function postInputControl(actor: string, command: string): void {
  try {
    PostMan.PostMessage({ target: actor, type: "INPUTCONTROL", payload: command });
  } catch {
    // The display actor may be shutting down.
  }
}

const MODIFIER_SCANS: Record<string, string> = {
  shift: "2A",
  leftCtrl: "1D",
  rightCtrl: "E01D",
  leftAlt: "38",
  rightAlt: "E038",
  leftMeta: "E05B",
  rightMeta: "E05C",
};

const VIRTUAL_KEY_SCANS: Record<string, string> = {
  NUMLOCK: "45",
  DIVIDE: "E035",
  MULTIPLY: "37",
  SUBTRACT: "4A",
  NUMPAD7: "47",
  NUMPAD8: "48",
  NUMPAD9: "49",
  ADD: "4E",
  NUMPAD4: "4B",
  NUMPAD5: "4C",
  NUMPAD6: "4D",
  NUMPAD1: "4F",
  NUMPAD2: "50",
  NUMPAD3: "51",
  RETURN: "E01C",
  NUMPAD0: "52",
  DECIMAL: "53",
};

function createLinuxMouseSink(actor: string): DisplayMouseSink {
  const rawSink: DisplayMouseSink = (event: DisplayMouseLogicEvent) => {
    postInputControl(actor, `M,${event.x},${event.y}`);
    if (event.kind === "button") {
      postInputControl(actor, `B,${event.button},${event.pressed ? 1 : 0}`);
    } else if (event.kind === "wheel") {
      postInputControl(actor, `W,${event.deltaY}`);
    }
  };
  const smoothedUinputSink = createSmoothedDisplayMouseSink(rawSink);
  return (event) => {
    // Keep the compositor cursor pixel-exact with the VR ray. KDE uinput still
    // receives the smoothed path below; button events snap it to this same raw
    // coordinate before the click transition.
    postInputControl(actor, `C,${event.x},${event.y}`);
    smoothedUinputSink(event);
  };
}

function createLinuxKeyboardSink(actor: string): KeyboardSink {
  return (event: KeyboardLogicEvent) => {
    if (event.kind === "modifier") {
      if (event.modifier === "caps") {
        if (event.active) {
          postInputControl(actor, "K,3A,1");
          postInputControl(actor, "K,3A,0");
        }
        return;
      }
      const scan = MODIFIER_SCANS[event.modifier];
      if (scan) postInputControl(actor, `K,${scan},${event.active ? 1 : 0}`);
      return;
    }
    const scan = event.scanCodeHex && event.scanCodeHex !== "00"
      ? event.scanCodeHex
      : event.virtualKeyName
      ? VIRTUAL_KEY_SCANS[event.virtualKeyName.toUpperCase()]
      : undefined;
    if (!scan) return;
    postInputControl(actor, `K,${scan},1`);
    postInputControl(actor, `K,${scan},0`);
  };
}

/** VRC camera OSC debug markers; off unless `PETPLAY_VRC_CAMERA_DEBUG=1`. */
const SHOW_VRC_CAMERA_DEBUG = Deno.env.get("PETPLAY_VRC_CAMERA_DEBUG") === "1";

/** Visible while calibrating or recording; recording views filter this mesh before delivery. */
function VrcCameraCalibrationBall() {
  const ref = useRef<THREE.Mesh>(null!);
  useFrame(() => {
    const pose = vrcCameraStore.predicted();
    ref.current.visible = pose != null;
    if (pose) ref.current.position.fromArray(pose.position);
  });
  return (
    <mesh ref={ref} name="vrc-camera-calibration-ball" visible={false}
      userData={{ vrcCameraHidden: true }} pointerEvents="none">
      <sphereGeometry args={[0.025, 16, 12]} />
      <meshBasicMaterial color="#36ff68" />
    </mesh>
  );
}

function VrcCameraDebugVisuals() {
  const cameraGroupRef = useRef<THREE.Group>(null!);
  const lookAtTargetRef = useRef<THREE.Mesh>(null!);
  const legacyOriginRef = useRef<THREE.Group>(null!);

  const frameOpts = React.useMemo<UseFrameNextOptions>(
    () => ({ id: "petplay-vrc-camera-debug" }),
    [],
  );

  useFrame(() => {
    const snapshot = readVrcCameraDebugSnapshot();
    const pose = snapshot.relativeCameraPose;

    if (pose) {
      cameraGroupRef.current.visible = true;
      cameraGroupRef.current.position.set(
        pose.position[0],
        pose.position[1],
        pose.position[2],
      );
      cameraGroupRef.current.rotation.set(
        THREE.MathUtils.degToRad(pose.rotationDeg[0]),
        THREE.MathUtils.degToRad(pose.rotationDeg[1]),
        THREE.MathUtils.degToRad(pose.rotationDeg[2]),
      );
    } else {
      cameraGroupRef.current.visible = false;
    }

    if (snapshot.lookAtTargetEstimate) {
      lookAtTargetRef.current.visible = true;
      lookAtTargetRef.current.position.set(
        snapshot.lookAtTargetEstimate[0],
        snapshot.lookAtTargetEstimate[1],
        snapshot.lookAtTargetEstimate[2],
      );
    } else {
      lookAtTargetRef.current.visible = false;
    }

    if (snapshot.legacyOriginMatrix) {
      const m = snapshot.legacyOriginMatrix;
      legacyOriginRef.current.visible = true;
      legacyOriginRef.current.matrix.set(
        m[0][0],
        m[0][1],
        m[0][2],
        m[0][3],
        m[1][0],
        m[1][1],
        m[1][2],
        m[1][3],
        m[2][0],
        m[2][1],
        m[2][2],
        m[2][3],
        0,
        0,
        0,
        1,
      );
    } else {
      legacyOriginRef.current.visible = false;
    }
  }, frameOpts);

  return (
    <>
      <group ref={cameraGroupRef} visible={false}>
        <mesh>
          <sphereGeometry args={[0.08, 16, 12]} />
          <meshBasicNodeMaterial colorNode={TSL.color(0x00d1ff)} />
        </mesh>
        <mesh position={[0, 0, -0.18]}>
          <boxGeometry args={[0.03, 0.03, 0.36]} />
          <meshBasicNodeMaterial colorNode={TSL.color(0x6ee7ff)} />
        </mesh>
        <mesh position={[0.13, 0, 0]}>
          <boxGeometry args={[0.26, 0.02, 0.02]} />
          <meshBasicNodeMaterial colorNode={TSL.color(0xff5c7a)} />
        </mesh>
        <mesh position={[0, 0.13, 0]}>
          <boxGeometry args={[0.02, 0.26, 0.02]} />
          <meshBasicNodeMaterial colorNode={TSL.color(0x7cff6b)} />
        </mesh>
      </group>
      <mesh ref={lookAtTargetRef} visible={false}>
        <torusGeometry args={[0.18, 0.008, 12, 48]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffd166)} />
      </mesh>
      <group ref={legacyOriginRef} visible={false} matrixAutoUpdate={false}>
        <mesh>
          <torusGeometry args={[0.24, 0.01, 12, 48]} />
          <meshBasicNodeMaterial colorNode={TSL.color(0xff4fd8)} />
        </mesh>
        <mesh position={[0.18, 0, 0]}>
          <boxGeometry args={[0.36, 0.025, 0.025]} />
          <meshBasicNodeMaterial colorNode={TSL.color(0xff5c7a)} />
        </mesh>
        <mesh position={[0, 0.18, 0]}>
          <boxGeometry args={[0.025, 0.36, 0.025]} />
          <meshBasicNodeMaterial colorNode={TSL.color(0x7cff6b)} />
        </mesh>
        <mesh position={[0, 0, 0.18]}>
          <boxGeometry args={[0.025, 0.025, 0.36]} />
          <meshBasicNodeMaterial colorNode={TSL.color(0x62a8ff)} />
        </mesh>
      </group>
    </>
  );
}

const JOYSTICK_SCROLL_CLICKS_PER_SECOND = 60;
const JOYSTICK_PUSH_PULL_METERS_PER_SECOND = 2;
const JOYSTICK_HINGE_RADIANS_PER_SECOND = 1.6;
const HANDLE_POSITION_DAMPENING = 41;
const HANDLE_ROTATION_DAMPENING = 61;

function applyDampedHandleState(
  state: HandleState<unknown>,
  target: import("three").Object3D,
): void {
  const dt = Math.max(0, Math.min(0.1, state.delta?.time ?? 1 / 72));
  // A window the renderer carries with the controller (`renderTrackingFollow`) stays rigid to it:
  // damping by irregular worker frame times makes its offset from the hand wobble, which the
  // fresh controller pose would then show against the steady hand.
  const rigid = target.userData.renderTrackingFollow != null ||
    target.userData.renderTrackingRelease === true;
  const positionAlpha = rigid ? 1 : Math.min(1, dt * HANDLE_POSITION_DAMPENING);
  const rotationAlpha = rigid ? 1 : Math.min(1, dt * HANDLE_ROTATION_DAMPENING);
  const object = target as unknown as THREE.Object3D;
  const position = state.current.position;
  object.position.set(
    object.position.x + (position.x - object.position.x) * positionAlpha,
    object.position.y + (position.y - object.position.y) * positionAlpha,
    object.position.z + (position.z - object.position.z) * positionAlpha,
  );
  object.quaternion.slerp(state.current.quaternion as unknown as THREE.Quaternion, rotationAlpha);
  object.scale.set(state.current.scale.x, state.current.scale.y, state.current.scale.z);
}

/**
 * Grab options that move the target freely with the hand (not a hinge), so the renderer may carry
 * it with the grabbing controller's fresh pose.
 */
const freeGrabOptionSet = new WeakSet<object>();
function freeGrabOptions<T extends object>(options: T): T {
  freeGrabOptionSet.add(options);
  return options;
}

/** Grab options with the trigger resize ({@link withOneHandScale}). */
function withTriggerResize(
  options: Omit<HandleOptions<unknown>, "filter">,
  stores: Map<string, HandleStore<unknown>>,
  baseWidth: number,
): Omit<HandleOptions<unknown>, "filter"> {
  const apply = options.apply == null
    ? undefined
    : withOneHandScale(options.apply, stores, baseWidth, freeGrabOptionSet.has(options));
  return { ...options, apply, alwaysUpdate: true };
}

function CommonOverlayChords({
  inputSource,
  graph,
  handleStores,
  onMouse,
}: {
  inputSource?: DirectOpenVrInputSource;
  graph: SpatialGraph;
  handleStores: Map<string, HandleStore<unknown>>;
  onMouse: DisplayMouseSink;
}) {
  const scene = useThree((state) => state.scene);
  const raycaster = React.useMemo(() => new THREE.Raycaster(), []);
  const origin = React.useMemo(() => new THREE.Vector3(), []);
  const direction = React.useMemo(() => new THREE.Vector3(), []);
  const quaternion = React.useMemo(() => new THREE.Quaternion(), []);
  const scrollAccumulator = React.useRef(0);
  // The scroll chord only cares about the flat display proxy surfaces. The
  // joystick handler runs every XR tick, so raycast those directly instead of
  // the whole 600-node scene (0.8–1.2ms → ~0.005ms measured live).
  // Refresh on graph changes: displays are added/deleted by user action and
  // the proxy meshes mount/unmount with them.
  const scrollSurfaces = React.useMemo(() => {
    const found: THREE.Object3D[] = [];
    scene.traverse((object) => {
      if (object.userData.displayInstanceRayHitSurface === true) {
        found.push(object);
      }
    });
    return found;
  }, [scene, graph]);

  useFrame((_state, delta) => {
    const right = inputSource?.getSnapshot().controllers.right;
    if (!right) {
      scrollAccumulator.current = 0;
      return;
    }
    const axis = Math.abs(right.joystick[1]) > 0.2 ? right.joystick[1] : 0;
    origin.fromArray(right.position);
    quaternion.fromArray(right.quaternion);
    // Push/pull needs the nearest live handle pointer, not a surface hit, and the scroll chord
    // needs a non-zero axis. Both early-outs run before the raycast so an idle controller costs
    // nothing here.
    if (right.grab > 0.5) {
      let closestStore: HandleStore<unknown> | undefined;
      let closestPointerId: number | undefined;
      let closestNodeId: string | undefined;
      let closestDistanceSq = Number.POSITIVE_INFINITY;
      for (const [nodeId, store] of handleStores) {
        for (const [pointerId, pointer] of store.inputState) {
          const dx = pointer.pointerWorldOrigin.x - origin.x;
          const dy = pointer.pointerWorldOrigin.y - origin.y;
          const dz = pointer.pointerWorldOrigin.z - origin.z;
          const distanceSq = dx * dx + dy * dy + dz * dz;
          if (distanceSq < closestDistanceSq) {
            closestDistanceSq = distanceSq;
            closestStore = store;
            closestPointerId = pointerId;
            closestNodeId = nodeId;
          }
        }
      }
      if (closestStore != null && closestPointerId != null && closestDistanceSq <= 0.25 * 0.25) {
        const constraint = closestNodeId == null
          ? undefined
          : graph.nodes[closestNodeId]?.constraint;
        if (constraint?.kind === "hinge") {
          // A hinge has no free translation, so the stick angles it instead of pushing it away.
          // Handing over an absolute angle rebases the grab, so the hand stops turning the hinge
          // while the stick is deflected — the two inputs never fight. The angle is clamped before
          // it is handed over, so holding the stick against a stop cannot wind up a dead zone.
          if (axis !== 0) {
            const limits = constraint.limits;
            const current = closestStore.getState()?.current.rotation[constraint.axis] ?? 0;
            // The same rotation sign reads as "pull toward me" on a left/top hinge and "push away"
            // on the mirrored right/bottom one, so flip it for the mirrored sides.
            const side = constraint.attachmentSlotId.match(/-(left|right|top|bottom)-slot$/)?.[1];
            const direction = side === "right" || side === "bottom" ? 1 : -1;
            const requested = current +
              direction * axis * JOYSTICK_HINGE_RADIANS_PER_SECOND * delta;
            closestStore.setTargetAxisAngle(
              closestPointerId,
              constraint.axis,
              Math.min(limits[1], Math.max(limits[0], requested)),
            );
          }
          return;
        }
        if (axis !== 0) {
          const step = axis * JOYSTICK_PUSH_PULL_METERS_PER_SECOND * delta;
          pushPullGrab(closestStore, closestPointerId, step);
        }
        return;
      }
    }
    if (axis === 0) {
      scrollAccumulator.current = 0;
      return;
    }
    direction.set(0, 0, -1).applyQuaternion(quaternion).normalize();
    raycaster.set(origin, direction);
    const hit = raycaster.intersectObjects(scrollSurfaces, false).find((intersection) =>
      intersection.object.userData.displayInstanceRayHitSurface === true
    );
    let displayObject = hit?.object ?? null;
    while (displayObject && displayObject.userData.spatialKind !== "display") {
      displayObject = displayObject.parent;
    }
    const pointedId = displayObject?.userData.spatialElementId as string | undefined;
    if (!hit?.uv || !pointedId || graph.nodes[pointedId]?.mouseBlocked) return;
    scrollAccumulator.current += Math.abs(axis) * JOYSTICK_SCROLL_CLICKS_PER_SECOND * delta;
    const clicks = Math.floor(scrollAccumulator.current);
    if (clicks === 0) return;
    scrollAccumulator.current -= clicks;
    const node = graph.nodes[pointedId];
    const crop = node?.kind === "display"
      ? node.workspaceCrop ?? { x: 0, y: 0, width: 1, height: 1 }
      : { x: 0, y: 0, width: 1, height: 1 };
    onMouse({
      kind: "wheel",
      deltaY: -Math.sign(axis) * clicks,
      x: crop.x + hit.uv.x * crop.width,
      y: crop.y + (1 - hit.uv.y) * crop.height,
    });
  });
  return null;
}

type UikitRoot = THREE.Object3D & {
  root: { peek(): { component: unknown } };
  size: { peek(): unknown };
  update(delta: number): void;
};

/**
 * Lays out the hidden windows' UIKit roots before their first show, one root per frame. A hidden
 * Activity runs no frame jobs, so the first show otherwise laid out every window in one frame
 * (~30 ms for the keyboard alone). Each root gets one more update a frame after its layout: the
 * layout makes its panels visible, and their instance buffers and meshes are built on the root's
 * next frame, which would otherwise be the first show (~7 ms). Only roots that have never been
 * laid out are touched: after a show, the visible frame jobs own layout as before.
 *
 * `layer` must be outside the Activity: refs inside a hidden Activity are detached.
 */
function usePrewarmHiddenUiLayout(
  visible: boolean,
  layer: React.RefObject<THREE.Object3D | null>,
) {
  const queue = React.useRef<{ root: UikitRoot; laidOut: boolean }[]>([]);
  const frame = React.useRef(0);
  useFrame(() => {
    const group = layer.current;
    if (visible || group == null) {
      queue.current.length = 0;
      return;
    }
    const next = queue.current.shift();
    if (next !== undefined) {
      const { root, laidOut } = next;
      if (root.parent == null) return;
      if (laidOut) {
        root.update(0);
      } else if (root.size.peek() == null) {
        root.update(0);
        queue.current.push({ root, laidOut: true });
      }
      return;
    }
    // Hidden content commits at offscreen priority and windows come and go, so look again now
    // and then: traversing the hidden windows takes microseconds.
    if (frame.current++ % 30 !== 0) return;
    group.traverse((object) => {
      const candidate = object as Partial<UikitRoot>;
      if (
        typeof candidate.update === "function" && candidate.root != null &&
        candidate.size != null && candidate.root.peek().component === object &&
        candidate.size.peek() == null
      ) {
        queue.current.push({ root: object as UikitRoot, laidOut: false });
      }
    });
  });
}

function WindowLayer({
  displayOverlayHostActor,
  onMouse,
  onKey,
  directOpenVrInputSource,
}: {
  displayOverlayHostActor: string | null;
  onMouse: DisplayMouseSink;
  onKey: KeyboardSink;
  directOpenVrInputSource?: DirectOpenVrInputSource;
}) {
  const visible = useWindowLayerVisible();
  const constructWithProps = React.useRef(!visible);
  constructWithProps.current = !visible;
  // Text measures and builds during render only once its font has loaded, so wait for the fonts
  // before building the (normally hidden) windows; otherwise the first show measures every label.
  const [fontsLoaded, setFontsLoaded] = React.useState(() =>
    Object.keys(MSDF_FONTS).every((id) => peekMsdfFontAssets(id as MsdfFontId) != null)
  );
  React.useEffect(() => {
    if (fontsLoaded) return;
    let cancelled = false;
    void loadAllMsdfFonts().then(() => {
      if (!cancelled) setFontsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [fontsLoaded]);
  const layer = React.useRef<THREE.Group>(null);
  usePrewarmHiddenUiLayout(visible, layer);
  const camera = useThree((r3fState) => r3fState.camera);
  const renderer = useThree((r3fState) => r3fState.gl);
  const position = React.useMemo(() => new THREE.Vector3(), []);
  const quaternion = React.useMemo(() => new THREE.Quaternion(), []);
  const rotation = React.useMemo(() => new THREE.Euler(), []);
  const forwardOffset = React.useMemo(() => new THREE.Vector3(0, -0.08, -1.35), []);
  const [layoutBootstrap] = React.useState(() => {
    const persistenceEnabled = spatialLayoutPersistenceEnabled();
    const restoredGraph = persistenceEnabled ? loadSpatialLayoutSync() : null;
    return {
      graph: restoredGraph ?? createInitialSpatialGraph(),
      persistenceEnabled,
      restored: restoredGraph != null,
    };
  });
  const [graph, setGraph] = React.useState(layoutBootstrap.graph);
  const graphRef = React.useRef(graph);
  graphRef.current = graph;
  const [layoutSlots, setLayoutSlots] = React.useState(() =>
    layoutBootstrap.persistenceEnabled ? listLayoutSlots() : []
  );
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>("display-1");
  const handleStores = React.useMemo(() => new Map<string, HandleStore<unknown>>(), []);
  const [workspaceOutputs, setWorkspaceOutputs] = React.useState<
    Awaited<ReturnType<typeof loadWorkspaceOutputs>>
  >([]);
  const [persistenceReady, setPersistenceReady] = React.useState(Deno.build.os !== "linux");
  const workspaceOutputsInitialized = React.useRef(false);
  const layoutPositionInitialized = React.useRef(layoutBootstrap.restored);

  React.useEffect(() => {
    let cancelled = false;
    void loadWorkspaceOutputs().then((outputs) => {
      // Reloaded on every show: an equal list keeps its identity, or reconciling it clones the
      // graph, re-renders every window and saves the layout ~0.1 s after each show.
      if (!cancelled) {
        setWorkspaceOutputs((current) =>
          JSON.stringify(current) === JSON.stringify(outputs) ? current : outputs
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  React.useEffect(() => {
    if (workspaceOutputs.length === 0) return;
    const initializing = !workspaceOutputsInitialized.current;
    workspaceOutputsInitialized.current = true;
    setGraph((current) => {
      if (initializing) {
        return initializeWorkspaceLayoutOutputs(
          current,
          workspaceOutputs,
          layoutBootstrap.restored,
        );
      }
      return reconcileWorkspaceOutputs(current, workspaceOutputs);
    });
    if (initializing) setPersistenceReady(true);
  }, [layoutBootstrap.restored, workspaceOutputs]);

  React.useEffect(() => {
    if (!layoutBootstrap.persistenceEnabled || !persistenceReady) return;
    saveSpatialLayoutSync(graph);
  }, [graph, layoutBootstrap.persistenceEnabled, persistenceReady]);

  React.useEffect(() => {
    const displays = Object.values(graph.nodes)
      .filter((node): node is DisplaySpatialNode => node.kind === "display")
      .sort((a, b) => a.ordinal - b.ordinal);
    publishWorkspaceLayout({
      displays: displays.map((display) => ({
        id: display.id,
        ordinal: display.ordinal,
        root: display.parentId == null,
        outputId: display.workspaceOutputId ?? null,
        outputName: display.workspaceOutputName ?? null,
      })),
      outputs: workspaceOutputs.map((output) => ({
        id: output.id,
        name: output.name,
        assignedDisplayId: displays.find((display) =>
          display.workspaceOutputId === output.id
        )?.id ??
          null,
      })),
      layoutSlots,
    });
  }, [graph, layoutSlots, workspaceOutputs]);

  React.useEffect(() =>
    registerWorkspaceLayoutActions({
      assignOutput: (displayId, outputId) => {
        setGraph((current) =>
          assignWorkspaceOutput(current, displayId, outputId, workspaceOutputs)
        );
      },
      addOutput: (outputId) => {
        const output = workspaceOutputs.find((candidate) => candidate.id === outputId);
        if (output != null) {
          setGraph((current) => spawnDisplayForWorkspaceOutput(current, output));
        }
      },
      // Slots save the graph as it is; loading reconciles it with today's outputs, so a slot
      // saved with a monitor that is now unplugged still loads.
      saveSlot: (slot) => {
        if (!layoutBootstrap.persistenceEnabled) return;
        saveSpatialLayoutSync(graphRef.current, getLayoutSlotPath(slot));
        setLayoutSlots(listLayoutSlots());
        pushToast({ title: `Saved layout ${slot}`, timeoutMs: 2000 });
      },
      loadSlot: (slot) => {
        const loaded = loadSpatialLayoutSync(getLayoutSlotPath(slot));
        if (loaded == null) return;
        pushToast({ title: `Loaded layout ${slot}`, timeoutMs: 2000 });
        setGraph(
          workspaceOutputs.length > 0
            ? reconcileWorkspaceOutputs(loaded, workspaceOutputs)
            : loaded,
        );
      },
      getGraph: () => graphRef.current,
      editGraph: (update) => setGraph(update),
    }), [layoutBootstrap.persistenceEnabled, workspaceOutputs]);

  React.useEffect(() => {
    if (selectedNodeId != null && graph.nodes[selectedNodeId]?.kind !== "control") return;
    const fallback = Object.values(graph.nodes)
      .filter((node) => node.kind !== "control")
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    setSelectedNodeId(fallback?.id ?? null);
  }, [graph, selectedNodeId]);

  React.useLayoutEffect(() => {
    if (!visible || layoutPositionInitialized.current) return;
    layoutPositionInitialized.current = true;
    const xr = (renderer as unknown as {
      xr?: { getCamera?: (camera: THREE.Camera) => THREE.Camera };
    }).xr;
    const poseCamera = Deno.args.includes("--desktop")
      ? camera
      : xr?.getCamera?.(camera as unknown as THREE.Camera) ?? camera;
    poseCamera.updateWorldMatrix(true, false);
    poseCamera.getWorldPosition(position);
    poseCamera.getWorldQuaternion(quaternion);
    position.add(forwardOffset.clone().applyQuaternion(quaternion));
    rotation.setFromQuaternion(quaternion, "XYZ");
    setGraph((current) => {
      const primaryDisplay = Object.values(current.nodes)
        .filter((node): node is DisplaySpatialNode =>
          node.kind === "display" && node.parentId == null
        )
        .sort((a, b) => a.ordinal - b.ordinal)[0];
      if (primaryDisplay == null) return current;
      return commitNodeTransform(current, primaryDisplay.id, {
        position: position.toArray() as [number, number, number],
        rotation: [rotation.x, rotation.y, rotation.z],
        scale: primaryDisplay.localTransform.scale,
      });
    });
  }, [camera, forwardOffset, position, quaternion, renderer, rotation, visible]);

  React.useEffect(() =>
    subscribeLayoutRecenter(() => {
      const xr = (renderer as unknown as {
        xr?: { getCamera?: (camera: THREE.Camera) => THREE.Camera };
      }).xr;
      const poseCamera = Deno.args.includes("--desktop")
        ? camera
        : xr?.getCamera?.(camera as unknown as THREE.Camera) ?? camera;
      poseCamera.updateWorldMatrix(true, false);
      const head = poseCamera.getWorldPosition(new THREE.Vector3());
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
        poseCamera.getWorldQuaternion(new THREE.Quaternion()),
      );
      const yaw = Math.atan2(-forward.x, -forward.z);
      setGraph((current) =>
        recenterSpatialRoots(
          current,
          head.toArray() as [number, number, number],
          yaw,
          forwardOffset.toArray() as [number, number, number],
        )
      );
    }), [camera, forwardOffset, renderer]);

  // Hiding keeps the windows built: unmounting them and building them again stalled a frame by
  // ~0.4 s on every show (~0.2 s on hide). A hidden Activity keeps React's tree and the three
  // objects but runs effect cleanups, so a hidden window has no frame jobs and no OpenVR overlay.
  // Pointer events ignore `visible`, so the wrapper also stops rays reaching hidden windows. The
  // audio provider stays outside: acquiring it brings up the native audio device. UI built while
  // hidden takes its props at construction, so the first show does not restyle every window.
  return (
    <SpatialAudioProvider>
      <group ref={layer} {...({ intersectChildren: visible } as Record<string, unknown>)}>
        <React.Activity mode={visible ? "visible" : "hidden"}>
          <ConstructWithPropsContext.Provider value={constructWithProps}>
            <WindowLayerContent
              fontsLoaded={fontsLoaded}
              graph={graph}
              setGraph={setGraph}
              workspaceOutputs={workspaceOutputs}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNodeId}
              handleStores={handleStores}
              directOpenVrInputSource={directOpenVrInputSource}
              displayOverlayHostActor={displayOverlayHostActor}
              onMouse={onMouse}
              onKey={onKey}
            />
          </ConstructWithPropsContext.Provider>
        </React.Activity>
      </group>
    </SpatialAudioProvider>
  );
}

/**
 * The windows inside the layer's Activity. Memoized so showing and hiding the layer, which
 * re-renders `WindowLayer`, does not re-render every window: revealing the Activity re-runs their
 * effects either way, and the re-render added ~650 UIKit component renders to each show.
 */
const WindowLayerContent = React.memo(function WindowLayerContent(
  { fontsLoaded, ...props }: SpatialGraphViewProps & { fontsLoaded: boolean },
) {
  const { graph, directOpenVrInputSource, handleStores, onMouse } = props;
  return (
    <group userData={{ spatialGraphRoot: true, originId: SCENE_ORIGIN_ID, static: true }}>
      <CommonOverlayChords
        inputSource={directOpenVrInputSource}
        graph={graph}
        handleStores={handleStores}
        onMouse={onMouse}
      />
      {fontsLoaded && getSpatialChildren(graph, null).map((node) => (
        <SpatialRootOrigin key={node.id} originId={node.originId}>
          <SpatialNodeView key={node.id} node={node} {...props} />
        </SpatialRootOrigin>
      ))}
    </group>
  );
});

/**
 * Holds one root window. Attached to the head or a hand, each frame its matrix becomes that
 * space's pose (in its parent's space), so the window's local transform is relative to it; in the
 * world it stays at identity. Runs in the default phase, ahead of the display pose sync in
 * `finish`. An untracked controller holds the last pose.
 *
 * Every root gets one, keyed by the root, so re-anchoring only changes `originId`: moving the
 * window under a different group remounted it, and rebuilding its UI stalled a frame ~0.5 s.
 */
function SpatialRootOrigin(
  { originId, children }: { originId: string; children: React.ReactNode },
) {
  const ref = React.useRef<THREE.Group>(null);
  const tracked = isTrackedOriginId(originId);
  React.useLayoutEffect(() => {
    const group = ref.current;
    if (group == null || tracked) return;
    group.matrix.identity();
    group.matrixWorldNeedsUpdate = true;
  }, [tracked]);
  const camera = useThree((r3fState) => r3fState.camera);
  const renderer = useThree((r3fState) => r3fState.gl);
  const scratch = React.useMemo(
    () => ({ world: new THREE.Matrix4(), parent: new THREE.Matrix4() }),
    [],
  );
  useFrame(() => {
    const group = ref.current;
    if (group == null || !isTrackedOriginId(originId)) return;
    const head = getHeadObject(renderer, camera as unknown as THREE.Camera);
    if (!getTrackedOriginWorldMatrix(originId, head, scratch.world)) return;
    const parent = group.parent;
    if (parent != null) {
      parent.updateWorldMatrix(true, false);
      group.matrix.copy(scratch.parent.copy(parent.matrixWorld).invert().multiply(scratch.world));
    } else {
      group.matrix.copy(scratch.world);
    }
    group.matrixWorldNeedsUpdate = true;
  });
  return (
    <group
      ref={ref}
      matrixAutoUpdate={false}
      userData={{ renderTrackingAnchor: tracked ? originId : undefined }}
    >
      {children}
    </group>
  );
}

/**
 * "Anchored to" choices for a node's whole hierarchy: World, Head, Left hand, Right hand. The
 * window stays where it is at the moment of the switch; from then on it moves with the new anchor.
 */
/**
 * The local transform that keeps root `rootId` where it is in the world once it hangs off
 * `originId`, so re-anchoring never makes it jump. "untracked" when that space has no pose right
 * now; null when the root isn't in the scene.
 */
export function anchoredRootTransform(
  scene: THREE.Object3D,
  head: THREE.Object3D,
  rootId: string,
  originId: SpatialOriginId,
): SpatialTransform | "untracked" | null {
  let rootObject: THREE.Object3D | null = null;
  let sceneRoot: THREE.Object3D | null = null;
  scene.traverse((object) => {
    if (object.userData?.spatialElementId === rootId) rootObject = object as THREE.Object3D;
    if (object.userData?.spatialGraphRoot === true) sceneRoot = object as THREE.Object3D;
  });
  const anchor = new THREE.Matrix4();
  if (isTrackedOriginId(originId)) {
    if (!getTrackedOriginWorldMatrix(originId, head, anchor)) return "untracked";
  } else if (sceneRoot != null) {
    (sceneRoot as THREE.Object3D).updateWorldMatrix(true, false);
    anchor.copy((sceneRoot as THREE.Object3D).matrixWorld);
  }
  if (rootObject == null) return null;
  const root = rootObject as THREE.Object3D;
  root.updateWorldMatrix(true, false);
  const local = anchor.invert().multiply(root.matrixWorld);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  local.decompose(position, quaternion, scale);
  const rotation = new THREE.Euler().setFromQuaternion(quaternion, "XYZ");
  return {
    position: position.toArray() as [number, number, number],
    rotation: [rotation.x, rotation.y, rotation.z],
    scale: scale.toArray() as [number, number, number],
  };
}

function AnchorSettingsSection(
  { graph, node, setGraph }: {
    graph: SpatialGraph;
    node: SpatialNode;
    setGraph: React.Dispatch<React.SetStateAction<SpatialGraph>>;
  },
) {
  const scene = useThree((r3fState) => r3fState.scene);
  const camera = useThree((r3fState) => r3fState.camera);
  const renderer = useThree((r3fState) => r3fState.gl);
  const rootId = getSpatialRootId(graph, node.id);
  const current = graph.nodes[rootId]?.originId ?? SCENE_ORIGIN_ID;

  const anchorTo = (originId: SpatialOriginId) => {
    if (originId === current) return;
    const head = getHeadObject(renderer, camera as unknown as THREE.Camera);
    const local = anchoredRootTransform(scene, head, rootId, originId);
    if (local === "untracked") {
      pushToast({ title: `${SPATIAL_ORIGIN_LABEL[originId]} isn't tracked`, tone: "warning" });
      return;
    }
    if (local == null) return;
    setGraph((latest) => setSpatialRootOrigin(latest, rootId, originId, local));
  };

  return (
    <SpatialSettingsSection label={rootId === node.id ? "Anchored to" : "Group anchored to"}>
      {SPATIAL_ORIGIN_IDS.map((originId) => (
        <SpatialSettingsButton
          key={originId}
          label={SPATIAL_ORIGIN_LABEL[originId]}
          selected={current === originId}
          onClick={() => anchorTo(originId)}
        />
      ))}
    </SpatialSettingsSection>
  );
}

const OPACITY_STEPS = [1, 0.75, 0.5, 0.25] as const;

function OpacitySettingsSection(
  { node, setGraph }: {
    node: SpatialNode;
    setGraph: React.Dispatch<React.SetStateAction<SpatialGraph>>;
  },
) {
  const current = node.opacity ?? 1;
  return (
    <SpatialSettingsSection label="Opacity">
      {OPACITY_STEPS.map((step) => (
        <SpatialSettingsButton
          key={step}
          label={`${Math.round(step * 100)}%`}
          selected={Math.abs(current - step) < 0.001}
          onClick={() => setGraph((latest) => setSpatialNodeOpacity(latest, node.id, step))}
        />
      ))}
    </SpatialSettingsSection>
  );
}

function MouseSettingsSection(
  { node, setGraph }: {
    node: SpatialNode;
    setGraph: React.Dispatch<React.SetStateAction<SpatialGraph>>;
  },
) {
  const blocked = node.mouseBlocked ?? false;
  const set = (next: boolean) =>
    setGraph((latest) => setSpatialNodeMouseBlocked(latest, node.id, next));
  return (
    <SpatialSettingsSection label="Laser drives mouse">
      <SpatialSettingsButton label="On" selected={!blocked} onClick={() => set(false)} />
      <SpatialSettingsButton label="Off" selected={blocked} onClick={() => set(true)} />
    </SpatialSettingsSection>
  );
}

function AutoHideSettingsSection(
  { node, setGraph }: {
    node: SpatialNode;
    setGraph: React.Dispatch<React.SetStateAction<SpatialGraph>>;
  },
) {
  const on = node.autoHide ?? false;
  const set = (next: boolean) =>
    setGraph((latest) => setSpatialNodeAutoHide(latest, node.id, next));
  return (
    <SpatialSettingsSection label="Hide when looking away">
      <SpatialSettingsButton label="On" selected={on} onClick={() => set(true)} />
      <SpatialSettingsButton label="Off" selected={!on} onClick={() => set(false)} />
    </SpatialSettingsSection>
  );
}

function TypingSoundSettingsSection() {
  const on = useSetting("typingSounds");
  return (
    <SpatialSettingsSection label="Typing sounds">
      <SpatialSettingsButton
        label="On"
        selected={on}
        onClick={() => setSetting("typingSounds", true)}
      />
      <SpatialSettingsButton
        label="Off"
        selected={!on}
        onClick={() => setSetting("typingSounds", false)}
      />
    </SpatialSettingsSection>
  );
}

/** Key legends: Auto follows `--keyboard-locale` / the host layout, the rest pin a locale. */
function KeyboardLocaleSettingsSection() {
  const chosen = useSetting("keyboardLocale");
  const active = useKeyboardLocale();
  return (
    <SpatialSettingsSection label="Key legends">
      <SpatialSettingsButton
        label="Auto"
        selected={chosen == null}
        onClick={() => setSetting("keyboardLocale", null)}
      />
      {Object.values(KEYBOARD_LOCALES).map((locale) => (
        <SpatialSettingsButton
          key={locale.id}
          label={locale.label}
          selected={chosen != null && active.id === locale.id}
          onClick={() => setSetting("keyboardLocale", locale.id)}
        />
      ))}
    </SpatialSettingsSection>
  );
}

/** Curvature as OpenVR's fraction of a full cylinder; 0.2 on a default display is a ~1.4 m radius. */
const CURVATURE_STEPS = [0, 0.1, 0.2, 0.3] as const;

function CurvatureSettingsSection(
  { node, setGraph }: {
    node: SpatialNode;
    setGraph: React.Dispatch<React.SetStateAction<SpatialGraph>>;
  },
) {
  const current = node.curvature ?? 0;
  return (
    <SpatialSettingsSection label="Curve">
      {CURVATURE_STEPS.map((step) => (
        <SpatialSettingsButton
          key={step}
          label={step === 0 ? "Flat" : `${Math.round(step * 100)}%`}
          selected={Math.abs(current - step) < 0.001}
          onClick={() => setGraph((latest) => setSpatialNodeCurvature(latest, node.id, step))}
        />
      ))}
    </SpatialSettingsSection>
  );
}

type SpatialGraphViewProps = {
  graph: SpatialGraph;
  setGraph: React.Dispatch<React.SetStateAction<SpatialGraph>>;
  workspaceOutputs: WorkspaceOutput[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  handleStores: Map<string, HandleStore<unknown>>;
  directOpenVrInputSource?: DirectOpenVrInputSource;
  displayOverlayHostActor: string | null;
  onMouse: DisplayMouseSink;
  onKey: KeyboardSink;
};

type SpatialNodeViewProps = SpatialGraphViewProps & {
  node: SpatialNode;
  manipulationTargetRef?: React.RefObject<THREE.Object3D | null>;
  manipulationOptions?: Omit<HandleOptions<unknown>, "filter">;
  manipulationStoreRef?: React.Ref<HandleStore<unknown>>;
  localTransformOverride?: SpatialTransform;
};

const VR_HINGE_BREAKAWAY_SLACK_METERS = 0.28;
const DESKTOP_HINGE_BREAKAWAY_SLACK_PIXELS = 180;
/** After a grab starts, re-arm the baseline for this long so the capture can settle. */
const HINGE_BREAKAWAY_SETTLE_SECONDS = 0.25;
/** Consecutive frames past the threshold before it counts as a pull, not jitter. */
const HINGE_BREAKAWAY_HOLD_FRAMES = 3;
const DELETE_ARM_SIZE_METERS = 0.1;
const DELETE_DISARM_SIZE_METERS = 0.13;
const DISPLAY_GRAB_SIZE: [number, number, number] = [
  DISPLAY_PANEL_WIDTH,
  DEFAULT_DISPLAY_HEIGHT,
  DEFAULT_DISPLAY_DEPTH,
];

function objectTransform(target: import("three").Object3D): SpatialTransform {
  const object = target as unknown as THREE.Object3D;
  return {
    position: object.position.toArray() as [number, number, number],
    rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
    scale: object.scale.toArray() as [number, number, number],
  };
}

/** A locked node keeps its handle (so a grab is still swallowed) but every axis is frozen. */
function useLockedGrabOptions(
  options: Omit<HandleOptions<unknown>, "filter">,
  locked: boolean,
): Omit<HandleOptions<unknown>, "filter"> {
  return React.useMemo(
    () => locked ? { ...options, translate: false, rotate: false, scale: false } : options,
    [locked, options],
  );
}

function useScaleToDelete(
  nodeId: string,
  grabSize: [number, number, number],
  baseOptions: Omit<HandleOptions<unknown>, "filter">,
  setGraph: React.Dispatch<React.SetStateAction<SpatialGraph>>,
) {
  const [armed, setArmed] = React.useState(false);
  const armedRef = React.useRef(false);
  const sawTwoPointerScaleRef = React.useRef(false);
  const worldScale = React.useMemo(() => new THREE.Vector3(), []);
  const setDeleteArmed = React.useCallback((next: boolean) => {
    if (armedRef.current === next) return;
    armedRef.current = next;
    setArmed(next);
  }, []);
  const apply = React.useCallback(
    (state: HandleState<unknown>, target: import("three").Object3D) => {
      if (state.first) {
        sawTwoPointerScaleRef.current = false;
        setDeleteArmed(false);
      }
      if (state.last && armedRef.current && state.event != null) {
        setDeleteArmed(false);
        sawTwoPointerScaleRef.current = false;
        setGraph((current) => deleteSpatialNode(current, nodeId));
        return;
      }

      (baseOptions.apply ?? defaultApply)(state, target);
      // Two-pointer scale only: a single squeeze-grab never arms delete, and
      // the armed flag (a React state → full subtree re-render + uikit text
      // rebuild) only flips on the arm/disarm edges, not during the grab.
      if (!state.last && state.current.pointerAmount >= 2) {
        sawTwoPointerScaleRef.current = true;
      }
      if (!state.last && sawTwoPointerScaleRef.current) {
        const targetObject = target as unknown as THREE.Object3D;
        targetObject.updateWorldMatrix(true, false);
        targetObject.getWorldScale(worldScale);
        const worldSize = Math.max(
          Math.abs(worldScale.x) * grabSize[0],
          Math.abs(worldScale.y) * grabSize[1],
          Math.abs(worldScale.z) * grabSize[2],
        );
        setDeleteArmed(
          armedRef.current
            ? worldSize < DELETE_DISARM_SIZE_METERS
            : worldSize < DELETE_ARM_SIZE_METERS,
        );
      }
      if (state.last) {
        setDeleteArmed(false);
        sawTwoPointerScaleRef.current = false;
      }
    },
    [baseOptions, grabSize, nodeId, setDeleteArmed, setGraph, worldScale],
  );
  const options = React.useMemo(
    () => ({ ...baseOptions, apply }),
    [apply, baseOptions],
  );
  return { armed, options };
}

function ScaleDeleteIndicator({ grabSize }: { grabSize: [number, number, number] }) {
  const radius = 0.6 * Math.hypot(...grabSize);
  return (
    <mesh
      scale={[radius, radius, radius]}
      renderOrder={1000}
      {...({ pointerEvents: "none" } as Record<string, unknown>)}
    >
      <sphereGeometry args={[1, 24, 16]} />
      <meshBasicNodeMaterial
        colorNode={TSL.color(0xff1838)}
        transparent
        opacity={0.28}
        depthWrite={false}
      />
    </mesh>
  );
}

function SpatialNodeView({
  node,
  setGraph,
  ...props
}: SpatialNodeViewProps) {
  if (node.kind === "control") {
    return <SpatialControlView node={node} setGraph={setGraph} />;
  }
  if (node.kind === "keyboard") {
    return <KeyboardSpatialNodeView {...props} node={node} setGraph={setGraph} />;
  }
  return <DisplaySpatialNodeView {...props} node={node} setGraph={setGraph} />;
}

function DisplaySpatialNodeView({
  node,
  graph,
  setGraph,
  workspaceOutputs,
  selectedNodeId,
  onSelectNode,
  handleStores,
  directOpenVrInputSource,
  displayOverlayHostActor,
  onMouse,
  onKey,
  manipulationTargetRef,
  manipulationOptions,
  manipulationStoreRef,
  localTransformOverride,
}: SpatialNodeViewProps & { node: DisplaySpatialNode }) {
  const nodeRef = React.useRef<THREE.Group>(null);
  const [hovered, setHovered] = React.useState(false);
  const grabOutlineVisible = useGrabboxOutlineVisible();
  const local = localTransformOverride ?? node.localTransform;
  // A borrowed target (a slot's frame) sits outside this node's own transform; a hinge frame
  // leaves the node's scale inside it.
  const innerScale = manipulationTargetRef == null ? 1 : local.scale[0];

  const commitFreeTransform = React.useCallback(
    (state: HandleState<unknown>, target: import("three").Object3D) => {
      applyDampedHandleState(state, target);
      if (state.last) {
        const nextTransform = objectTransform(target);
        setGraph((current) => commitSpatialNodeTransformAndSnap(current, node.id, nextTransform));
      }
    },
    [node.id, setGraph],
  );
  const targetRef = manipulationTargetRef ?? nodeRef;
  const setManipulationStore = React.useCallback((store: HandleStore<unknown> | null) => {
    if (store) handleStores.set(node.id, store);
    else handleStores.delete(node.id);
    if (typeof manipulationStoreRef === "function") manipulationStoreRef(store);
    else if (manipulationStoreRef) {
      (manipulationStoreRef as React.MutableRefObject<HandleStore<unknown> | null>).current = store;
    }
  }, [handleStores, manipulationStoreRef, node.id]);
  const baseOptions = React.useMemo(
    () =>
      withTriggerResize(
        manipulationOptions ?? freeGrabOptions({ apply: commitFreeTransform }),
        handleStores,
        DISPLAY_GRAB_SIZE[0] * innerScale,
      ),
    [commitFreeTransform, handleStores, manipulationOptions, innerScale],
  );
  const deletion = useScaleToDelete(node.id, DISPLAY_GRAB_SIZE, baseOptions, setGraph);
  const grabOptions = useLockedGrabOptions(deletion.options, node.locked ?? false);
  const children = getSpatialChildren(graph, node.id);
  const attachmentRole = getDisplayAttachmentRole(graph, node.id);
  const outputConnected = node.workspaceOutputId != null && node.workspaceOutputConnected !== false;
  const activeDisplayOverlayHostActor = outputConnected ? displayOverlayHostActor : null;
  const workspaceCrop = node.workspaceCrop ?? { x: 0, y: 0, width: 1, height: 1 };
  const mouseButtonForPointer = React.useCallback((event: PenPointerEvent) => {
    const handedness = (event.pointerState as { inputSource?: { handedness?: XRHandedness } })
      .inputSource?.handedness;
    return handedness === "left" || handedness === "right"
      ? directOpenVrInputSource?.getDesktopMouseButton(handedness)
      : undefined;
  }, [directOpenVrInputSource]);
  const croppedMouseSink = React.useMemo<DisplayMouseSink>(() => (event) => {
    onMouse({
      ...event,
      x: workspaceCrop.x + event.x * workspaceCrop.width,
      y: workspaceCrop.y + event.y * workspaceCrop.height,
    });
  }, [onMouse, workspaceCrop.x, workspaceCrop.y, workspaceCrop.width, workspaceCrop.height]);
  const selectNode = React.useCallback(() => onSelectNode(node.id), [node.id, onSelectNode]);
  const contextActions = React.useMemo<SpatialContextAction[]>(() => {
    const actions: SpatialContextAction[] = [];
    if (hasAvailableDisplayAttachmentSlot(graph, node.id)) {
      actions.push({
        id: "add-display",
        label: "Add display",
        // No accent: the accent means "this state is on", and adding a display
        // is an action with no state behind it.
        run: () =>
          setGraph((current) =>
            spawnHingedDisplayWithAutomaticOutput(current, node.id, workspaceOutputs)
          ),
      });
    }
    if (node.parentId != null || attachmentRole === "parent") {
      actions.push({
        id: "detach",
        label: "Linked — detach",
        // Accent because this reports a state: the button only exists while the
        // node is attached, so a lit button means "linked" and pressing it
        // unlinks — the same on/off reading as the wrist panel's mode buttons.
        tone: "accent",
        run: () => setGraph((current) => detachDisplayHierarchy(current, node.id)),
      });
    }
    actions.push({
      id: "lock",
      label: node.locked ? "Locked — unlock" : "Lock",
      // Accent reports the state, as with "Linked — detach".
      tone: node.locked ? "accent" : "normal",
      run: () => setGraph((current) => setSpatialNodeLocked(current, node.id, !node.locked)),
    });
    actions.push({
      id: "delete",
      label: "Delete",
      tone: "danger",
      run: () => setGraph((current) => deleteSpatialNode(current, node.id)),
    });
    return actions;
  }, [attachmentRole, graph, node.id, node.parentId, setGraph, workspaceOutputs]);
  // A keyboard hinged under the window would sit in front of a toolbar hanging below it.
  const toolbarSide = displayToolbarSide(graph, node.id);
  const assignedSide = node.constraint?.kind === "hinge"
    ? node.constraint.attachmentSlotId.match(/-(left|right|top|bottom)-slot$/)?.[1]
    : undefined;

  return (
    <group
      ref={nodeRef}
      position={local.position}
      rotation={local.rotation}
      scale={local.scale}
      userData={{
        spatialElement: true,
        spatialElementId: node.id,
        spatialKind: node.kind,
        parentId: node.parentId,
        originId: node.originId,
        attachmentRole,
        workspaceCrop: node.workspaceCrop ?? null,
        workspaceOutputId: node.workspaceOutputId ?? null,
        workspaceOutputName: node.workspaceOutputName ?? null,
        workspaceOutputConnected: node.workspaceOutputConnected ?? null,
      }}
    >
      {deletion.armed ? <ScaleDeleteIndicator grabSize={DISPLAY_GRAB_SIZE} /> : null}
      <DisplayInstance
        displayOverlayHostActor={activeDisplayOverlayHostActor}
        virtualDisplayId={node.id}
        virtualDisplayName={node.workspaceOutputName ?? `PetPlay ${node.id}`}
        workspaceCrop={workspaceCrop}
        opacity={node.opacity}
        curvature={node.curvature}
        autoHide={node.autoHide}
        onMouse={activeDisplayOverlayHostActor != null && !node.mouseBlocked
          ? croppedMouseSink
          : undefined}
        mouseButtonForPointer={mouseButtonForPointer}
        rayHitSurface={activeDisplayOverlayHostActor != null}
        shellRayPickable={activeDisplayOverlayHostActor == null}
        manipulationTargetRef={targetRef}
        manipulationOptions={grabOptions}
        manipulationStoreRef={setManipulationStore}
        onSpatialFocus={selectNode}
        onSpatialHoverChange={setHovered}
      >
        <SpatialHierarchyIndicator
          role={attachmentRole ?? "solo"}
          position={[0, DEFAULT_DISPLAY_HEIGHT * 0.5 + 0.055, DEFAULT_DISPLAY_DEPTH]}
          // The open toolbar carries the badge instead.
          visible={hovered && attachmentRole != null && selectedNodeId !== node.id}
        />
        <SpatialContextToolbar
          open={selectedNodeId === node.id}
          title={node.workspaceOutputName ?? `Display ${node.ordinal}`}
          side={toolbarSide}
          position={toolbarSide === "left" || toolbarSide === "right"
            ? [
              (toolbarSide === "right" ? 0.5 : -0.5) * DISPLAY_PANEL_WIDTH,
              DEFAULT_DISPLAY_HEIGHT * 0.5,
              DEFAULT_DISPLAY_DEPTH,
            ]
            : [
              0,
              (toolbarSide === "above" ? 0.5 : -0.5) * DEFAULT_DISPLAY_HEIGHT,
              DEFAULT_DISPLAY_DEPTH,
            ]}
          settingsPosition={[
            DISPLAY_PANEL_WIDTH * 0.5,
            DEFAULT_DISPLAY_HEIGHT * 0.5,
            DEFAULT_DISPLAY_DEPTH,
          ]}
          role={attachmentRole ?? undefined}
          actions={contextActions}
          settings={
            <>
              <SpatialSettingsSection label="Physical output">
                {workspaceOutputs.map((output) => (
                  <SpatialSettingsButton
                    key={output.id}
                    label={output.name}
                    selected={node.workspaceOutputId === output.id}
                    onClick={() =>
                      setGraph((current) =>
                        assignWorkspaceOutput(current, node.id, output.id, workspaceOutputs)
                      )}
                  />
                ))}
              </SpatialSettingsSection>
              <AnchorSettingsSection graph={graph} node={node} setGraph={setGraph} />
              <OpacitySettingsSection node={node} setGraph={setGraph} />
              <MouseSettingsSection node={node} setGraph={setGraph} />
              <AutoHideSettingsSection node={node} setGraph={setGraph} />
              <CurvatureSettingsSection node={node} setGraph={setGraph} />
              <SpatialSettingsSection
                label={assignedSide == null ? "Free spatial element" : `Attached: ${assignedSide}`}
              >
                <SpatialSettingsButton
                  label="Grab outline"
                  selected={grabOutlineVisible}
                  onClick={() => setGrabboxOutlineVisible(!grabOutlineVisible)}
                />
                <SpatialSettingsButton
                  label="Reset pose"
                  onClick={() => setGraph((current) => resetSpatialNodeTransform(current, node.id))}
                />
              </SpatialSettingsSection>
            </>
          }
        />
      </DisplayInstance>
      {children.map((child) => (
        <SpatialAttachmentView
          key={child.id}
          node={child}
          graph={graph}
          setGraph={setGraph}
          workspaceOutputs={workspaceOutputs}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
          handleStores={handleStores}
          directOpenVrInputSource={directOpenVrInputSource}
          displayOverlayHostActor={displayOverlayHostActor}
          onMouse={onMouse}
          onKey={onKey}
        />
      ))}
    </group>
  );
}

function KeyboardSpatialNodeView({
  node,
  graph,
  setGraph,
  workspaceOutputs,
  selectedNodeId,
  onSelectNode,
  handleStores,
  directOpenVrInputSource,
  displayOverlayHostActor,
  onMouse,
  onKey,
  manipulationTargetRef,
  manipulationOptions,
  manipulationStoreRef,
  localTransformOverride,
}: SpatialNodeViewProps & { node: KeyboardSpatialNode }) {
  const nodeRef = React.useRef<THREE.Group>(null);
  const local = localTransformOverride ?? node.localTransform;
  // A borrowed target (a slot's frame) sits outside this node's own transform; a hinge frame
  // leaves the node's scale inside it.
  const innerScale = manipulationTargetRef == null ? 1 : local.scale[0];
  const commitFreeTransform = React.useCallback(
    (state: HandleState<unknown>, target: import("three").Object3D) => {
      applyDampedHandleState(state, target);
      if (state.last) {
        const nextTransform = objectTransform(target);
        setGraph((current) => commitSpatialNodeTransformAndSnap(current, node.id, nextTransform));
      }
    },
    [node.id, setGraph],
  );
  const updateBounds = React.useCallback(
    (size: [number, number, number]) => {
      setGraph((current) => updateSnapSourceSize(current, node.id, size));
    },
    [node.id, setGraph],
  );
  const targetRef = manipulationTargetRef ?? nodeRef;
  const setManipulationStore = React.useCallback((store: HandleStore<unknown> | null) => {
    if (store) handleStores.set(node.id, store);
    else handleStores.delete(node.id);
    if (typeof manipulationStoreRef === "function") manipulationStoreRef(store);
    else if (manipulationStoreRef) {
      (manipulationStoreRef as React.MutableRefObject<HandleStore<unknown> | null>).current = store;
    }
  }, [handleStores, manipulationStoreRef, node.id]);
  const baseOptions = React.useMemo(
    () =>
      withTriggerResize(
        manipulationOptions ?? freeGrabOptions({ apply: commitFreeTransform }),
        handleStores,
        node.snapSource.size[0] * innerScale,
      ),
    [commitFreeTransform, handleStores, manipulationOptions, node.snapSource.size, innerScale],
  );
  const deletion = useScaleToDelete(node.id, node.snapSource.size, baseOptions, setGraph);
  const grabOptions = useLockedGrabOptions(deletion.options, node.locked ?? false);
  const children = getSpatialChildren(graph, node.id);
  const selectNode = React.useCallback(() => onSelectNode(node.id), [node.id, onSelectNode]);
  const contextActions = React.useMemo<SpatialContextAction[]>(() => {
    const actions: SpatialContextAction[] = [{
      id: "reset",
      label: "Reset pose",
      run: () => setGraph((current) => resetSpatialNodeTransform(current, node.id)),
    }];
    if (node.parentId != null) {
      actions.push({
        id: "detach",
        label: "Linked — detach",
        // See the display toolbar: accent reports the attached state.
        tone: "accent",
        run: () => setGraph((current) => detachFromParent(current, node.id)),
      });
    }
    actions.push({
      id: "lock",
      label: node.locked ? "Locked — unlock" : "Lock",
      // Accent reports the state, as with "Linked — detach".
      tone: node.locked ? "accent" : "normal",
      run: () => setGraph((current) => setSpatialNodeLocked(current, node.id, !node.locked)),
    });
    actions.push({
      id: "delete",
      label: "Delete",
      tone: "danger",
      run: () => setGraph((current) => deleteSpatialNode(current, node.id)),
    });
    return actions;
  }, [node.id, node.locked, node.parentId, setGraph]);

  return (
    <group
      ref={nodeRef}
      position={local.position}
      rotation={local.rotation}
      scale={local.scale}
      userData={{
        spatialElement: true,
        spatialElementId: node.id,
        spatialKind: node.kind,
        parentId: node.parentId,
        originId: node.originId,
      }}
    >
      {deletion.armed ? <ScaleDeleteIndicator grabSize={node.snapSource.size} /> : null}
      <KeyboardPanel
        position={[0, 0, 0]}
        rotation={[0, 0, 0]}
        scale={[1, 1, 1]}
        onKey={onKey}
        manipulationTargetRef={targetRef}
        manipulationOptions={grabOptions}
        manipulationStoreRef={setManipulationStore}
        onGrabBoxSize={updateBounds}
        onSpatialFocus={selectNode}
        opacity={node.opacity}
      >
        <SpatialContextToolbar
          open={selectedNodeId === node.id}
          title="Keyboard"
          position={[0, -node.snapSource.size[1] * 0.5, node.snapSource.size[2]]}
          actions={contextActions}
          settings={
            <>
              <AnchorSettingsSection graph={graph} node={node} setGraph={setGraph} />
              <OpacitySettingsSection node={node} setGraph={setGraph} />
              <TypingSoundSettingsSection />
              <KeyboardLocaleSettingsSection />
            </>
          }
        />
      </KeyboardPanel>
      {children.map((child) => (
        <SpatialAttachmentView
          key={child.id}
          node={child}
          graph={graph}
          setGraph={setGraph}
          workspaceOutputs={workspaceOutputs}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
          handleStores={handleStores}
          directOpenVrInputSource={directOpenVrInputSource}
          displayOverlayHostActor={displayOverlayHostActor}
          onMouse={onMouse}
          onKey={onKey}
        />
      ))}
    </group>
  );
}

/**
 * Memoized: a spatial subtree (e.g. a display with a hinged keyboard) is re-created by its parent's
 * render, and the parent re-renders on hover/selection changes that leave the child's props — the
 * graph, the handle stores, the sinks — untouched. Without this, moving the laser over a display
 * re-rendered its attached keyboard's ~74 key caps.
 */
const SpatialAttachmentView = React.memo(
  function SpatialAttachmentView(props: SpatialNodeViewProps) {
    const { node } = props;
    if (node.kind === "control") {
      return <SpatialNodeView {...props} />;
    }
    return <AttachedSpatialNodeView {...props} node={node} />;
  },
);

function AttachedSpatialNodeView(
  props: SpatialNodeViewProps & {
    node: DisplaySpatialNode | KeyboardSpatialNode;
  },
) {
  const { node, setGraph } = props;
  const hinge: HingeConstraint | undefined = node.constraint?.kind === "hinge"
    ? node.constraint
    : undefined;
  const oneHandScaleMaxGrabOffset = useHingedOneHandScaleMaxGrabOffset();
  const camera = useThree((state) => state.camera);
  const canvasSize = useThree((state) => state.size);
  const targetRef = React.useRef<THREE.Group>(null);
  const handleStoreRef = React.useRef<HandleStore<unknown>>(null);
  const handoffPendingRef = React.useRef(false);
  const handoffActiveRef = React.useRef(false);
  const handoffMovedRef = React.useRef(false);
  const initialGrabberDistanceRef = React.useRef<number | null>(null);
  const breakawayTriggeredRef = React.useRef(false);
  const breakawayHoldRef = React.useRef(0);
  const breakawaySettleUntilRef = React.useRef(0);
  const hingeWorldPositionRef = React.useRef(new THREE.Vector3());
  const hingeScreenPositionRef = React.useRef(new THREE.Vector3());
  const handoffWorldDeltaRef = React.useRef(new THREE.Vector3());
  const handoffWorldPositionRef = React.useRef(new THREE.Vector3());
  const currentGrabWorldPositionRef = React.useRef(new THREE.Vector3());
  const grabbedObjectRef = React.useRef<THREE.Object3D | null>(null);
  const localGrabPointRef = React.useRef(new THREE.Vector3());
  const frameScaleResetRef = React.useRef(false);
  // Drop the transient pinch factor from the hinge frame in the same commit that puts the committed
  // size on the node. Doing it any earlier (or letting the render do it) flashes the old size for a
  // frame: the frame's `[1, 1, 1]` prop never changes, so React never re-applies it.
  React.useLayoutEffect(() => {
    const target = targetRef.current;
    if (!frameScaleResetRef.current || target == null) return;
    frameScaleResetRef.current = false;
    target.scale.setScalar(1);
  }, [node]);
  React.useLayoutEffect(() => {
    if (hinge != null || !handoffPendingRef.current) return;
    const target = targetRef.current;
    if (target != null && handoffWorldDeltaRef.current.lengthSq() > 0) {
      target.updateWorldMatrix(true, false);
      const desiredWorldPosition = handoffWorldPositionRef.current
        .setFromMatrixPosition(target.matrixWorld)
        .add(handoffWorldDeltaRef.current);
      if (target.parent != null) {
        target.parent.updateWorldMatrix(true, false);
        target.parent.worldToLocal(desiredWorldPosition);
      }
      target.position.copy(desiredWorldPosition);
      target.updateWorldMatrix(false, true);
      const nextTransform = objectTransform(
        target as unknown as import("three").Object3D,
      );
      setGraph((current) => commitNodeTransform(current, node.id, nextTransform));
    }
    handleStoreRef.current?.save();
    handoffPendingRef.current = false;
    handoffActiveRef.current = true;
    handoffMovedRef.current = false;
    breakawayTriggeredRef.current = false;
    initialGrabberDistanceRef.current = null;
    handoffWorldDeltaRef.current.set(0, 0, 0);
    grabbedObjectRef.current = null;
  }, [hinge, node.id, setGraph]);
  const applyHinge = React.useCallback(
    (state: HandleState<unknown>, target: import("three").Object3D) => {
      if (hinge == null) {
        applyDampedHandleState(state, target);
        return;
      }
      applyDampedHandleState(state, target);
      if (consumeOneHandScaleEnd(target)) initialGrabberDistanceRef.current = null;
      const object = target as unknown as THREE.Object3D;
      object.position.set(...hinge.parentPivot);
      // The pinch scale rides on the hinge frame, which scales the panel and its child offset by
      // the same factor — the pivoted edge stays put — and is folded into the graph on release.
      object.scale.setScalar(state.current.scale.x);
      const angle = THREE.MathUtils.clamp(
        object.rotation[hinge.axis],
        hinge.limits[0],
        hinge.limits[1],
      );
      object.rotation.set(0, 0, 0);
      object.rotation[hinge.axis] = angle;

      const event = state.event;
      // A resize always travels away from the hinge — two hands because the grab points separate,
      // one hand because the grab point's radius *is* the scale — so neither can be a pull. A
      // direct grab therefore detaches from the context toolbar rather than by pulling; a laser
      // keeps pull-to-detach because it never resizes.
      const resizing = state.current.pointerAmount >= 2 ||
        (event != null &&
          event.pointerPosition.distanceTo(event.point) <= oneHandScaleMaxGrabOffset);
      if (event != null && !breakawayTriggeredRef.current && !resizing) {
        const isDesktopMouse = isDesktopMousePointerType(event.pointerType);
        object.updateWorldMatrix(true, false);
        const hingeWorldPosition = hingeWorldPositionRef.current.setFromMatrixPosition(
          object.matrixWorld,
        );
        let distance: number;
        let slack: number;
        if (isDesktopMouse) {
          const hingeScreenPosition = hingeScreenPositionRef.current
            .copy(hingeWorldPosition)
            .project(camera as unknown as THREE.Camera);
          const hingeX = (hingeScreenPosition.x + 1) * 0.5 * canvasSize.width;
          const hingeY = (1 - hingeScreenPosition.y) * 0.5 * canvasSize.height;
          distance = Math.hypot(event.clientX - hingeX, event.clientY - hingeY);
          slack = DESKTOP_HINGE_BREAKAWAY_SLACK_PIXELS;
        } else {
          // The captured pointer's `point` is the frozen-length arm point (`origin + direction *
          // grab distance`), so this measures how far the arm has been pulled off the hinge — not
          // the controller's distance, which changes with every rotation of a stationary hand.
          distance = hingeWorldPosition.distanceTo(event.point as unknown as THREE.Vector3);
          slack = VR_HINGE_BREAKAWAY_SLACK_METERS;
        }
        if (state.first || initialGrabberDistanceRef.current == null) {
          initialGrabberDistanceRef.current = distance;
          // `state.current.time` is the pointerdown `timeStamp` on the first apply and frame seconds
          // afterwards, so it cannot serve as a clock.
          breakawaySettleUntilRef.current = performance.now() +
            HINGE_BREAKAWAY_SETTLE_SECONDS * 1000;
          breakawayHoldRef.current = 0;
          const grabbedObject = event.object as unknown as THREE.Object3D;
          grabbedObject.updateWorldMatrix(true, false);
          grabbedObjectRef.current = grabbedObject;
          localGrabPointRef.current
            .copy(event.point as unknown as THREE.Vector3)
            .applyMatrix4(new THREE.Matrix4().copy(grabbedObject.matrixWorld).invert());
        } else if (performance.now() < breakawaySettleUntilRef.current) {
          // The baseline is captured from the pointer-down intersection, but the frames that follow
          // read the *captured* arm point, which sits a whole grab-distance off the hand and swings
          // with the hand's orientation. Let those agree before trusting the baseline, so a grab
          // made while the hand is still moving cannot read as an instant pull.
          initialGrabberDistanceRef.current = distance;
          breakawayHoldRef.current = 0;
        } else {
          // A real pull persists; one frame of tracking jitter does not.
          breakawayHoldRef.current = distance > initialGrabberDistanceRef.current + slack
            ? breakawayHoldRef.current + 1
            : 0;
          if (breakawayHoldRef.current >= HINGE_BREAKAWAY_HOLD_FRAMES) {
            breakawayTriggeredRef.current = true;
            handoffPendingRef.current = true;
            const grabbedObject = grabbedObjectRef.current;
            const currentGrabPoint = currentGrabWorldPositionRef.current;
            if (grabbedObject == null) {
              currentGrabPoint.copy(event.point as unknown as THREE.Vector3);
            } else {
              grabbedObject.updateWorldMatrix(true, false);
              currentGrabPoint
                .copy(localGrabPointRef.current)
                .applyMatrix4(grabbedObject.matrixWorld);
            }
            const desiredGrabPoint = handoffWorldPositionRef.current;
            if (isDesktopMouse) {
              const projectedDepth = new THREE.Vector3()
                .copy(currentGrabPoint)
                .project(camera as unknown as THREE.Camera)
                .z;
              desiredGrabPoint.set(
                event.clientX / canvasSize.width * 2 - 1,
                1 - event.clientY / canvasSize.height * 2,
                projectedDepth,
              ).unproject(camera as unknown as THREE.Camera);
            } else {
              desiredGrabPoint.copy(event.point as unknown as THREE.Vector3);
            }
            handoffWorldDeltaRef.current.subVectors(
              desiredGrabPoint,
              currentGrabPoint,
            );
            setGraph((current) =>
              releaseHinge(
                setHingeAngle(current, node.id, angle),
                node.id,
              )
            );
            return;
          }
        }
      }

      if (state.last && !breakawayTriggeredRef.current) {
        // The live scale is relative to the frame the grab started on; the graph owns the absolute.
        const scale = node.localTransform.scale[0] * state.current.scale.x /
          (state.initial.scale.x || 1);
        frameScaleResetRef.current = true;
        setGraph((current) => commitHingePose(current, node.id, angle, scale));
      }
      if (state.last) {
        initialGrabberDistanceRef.current = null;
        breakawayTriggeredRef.current = false;
        breakawayHoldRef.current = 0;
        breakawaySettleUntilRef.current = 0;
      }
    },
    [
      camera,
      canvasSize.height,
      canvasSize.width,
      hinge,
      node,
      node.id,
      oneHandScaleMaxGrabOffset,
      setGraph,
    ],
  );
  const hingeOptions = React.useMemo<Omit<HandleOptions<unknown>, "filter">>(
    () => ({
      apply: applyHinge,
      // A second hand joins to pinch-resize; the rotation still comes from the first pointer.
      multitouch: true,
      rotate: hinge?.axis ?? true,
      scale: { uniform: true },
      // One hand can resize with the hinge as the second hand (radius to the pivot drives the
      // scale), but only for a direct grab: a laser's grab point is an arm away from the hand.
      translate: "as-rotate-and-scale",
      oneHandScaleMaxGrabOffset,
      // Drive the hinge from the pointer's captured grab point (a fixed-length arm off the
      // controller), not from its ray. Re-projecting the ray onto the constraint turns every
      // millimetre of hand rotation into a metre of arc on the interaction plane, which reads as
      // random motion and trips breakaway. A frozen point is the same interaction as a hand grab.
      projectRays: false,
    }),
    [applyHinge, hinge?.axis, oneHandScaleMaxGrabOffset],
  );
  const applyFree = React.useCallback(
    (state: HandleState<unknown>, target: import("three").Object3D) => {
      // `save()` rebases the live store but its previous output state remains
      // hinge-shaped until the next move. Avoid replaying that stale state if
      // the pointer is released immediately after breakaway.
      if (!(state.last && handoffActiveRef.current && !handoffMovedRef.current)) {
        applyDampedHandleState(state, target);
      }
      if (!state.last && handoffActiveRef.current) {
        handoffMovedRef.current = true;
      }
      if (!state.last) return;

      const nextTransform = objectTransform(target);
      setGraph((current) => commitSpatialNodeTransformAndSnap(current, node.id, nextTransform));
      handoffActiveRef.current = false;
      handoffMovedRef.current = false;
    },
    [node.id, node.kind, setGraph],
  );
  const freeOptions = React.useMemo<Omit<HandleOptions<unknown>, "filter">>(
    // Same frozen-point model as the hinge so the post-breakaway grab does not inherit the ray
    // projection the hinge just dropped.
    () => freeGrabOptions({ apply: applyFree, projectRays: false }),
    [applyFree],
  );
  const hingeRotation: [number, number, number] = hinge == null
    ? [0, 0, 0]
    : hinge.axis === "x"
    ? [hinge.angle, 0, 0]
    : hinge.axis === "y"
    ? [0, hinge.angle, 0]
    : [0, 0, hinge.angle];
  const targetTransform = hinge == null ? node.localTransform : {
    position: hinge.parentPivot,
    rotation: hingeRotation,
    scale: [1, 1, 1] as [number, number, number],
  };
  const childOffset: [number, number, number] = hinge == null
    ? [0, 0, 0]
    : [-hinge.childPivot[0], -hinge.childPivot[1], -hinge.childPivot[2]];

  return (
    <group
      ref={targetRef}
      position={targetTransform.position}
      rotation={targetTransform.rotation}
      scale={targetTransform.scale}
      userData={{ spatialConstraint: hinge?.kind ?? null, childId: node.id }}
    >
      <group position={childOffset}>
        <SpatialNodeView
          {...props}
          localTransformOverride={hinge == null ? IDENTITY_SPATIAL_TRANSFORM : node.localTransform}
          manipulationTargetRef={targetRef}
          manipulationOptions={hinge == null ? freeOptions : hingeOptions}
          manipulationStoreRef={handleStoreRef}
        />
      </group>
    </group>
  );
}

function SpatialControlView({
  node,
  setGraph,
}: {
  node: ControlSpatialNode;
  setGraph: React.Dispatch<React.SetStateAction<SpatialGraph>>;
}) {
  const activate = (event: PenPointerEvent) => {
    event.stopPropagation();
    setGraph((current) => {
      switch (node.action) {
        case "spawn-display":
          return spawnHingedDisplay(current, node.targetId);
        case "release-hinge":
          return releaseHinge(current, node.targetId);
        case "detach":
          return detachFromParent(current, node.targetId);
      }
    });
  };
  const local = node.localTransform;
  const color = node.action === "spawn-display"
    ? 0x1698b5
    : node.action === "release-hinge"
    ? 0xe3a44b
    : 0xd16372;
  return (
    <group
      position={local.position}
      rotation={local.rotation}
      scale={local.scale}
      userData={{
        spatialElement: true,
        spatialElementId: node.id,
        attachmentParentId: node.parentId,
        normalGrabEnabled: false,
        action: node.action,
        targetId: node.targetId,
      }}
      {...({ pointerEventsType: { deny: "grab" } } as Record<string, unknown>)}
    >
      <GrabBox
        width={0.11}
        height={0.11}
        depth={0.035}
        lineColor={color}
        interactionHull={false}
        grabbable={false}
      >
        <mesh onClick={penHandler(activate)}>
          <boxGeometry args={[0.11, 0.11, 0.035]} />
          <meshBasicNodeMaterial colorNode={TSL.color(color)} />
        </mesh>
        <SpatialControlGlyph action={node.action} />
      </GrabBox>
    </group>
  );
}

function SpatialControlGlyph({ action }: { action: ControlSpatialNode["action"] }) {
  const noPointers = { pointerEvents: "none" } as Record<string, unknown>;
  if (action === "detach") {
    return (
      <>
        <mesh position={[-0.025, 0, 0.02]} {...noPointers}>
          <boxGeometry args={[0.027, 0.055, 0.008]} />
          <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
        </mesh>
        <mesh position={[0.025, 0, 0.02]} {...noPointers}>
          <boxGeometry args={[0.027, 0.055, 0.008]} />
          <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
        </mesh>
      </>
    );
  }
  return (
    <>
      <mesh position={[0, 0, 0.02]} {...noPointers}>
        <boxGeometry args={[0.06, 0.012, 0.008]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
      </mesh>
      <mesh
        position={[0, 0, 0.02]}
        rotation={[0, 0, action === "spawn-display" ? 0 : 0.7]}
        {...noPointers}
      >
        <boxGeometry args={[0.012, 0.06, 0.008]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
      </mesh>
    </>
  );
}

export function WebXRScene(
  {
    XROrigin: _XROrigin,
    displayOverlayHostActor = null,
    directOpenVrInputSource,
  }: WebXRSceneProps,
) {
  void _XROrigin;
  const displayMouseSink = React.useMemo(
    () =>
      Deno.build.os === "linux" && displayOverlayHostActor
        ? createLinuxMouseSink(displayOverlayHostActor)
        : windowsSystemDisplayMouseSink,
    [displayOverlayHostActor],
  );
  const keyboardSink = React.useMemo(
    () =>
      Deno.build.os === "linux" && displayOverlayHostActor
        ? createLinuxKeyboardSink(displayOverlayHostActor)
        : windowsSystemKeyboardSink,
    [displayOverlayHostActor],
  );

  React.useEffect(() => {
    const receiver = startXsoNotificationReceiver();
    return receiver.close;
  }, []);

  React.useEffect(() => {
    const follow = new AbortController();
    startMediaFollow(follow.signal);
    startDesktopNotificationFollow(follow.signal);
    return () => follow.abort();
  }, []);

  return (
    <>
      <color attach="background" args={[0x091018]} />
      <fog attach="fog" args={["#091018", 4, 10]} />
      <ambientLight intensity={0.8} />
      <directionalLight intensity={2.8} position={[2, 3, 2]} />
      <pointLight intensity={8} position={[0, 1.9, -1.25]} color="#ffb347" />
      {/* <XROrigin /> */}

      <VrcCameraCalibrationBall />
      {SHOW_VRC_CAMERA_DEBUG && <VrcCameraDebugVisuals />}

      <WindowLayer
        displayOverlayHostActor={displayOverlayHostActor}
        onMouse={displayMouseSink}
        onKey={keyboardSink}
        directOpenVrInputSource={directOpenVrInputSource}
      />
      <ToastOverlay />
    </>
  );
}
