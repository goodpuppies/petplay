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
import { updateShadowSceneMesh } from "../webxrShadowScene.ts";
import { readVrcCameraDebugSnapshot } from "../vrcCameraDebugState.ts";
import { BoxLineGeometry } from "three/addons/geometries/BoxLineGeometry.js";
import { DisplayInstance } from "./displayInstance/logic.tsx";
import {
  DEFAULT_DISPLAY_DEPTH,
  DEFAULT_DISPLAY_HEIGHT,
  DISPLAY_ASPECT_WIDTH_OVER_HEIGHT,
} from "./displayInstance/ui.tsx";
import {
  createSmoothedDisplayMouseSink,
  windowsSystemDisplayMouseSink,
} from "./displayInstance/mouse.ts";
import type { DisplayMouseLogicEvent, DisplayMouseSink } from "./displayInstance/mouse.ts";
import { KeyboardPanel, windowsSystemKeyboardSink } from "./keyboard/keyboard.tsx";
import type { KeyboardLogicEvent, KeyboardSink } from "./keyboard/types.ts";
import { PostMan } from "../../submodules/stageforge/mod.ts";
import { SpatialAudioProvider } from "./spatialAudio.tsx";
import { getPointerById } from "../../submodules/threewebxrwebgpudeno/submodules/xr/packages/pointer-events/src/pointer.ts";
import type { PointerEvent as PenPointerEvent } from "@pmndrs/pointer-events";
import {
  defaultApply,
  type HandleOptions,
  type HandleState,
  type HandleStore,
} from "@pmndrs/handle";
import { useWindowLayerVisible } from "./windowLayerMode.ts";
import { GrabBox } from "./grabbox.tsx";
import {
  assignWorkspaceOutput,
  commitNodeTransform,
  commitSpatialNodeTransformAndSnap,
  type ControlSpatialNode,
  createInitialSpatialGraph,
  deleteSpatialNode,
  detachDisplayHierarchy,
  detachFromParent,
  type DisplaySpatialNode,
  getDisplayAttachmentRole,
  getSpatialChildren,
  hasAvailableDisplayAttachmentSlot,
  type HingeConstraint,
  IDENTITY_SPATIAL_TRANSFORM,
  initializeWorkspaceLayoutOutputs,
  type KeyboardSpatialNode,
  reconcileWorkspaceOutputs,
  releaseHinge,
  resetSpatialNodeTransform,
  setHingeAngle,
  type SpatialGraph,
  type SpatialNode,
  type SpatialTransform,
  spawnDisplayForWorkspaceOutput,
  spawnHingedDisplay,
  spawnHingedDisplayWithAutomaticOutput,
  updateSnapSourceSize,
} from "./spatialGraph.ts";
import { loadKdeWorkspaceOutputs, type WorkspaceOutput } from "./workspaceDisplays.ts";
import { publishWorkspaceLayout, registerWorkspaceLayoutActions } from "./workspaceLayoutStore.ts";
import {
  loadSpatialLayoutSync,
  saveSpatialLayoutSync,
  spatialLayoutPersistenceEnabled,
} from "./spatialLayoutPersistence.ts";
import { isDesktopMousePointerType } from "./spatialPointer.ts";
import type { DirectOpenVrInputSource } from "../directOpenVrInputSource.ts";
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

