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
import { getVrcCameraDebugSnapshot } from "../vrcCameraDebugState.ts";
import { BoxLineGeometry } from "three/addons/geometries/BoxLineGeometry.js";
import { DisplayInstance } from "./displayInstance/logic.tsx";
import { windowsSystemDisplayMouseSink } from "./displayInstance/mouse.ts";
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
  commitNodeTransform,
  type ControlSpatialNode,
  createInitialSpatialGraph,
  detachFromParent,
  type DisplaySpatialNode,
  getSpatialChildren,
  type HingeConstraint,
  IDENTITY_SPATIAL_TRANSFORM,
  type KeyboardSpatialNode,
  releaseHinge,
  setHingeAngle,
  snapNodeToOverlappingHitbox,
  type SpatialGraph,
  type SpatialNode,
  type SpatialTransform,
  spawnHingedDisplay,
  updateSnapSourceSize,
} from "./spatialGraph.ts";
import { SpatialBoxHitbox } from "./spatialHitbox.tsx";
import { isDesktopMousePointerType } from "./spatialPointer.ts";

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
  displayInstanceActor?: string | null;
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
  return (event: DisplayMouseLogicEvent) => {
    postInputControl(actor, `M,${event.x},${event.y}`);
    if (event.kind === "button") {
      postInputControl(actor, `B,${event.button},${event.pressed ? 1 : 0}`);
    }
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
    const snapshot = getVrcCameraDebugSnapshot();
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

function WindowLayer({
  displayInstanceActor,
  onMouse,
  onKey,
}: {
  displayInstanceActor: string | null;
  onMouse: DisplayMouseSink;
  onKey: KeyboardSink;
}) {
  const visible = useWindowLayerVisible();
  const camera = useThree((r3fState) => r3fState.camera);
  const position = React.useMemo(() => new THREE.Vector3(), []);
  const quaternion = React.useMemo(() => new THREE.Quaternion(), []);
  const [graph, setGraph] = React.useState(createInitialSpatialGraph);

  if (!visible) return null;

  camera.updateWorldMatrix(true, false);
  camera.getWorldPosition(position);
  camera.getWorldQuaternion(quaternion);
  position.add(new THREE.Vector3(0, -0.08, -1.35).applyQuaternion(quaternion));

  return (
    <group
      position={position}
      quaternion={quaternion}
      userData={{ spatialGraphRoot: true, originId: "scene-origin" }}
    >
      <SpatialAudioProvider>
        {getSpatialChildren(graph, null).map((node) => (
          <SpatialNodeView
            key={node.id}
            node={node}
            graph={graph}
            setGraph={setGraph}
            displayInstanceActor={displayInstanceActor}
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
  displayInstanceActor: string | null;
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

function objectTransform(target: import("three").Object3D): SpatialTransform {
  const object = target as unknown as THREE.Object3D;
  return {
    position: object.position.toArray() as [number, number, number],
    rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
    scale: object.scale.toArray() as [number, number, number],
  };
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
  displayInstanceActor,
  onMouse,
  onKey,
  manipulationTargetRef,
  manipulationOptions,
  manipulationStoreRef,
  localTransformOverride,
}: SpatialNodeViewProps & { node: DisplaySpatialNode }) {
  const nodeRef = React.useRef<THREE.Group>(null);
  const local = localTransformOverride ?? node.localTransform;

  const commitFreeTransform = React.useCallback(
    (state: HandleState<unknown>, target: import("three").Object3D) => {
      defaultApply(state, target);
      if (state.last) {
        const nextTransform = objectTransform(target);
        setGraph((current) => commitNodeTransform(current, node.id, nextTransform));
      }
    },
    [node.id, setGraph],
  );
  const targetRef = manipulationTargetRef ?? nodeRef;
  const options = manipulationOptions ?? { apply: commitFreeTransform };
  const children = getSpatialChildren(graph, node.id);
  const isPrimaryCapture = node.ordinal === 1;

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
      <DisplayInstance
        displayInstanceActor={isPrimaryCapture ? displayInstanceActor : null}
        onMouse={isPrimaryCapture && displayInstanceActor != null ? onMouse : undefined}
        rayHitSurface={isPrimaryCapture && displayInstanceActor != null}
        shellRayPickable={!isPrimaryCapture || displayInstanceActor == null}
        manipulationTargetRef={targetRef}
        manipulationOptions={options}
        manipulationStoreRef={manipulationStoreRef}
      />
      <SpatialHitboxesView nodeId={node.id} graph={graph} />
      {children.map((child) => (
        <SpatialAttachmentView
          key={child.id}
          node={child}
          graph={graph}
          setGraph={setGraph}
          displayInstanceActor={displayInstanceActor}
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
  displayInstanceActor,
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
      defaultApply(state, target);
      if (state.last) {
        const nextTransform = objectTransform(target);
        setGraph((current) => {
          const moved = commitNodeTransform(current, node.id, nextTransform);
          return snapNodeToOverlappingHitbox(moved, node.id);
        });
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
  const options = manipulationOptions ?? { apply: commitFreeTransform };
  const children = getSpatialChildren(graph, node.id);

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
      <KeyboardPanel
        position={[0, 0, 0]}
        rotation={[0, 0, 0]}
        scale={[1, 1, 1]}
        onKey={onKey}
        manipulationTargetRef={targetRef}
        manipulationOptions={options}
        manipulationStoreRef={manipulationStoreRef}
        onGrabBoxSize={updateBounds}
      />
      {children.map((child) => (
        <SpatialAttachmentView
          key={child.id}
          node={child}
          graph={graph}
          setGraph={setGraph}
          displayInstanceActor={displayInstanceActor}
          onMouse={onMouse}
          onKey={onKey}
        />
      ))}
    </group>
  );
}

function SpatialHitboxesView({ nodeId, graph }: { nodeId: string; graph: SpatialGraph }) {
  return Object.values(graph.hitboxes)
    .filter((hitbox) => hitbox.ownerId === nodeId)
    .map((hitbox) => (
      <group
        key={hitbox.id}
        position={hitbox.localTransform.position}
        rotation={hitbox.localTransform.rotation}
        scale={hitbox.localTransform.scale}
      >
        <SpatialBoxHitbox id={hitbox.id} size={hitbox.size} />
      </group>
    ));
}

function SpatialAttachmentView(props: SpatialNodeViewProps) {
  const { node } = props;
  if (node.kind === "control") {
    return <SpatialNodeView {...props} />;
  }
  return <AttachedSpatialNodeView {...props} node={node} />;
}

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
        defaultApply(state, target);
        return;
      }
      defaultApply(state, target);
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
        defaultApply(state, target);
      }
      if (!state.last && handoffActiveRef.current) {
        handoffMovedRef.current = true;
      }
      if (!state.last) return;

      const nextTransform = objectTransform(target);
      setGraph((current) => {
        const moved = commitNodeTransform(current, node.id, nextTransform);
        return node.kind === "keyboard" ? snapNodeToOverlappingHitbox(moved, node.id) : moved;
      });
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
  { XROrigin: _XROrigin, displayInstanceActor = null }: WebXRSceneProps,
) {
  void _XROrigin;
  const accentRef = useRef<THREE.Mesh>(null!);
  const displayMouseSink = React.useMemo(
    () =>
      Deno.build.os === "linux" && displayInstanceActor
        ? createLinuxMouseSink(displayInstanceActor)
        : windowsSystemDisplayMouseSink,
    [displayInstanceActor],
  );
  const keyboardSink = React.useMemo(
    () =>
      Deno.build.os === "linux" && displayInstanceActor
        ? createLinuxKeyboardSink(displayInstanceActor)
        : windowsSystemKeyboardSink,
    [displayInstanceActor],
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
  useFrame(() => {
    updateShadowSceneMesh(0, {
      kind: "torus",
      position: [0, 1.45, -1.8],
      rotation: [0, accentRef.current.rotation.y, 0],
      scale: [1, 1, 1],
      color: [255, 139, 61, 255],
      wireColor: [255, 196, 148, 255],
    });
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
        displayInstanceActor={displayInstanceActor}
        onMouse={displayMouseSink}
        onKey={keyboardSink}
      />
    </>
  );
}