function RoomWireBox({ color }: { color: THREE.Color }) {
  const geometry = React.useMemo(
    () => new BoxLineGeometry(6, 6, 6, 10, 10, 10).translate(0, 3, 0),
    [],
  );

  React.useEffect(() => {
    return () => geometry.dispose();
  }, [geometry]);

  return (
    <lineSegments geometry={geometry as unknown as THREE.BufferGeometry}>
      <lineBasicMaterial color={color} />
    </lineSegments>
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
const HANDLE_POSITION_DAMPENING = 41;
const HANDLE_ROTATION_DAMPENING = 61;

function applyDampedHandleState(
  state: HandleState<unknown>,
  target: import("three").Object3D,
): void {
  const dt = Math.max(0, Math.min(0.1, state.delta?.time ?? 1 / 72));
  const positionAlpha = Math.min(1, dt * HANDLE_POSITION_DAMPENING);
  const rotationAlpha = Math.min(1, dt * HANDLE_ROTATION_DAMPENING);
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
      let closestDistanceSq = Number.POSITIVE_INFINITY;
      for (const store of handleStores.values()) {
        for (const [pointerId, pointer] of store.inputState) {
          const dx = pointer.pointerWorldOrigin.x - origin.x;
          const dy = pointer.pointerWorldOrigin.y - origin.y;
          const dz = pointer.pointerWorldOrigin.z - origin.z;
          const distanceSq = dx * dx + dy * dy + dz * dz;
          if (distanceSq < closestDistanceSq) {
            closestDistanceSq = distanceSq;
            closestStore = store;
            closestPointerId = pointerId;
          }
        }
      }
      if (closestStore != null && closestPointerId != null && closestDistanceSq <= 0.25 * 0.25) {
        if (axis !== 0) {
          const step = axis * JOYSTICK_PUSH_PULL_METERS_PER_SECOND * delta;
          closestStore.translateAlongPointerRay(closestPointerId, step);
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
    if (!hit?.uv || !pointedId) return;
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
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>("display-1");
  const handleStores = React.useMemo(() => new Map<string, HandleStore<unknown>>(), []);
  const [workspaceOutputs, setWorkspaceOutputs] = React.useState<
    Awaited<ReturnType<typeof loadKdeWorkspaceOutputs>>
  >([]);
  const [persistenceReady, setPersistenceReady] = React.useState(Deno.build.os !== "linux");
  const workspaceOutputsInitialized = React.useRef(false);
  const layoutPositionInitialized = React.useRef(layoutBootstrap.restored);

  React.useEffect(() => {
    let cancelled = false;
    void loadKdeWorkspaceOutputs().then((outputs) => {
      if (!cancelled) setWorkspaceOutputs(outputs);
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
    });
  }, [graph, workspaceOutputs]);

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
    }), [workspaceOutputs]);

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

  if (!visible) return null;

  return (
    <group userData={{ spatialGraphRoot: true, originId: "scene-origin", static: true }}>
      <CommonOverlayChords
        inputSource={directOpenVrInputSource}
        graph={graph}
        handleStores={handleStores}
        onMouse={onMouse}
      />
      <SpatialAudioProvider>
        {getSpatialChildren(graph, null).map((node) => (
          <SpatialNodeView
            key={node.id}
            node={node}
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
        ))}
      </SpatialAudioProvider>
    </group>
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

const VR_HINGE_BREAKAWAY_SLACK_METERS = 0.22;
const DESKTOP_HINGE_BREAKAWAY_SLACK_PIXELS = 180;
const DELETE_ARM_SIZE_METERS = 0.1;
const DELETE_DISARM_SIZE_METERS = 0.13;
const DISPLAY_GRAB_SIZE: [number, number, number] = [
  DEFAULT_DISPLAY_HEIGHT * DISPLAY_ASPECT_WIDTH_OVER_HEIGHT,
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
  const local = localTransformOverride ?? node.localTransform;

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
    () => ({ ...(manipulationOptions ?? { apply: commitFreeTransform }), alwaysUpdate: true }),
    [commitFreeTransform, manipulationOptions],
  );
  const deletion = useScaleToDelete(node.id, DISPLAY_GRAB_SIZE, baseOptions, setGraph);
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
      id: "delete",
      label: "Delete",
      tone: "danger",
      run: () => setGraph((current) => deleteSpatialNode(current, node.id)),
    });
    return actions;
  }, [attachmentRole, graph, node.id, node.parentId, setGraph, workspaceOutputs]);
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
        onMouse={activeDisplayOverlayHostActor != null ? croppedMouseSink : undefined}
        mouseButtonForPointer={mouseButtonForPointer}
        rayHitSurface={activeDisplayOverlayHostActor != null}
        shellRayPickable={activeDisplayOverlayHostActor == null}
        manipulationTargetRef={targetRef}
        manipulationOptions={deletion.options}
        manipulationStoreRef={setManipulationStore}
        onSpatialFocus={selectNode}
        onSpatialHoverChange={setHovered}
      >
        <SpatialHierarchyIndicator
          role={attachmentRole ?? "solo"}
          position={[0, DEFAULT_DISPLAY_HEIGHT * 0.5 + 0.055, DEFAULT_DISPLAY_DEPTH]}
          visible={hovered && attachmentRole != null}
        />
        {selectedNodeId === node.id && (
          <SpatialContextToolbar
            title={node.workspaceOutputName ?? `Display ${node.ordinal}`}
            position={[0, -DEFAULT_DISPLAY_HEIGHT * 0.5 - 0.085, DEFAULT_DISPLAY_DEPTH]}
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
                <SpatialSettingsSection
                  label={assignedSide == null
                    ? "Free spatial element"
                    : `Attached: ${assignedSide}`}
                >
                  <SpatialSettingsButton
                    label="Reset pose"
                    onClick={() =>
                      setGraph((current) => resetSpatialNodeTransform(current, node.id))}
                  />
                </SpatialSettingsSection>
              </>
            }
          />
        )}
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
    () => ({ ...(manipulationOptions ?? { apply: commitFreeTransform }), alwaysUpdate: true }),
    [commitFreeTransform, manipulationOptions],
  );
  const deletion = useScaleToDelete(node.id, node.snapSource.size, baseOptions, setGraph);
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
      id: "delete",
      label: "Delete",
      tone: "danger",
      run: () => setGraph((current) => deleteSpatialNode(current, node.id)),
    });
    return actions;
  }, [node.id, node.parentId, setGraph]);

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
        manipulationOptions={deletion.options}
        manipulationStoreRef={setManipulationStore}
        onGrabBoxSize={updateBounds}
        onSpatialFocus={selectNode}
      >
        {selectedNodeId === node.id && (
          <SpatialContextToolbar
            title="Keyboard"
            position={[0, -node.snapSource.size[1] * 0.5 - 0.085, node.snapSource.size[2]]}
            actions={contextActions}
          />
        )}
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
  const camera = useThree((state) => state.camera);
  const canvasSize = useThree((state) => state.size);
  const targetRef = React.useRef<THREE.Group>(null);
  const handleStoreRef = React.useRef<HandleStore<unknown>>(null);
  const handoffPendingRef = React.useRef(false);
  const handoffActiveRef = React.useRef(false);
  const handoffMovedRef = React.useRef(false);
  const initialGrabberDistanceRef = React.useRef<number | null>(null);
  const breakawayTriggeredRef = React.useRef(false);
  const hingeWorldPositionRef = React.useRef(new THREE.Vector3());
  const hingeScreenPositionRef = React.useRef(new THREE.Vector3());
  const handoffWorldDeltaRef = React.useRef(new THREE.Vector3());
  const handoffWorldPositionRef = React.useRef(new THREE.Vector3());
  const currentGrabWorldPositionRef = React.useRef(new THREE.Vector3());
  const grabbedObjectRef = React.useRef<THREE.Object3D | null>(null);
  const localGrabPointRef = React.useRef(new THREE.Vector3());
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
      const object = target as unknown as THREE.Object3D;
      object.position.set(...hinge.parentPivot);
      object.scale.set(1, 1, 1);
      const angle = THREE.MathUtils.clamp(
        object.rotation[hinge.axis],
        hinge.limits[0],
        hinge.limits[1],
      );
      object.rotation.set(0, 0, 0);
      object.rotation[hinge.axis] = angle;

      const event = state.event;
      if (event != null && !breakawayTriggeredRef.current) {
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
          distance = hingeWorldPosition.distanceTo(
            event.pointerPosition as unknown as THREE.Vector3,
          );
          slack = VR_HINGE_BREAKAWAY_SLACK_METERS;
        }
        if (state.first || initialGrabberDistanceRef.current == null) {
          initialGrabberDistanceRef.current = distance;
          const grabbedObject = event.object as unknown as THREE.Object3D;
          grabbedObject.updateWorldMatrix(true, false);
          grabbedObjectRef.current = grabbedObject;
          localGrabPointRef.current
            .copy(event.point as unknown as THREE.Vector3)
            .applyMatrix4(new THREE.Matrix4().copy(grabbedObject.matrixWorld).invert());
        } else {
          if (distance > initialGrabberDistanceRef.current + slack) {
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
              desiredGrabPoint.copy(
                event.pointerPosition as unknown as THREE.Vector3,
              );
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
        setGraph((current) => setHingeAngle(current, node.id, angle));
      }
      if (state.last) {
        initialGrabberDistanceRef.current = null;
        breakawayTriggeredRef.current = false;
      }
    },
    [camera, canvasSize.height, canvasSize.width, hinge, node.id, setGraph],
  );
  const hingeOptions = React.useMemo<Omit<HandleOptions<unknown>, "filter">>(
    () => ({
      apply: applyHinge,
      multitouch: false,
      rotate: hinge?.axis ?? true,
      scale: false,
      translate: "as-rotate",
    }),
    [applyHinge, hinge?.axis],
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
    () => ({ apply: applyFree }),
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
        <mesh onClick={activate}>
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
  const accentRef = useRef<THREE.Mesh>(null!);
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

  // R3F v10: keep mesh animation on the default `update` phase. Memoize options
  // so the scheduler job is not re-registered every React render.
  const accentFrameOpts = React.useMemo<UseFrameNextOptions>(
    () => ({ id: "petplay-accent-torus" }),
    [],
  );
  useFrame((_state, delta) => {
    accentRef.current.rotation.y += delta * 0.25;
  }, accentFrameOpts);

  // Ghost overlay snapshot for Raylib: not needed at HMD rate; `finish` runs after uikit/keyboard
  // update jobs, and 60Hz is plenty for a slow torus + shadow mesh mirror.
  const shadowMirrorOpts = React.useMemo<UseFrameNextOptions>(
    () => ({
      id: "petplay-raylib-torus-shadow",
      phase: "finish",
      fps: 60,
      drop: true,
    }),
    [],
  );
  // Static parts of the mirror description are hoisted: the job runs at 60Hz and
  // `updateShadowSceneMesh` now copies these arrays element-wise instead of retaining them.
  const shadowMirrorScratch = React.useMemo(
    () => ({
      kind: "torus" as const,
      position: [0, 1.45, -1.8] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
      color: [255, 139, 61, 255] as [number, number, number, number],
      wireColor: [255, 196, 148, 255] as [number, number, number, number],
    }),
    [],
  );
  useFrame(() => {
    shadowMirrorScratch.rotation[1] = accentRef.current.rotation.y;
    updateShadowSceneMesh(0, shadowMirrorScratch);
  }, shadowMirrorOpts);

  const roomLineColor = React.useMemo(() => new THREE.Color(0xbcbcbc), []);

  return (
    <>
      <color attach="background" args={[0x091018]} />
      <fog attach="fog" args={["#091018", 4, 10]} />
      <ambientLight intensity={0.8} />
      <directionalLight intensity={2.8} position={[2, 3, 2]} />
      <pointLight intensity={8} position={[0, 1.9, -1.25]} color="#ffb347" />
      {/* <XROrigin /> */}

      <mesh ref={accentRef} position={[0, 1.45, -1.8]}>
        <torusGeometry args={[0.12, 0.012, 16, 48]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xff8b3d)} />
      </mesh>
      <VrcCameraDebugVisuals />
      {/* <RoomWireBox color={roomLineColor} /> */}

      <WindowLayer
        displayOverlayHostActor={displayOverlayHostActor}
        onMouse={displayMouseSink}
        onKey={keyboardSink}
        directOpenVrInputSource={directOpenVrInputSource}
      />
    </>
  );
}
