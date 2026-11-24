import {
  CombinedPointer as CombinedPointerImpl,
  type Intersection,
  Pointer,
  type RayPointerOptions,
} from "@pmndrs/pointer-events";
import {
  type DefaultXRControllerOptions,
  type DefaultXRInputSourceGrabPointerOptions,
  type DefaultXRInputSourceRayPointerOptions,
  DefaultXRInputSourceTeleportPointer,
  useGrabPointer,
  usePointerXRInputSourceEvents,
  useRayPointer,
  useXRInputSourceStateContext,
  XRControllerModel,
  XRSpace,
} from "@react-three/xr";
import { useFrame } from "@react-three/fiber/webgpu";
import React, {
  forwardRef,
  Suspense,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { type ColorRepresentation, type Mesh, MeshBasicMaterial, Object3D } from "three/webgpu";
import { HandPoker } from "./handPoker.tsx";
import { useControllerLaserEnabled } from "./controllerLaserMode.ts";
import { registerPointerHand } from "./haptics.ts";
import { gameInputBlocking } from "./gameInputBlocking.ts";
import { isHandGrabbing, registerGrabPointerHand } from "./oneHandScale.ts";
import { getHeadObject, registerHandOrigin } from "./trackedOrigins.ts";
import {
  applyLaserOffset,
  clampLaserOffset,
  type LaserHand,
  mirrorLaserOffset,
  poseOffsetOf,
  resetLaserOffset,
  saveLaserOffset,
  setLiveLaserOffset,
} from "./laserOffset.ts";
import { Container } from "../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Pill } from "./ui/primitives.tsx";
import { COLOR, INNER_GAP, RADIUS } from "./ui/tokens.ts";
import { Matrix4, Quaternion, Vector3 } from "three/webgpu";
import { useToolEditMode } from "./toolEditMode.ts";
import { GrabBox } from "./grabbox.tsx";
import { readPointerHandedness } from "./wristMenu/pointerFilter.ts";
import { defaultApply, type HandleState, type HandleStore } from "@pmndrs/handle";
import type { PointerEvent as PenPointerEvent } from "@pmndrs/pointer-events";
// Not re-exported by the package index; the same module instance the XR root provides.
import { combinedPointerContext } from "../../submodules/threewebxrwebgpudeno/submodules/xr/packages/react/xr/src/contexts.tsx";

function spreadable<T>(value: true | T | undefined): T | undefined {
  if (value === true || value === undefined) {
    return undefined;
  }
  return value;
}

type HudRayColor = ColorRepresentation | readonly [number, number, number];

type HudRayModelOptions = {
  renderOrder?: number;
  color?: HudRayColor | ((pointer: Pointer) => HudRayColor);
  opacity?: number | ((pointer: Pointer) => number);
  size?: number;
  /** Only while the pointer holds something (the grab ray's beam). */
  whileCaptured?: boolean;
};

/** Match [ConstantControllerAimBeam](controllerAimBeam.tsx); options can override via `rayPointer.rayModel`. */
const PETPLAY_RAY_DEFAULTS: Pick<
  HudRayModelOptions,
  "size" | "color" | "renderOrder"
> = {
  size: 0.002,
  color: 0x5ec8ff,
  renderOrder: 9999,
};

type AimSegmentObject = {
  visible: boolean;
  position: { z: number };
  scale: { set: (x: number, y: number, z: number) => void };
  updateMatrix: () => void;
};

function updateHudRayModel(
  mesh: AimSegmentObject,
  material: MeshBasicMaterial,
  pointer: Pointer,
  options: HudRayModelOptions,
) {
  if (!pointer.getEnabled() || (options.whileCaptured && pointer.getPointerCapture() == null)) {
    mesh.visible = false;
    return;
  }

  const intersection = pointer.getIntersection();
  // `useRayPointer` only records intersections from pointer-event targets. This
  // therefore means an actual interactable is under the controller ray, rather
  // than merely any visible scene geometry.
  // A miss resolves to the shared void object at distance 1e7. Hide the beam:
  // drawing that literally scales the mesh to 10,000 km, which explodes the
  // raythree extraction matrices and the HUD draw on exactly the laser-off
  // frame. Invisible objects are skipped by traverseVisible, so hiding also
  // removes the spike instead of just shrinking it.
  if (intersection?.object?.isVoidObject === true) {
    mesh.visible = false;
    return;
  }
  const length = intersection?.distance;
  if (length == null || !Number.isFinite(length) || length <= 0) {
    mesh.visible = false;
    return;
  }

  const color = typeof options.color === "function" ? options.color(pointer) : options.color;
  if (Array.isArray(color)) {
    material.color.set(color[0]!, color[1]!, color[2]!);
  } else if (color == null) {
    material.color.set(0xffffff);
  } else {
    material.color.set(color as ColorRepresentation);
  }
  material.opacity = typeof options.opacity === "function"
    ? options.opacity(pointer)
    : (options.opacity ?? 0.4);

  mesh.visible = true;
  mesh.position.z = -length / 2;
  const size = options.size ?? 0.005;
  mesh.scale.set(size, size, length);
  mesh.updateMatrix();
}

const HudPointerRayModel = forwardRef<Object3D, HudRayModelOptions & { pointer: Pointer }>(
  (props, ref) => {
    const material = useMemo(
      () =>
        new MeshBasicMaterial({
          transparent: true,
          toneMapped: false,
          // Depth-tested so UI in front of the laser covers it. The beam stops at what it hits, so
          // it is never behind the screen receiving it. (The raylib renderer writes UI depth for
          // this: see `writeUiDepth`.)
          depthTest: true,
          depthWrite: false,
        }),
      [],
    );
    const internalRef = useRef<Mesh>(null);
    useImperativeHandle(ref, () => internalRef.current!);
    useFrame(() => {
      if (internalRef.current != null) {
        updateHudRayModel(
          internalRef.current as unknown as AimSegmentObject,
          material,
          props.pointer,
          props,
        );
      }
    });
    return (
      <mesh
        matrixAutoUpdate={false}
        renderOrder={props.renderOrder ?? 2}
        ref={internalRef}
        material={material as never}
        userData={{ raythreeHudOverUi: true }}
        {...({ pointerEvents: "none" } as Record<string, unknown>)}
      >
        <boxGeometry />
      </mesh>
    );
  },
);

/** Cursor dot radius in metres at 1 m; it grows with distance so it stays about the same size. */
const CURSOR_RADIUS_PER_METRE = 0.005;
const CURSOR_MIN_RADIUS = 0.003;
/** Pulled back toward the controller so it never z-fights the surface it sits on. */
const CURSOR_SURFACE_GAP = 0.002;

/**
 * A flat dot where the ray hits an interactable. Replaces pmndrs' `PointerCursorModel`, whose
 * shader material the raythree HUD path cannot translate (it drew as a large grey quad). Facing
 * back along the ray rather than along the surface normal keeps it round from where you look.
 */
function HudPointerCursorModel(
  { pointer, color = 0xffffff, renderOrder = 10000 }: {
    pointer: Pointer;
    color?: ColorRepresentation;
    renderOrder?: number;
  },
) {
  const material = useMemo(
    () =>
      new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.9,
        toneMapped: false,
        // Sits just in front of the surface it marks; UI nearer than that covers it.
        depthTest: true,
        depthWrite: false,
      }),
    [color],
  );
  const ref = useRef<Mesh>(null);
  useFrame(() => {
    const mesh = ref.current;
    if (mesh == null) return;
    const intersection = pointer.getEnabled() ? pointer.getIntersection() : undefined;
    const distance = intersection?.distance;
    if (
      intersection == null || intersection.object?.isVoidObject === true ||
      distance == null || !Number.isFinite(distance) || distance <= CURSOR_SURFACE_GAP
    ) {
      mesh.visible = false;
      return;
    }
    const radius = Math.max(CURSOR_MIN_RADIUS, CURSOR_RADIUS_PER_METRE * distance);
    mesh.visible = true;
    mesh.position.set(0, 0, -(distance - CURSOR_SURFACE_GAP));
    mesh.scale.set(radius, radius, radius);
    mesh.updateMatrix();
  });
  return (
    <mesh
      matrixAutoUpdate={false}
      visible={false}
      renderOrder={renderOrder}
      ref={ref}
      material={material as never}
      userData={{ raythreeHudOverUi: true, renderTrackingAnchor: "world" }}
      {...({ pointerEvents: "none" } as Record<string, unknown>)}
    >
      <circleGeometry args={[1, 20]} />
    </mesh>
  );
}

function PetplayDefaultXRInputSourceRayPointer(props: DefaultXRInputSourceRayPointerOptions) {
  const state = useXRInputSourceStateContext();
  const ref = useRef<Object3D>(null);
  const pointer = useRayPointer(ref, state, props);
  usePointerXRInputSourceEvents(pointer, state.inputSource, "select", state.events);
  const handedness = state.inputSource.handedness;
  useEffect(() => {
    if (handedness !== "left" && handedness !== "right") return;
    const unregisterHaptics = registerPointerHand(pointer.id, handedness);
    const unregisterBlocking = gameInputBlocking.register(pointer, handedness);
    return () => {
      unregisterHaptics();
      unregisterBlocking();
    };
  }, [pointer, handedness]);
  // Only the transitions: the root pointer also disables this ray while the session is hidden.
  const quietForGrab = useRef(false);
  useFrame(() => {
    if (handedness !== "left" && handedness !== "right") return;
    const grabbing = isHandGrabbing(handedness);
    if (grabbing === quietForGrab.current) return;
    quietForGrab.current = grabbing;
    pointer.setEnabled(!grabbing, { timeStamp: performance.now() });
  });
  const rayModelOptions = props.rayModel;
  const cursorModelOptions = props.cursorModel;
  const rayOpts = spreadable(rayModelOptions);
  return (
    <XRSpace space="target-ray-space">
      {/* The anchor stays on the tip; the laser's own offset sits inside it. */}
      <group userData={{ renderTrackingAnchor: `${handedness}-ray` }}>
        <LaserOffsetGroup ref={ref} hand={handedness}>
          {rayModelOptions !== false && (
            <HudPointerRayModel
              pointer={pointer}
              {...PETPLAY_RAY_DEFAULTS}
              opacity={1}
              {...rayOpts}
            />
          )}
          {cursorModelOptions !== false && <HudPointerCursorModel pointer={pointer} />}
        </LaserOffsetGroup>
      </group>
    </XRSpace>
  );
}

/** Tells the one-hand resize which hand, and which trigger, a grab pointer belongs to. */
function useRegisterGrabPointer(pointer: Pointer, space: "hand" | "ray"): void {
  const state = useXRInputSourceStateContext();
  const inputSource = state.inputSource;
  useEffect(() => {
    const handedness = inputSource.handedness;
    if (handedness !== "left" && handedness !== "right") return;
    const unregisterGrab = registerGrabPointerHand(pointer, handedness, inputSource, space);
    const unregisterBlocking = gameInputBlocking.register(pointer, handedness);
    return () => {
      unregisterGrab();
      unregisterBlocking();
    };
  }, [pointer, inputSource, space]);
}

/**
 * Squeeze + grip-space sphere, `pointerType: "grab"`. pmndrs' `DefaultXRControllerGrabPointer`
 * with the hand registered and without the cursor, which PetPlay always turned off.
 */
function PetplayGrabSpherePointer(options: DefaultXRInputSourceGrabPointerOptions) {
  const state = useXRInputSourceStateContext();
  const ref = useRef<Object3D>(null);
  const pointer = useGrabPointer(ref, state, options);
  usePointerXRInputSourceEvents(pointer, state.inputSource, "squeeze", state.events);
  useRegisterGrabPointer(pointer, "hand");
  return <XRSpace ref={ref} space="grip-space" />;
}

/** Squeeze + target-ray, `pointerType: "grab"`. Paired with `PetplayGrabSpherePointer` in {@link LaserFirstGrabPointer}. */
function PetplayGrabRayPointer(
  { beam, ...rayOpts }: RayPointerOptions & { beam: boolean },
) {
  const state = useXRInputSourceStateContext();
  const ref = useRef<Object3D>(null);
  const pointer = useRayPointer(ref, state, rayOpts, "grab");
  useEffect(() => {
    laserGrabPointers.add(pointer);
    return () => {
      laserGrabPointers.delete(pointer);
    };
  }, [pointer]);
  usePointerXRInputSourceEvents(pointer, state.inputSource, "squeeze", state.events);
  useRegisterGrabPointer(pointer, "ray");
  const hand = state.inputSource.handedness;
  // While this ray holds something the select ray is off (so the trigger resizes instead of
  // clicking), and its beam with it: this one stands in, from the laser to the grab point.
  return (
    <XRSpace space="target-ray-space">
      <group userData={{ renderTrackingAnchor: `${hand}-ray` }}>
        <LaserOffsetGroup ref={ref} hand={hand}>
          {beam && (
            <HudPointerRayModel
              pointer={pointer}
              {...PETPLAY_RAY_DEFAULTS}
              opacity={1}
              whileCaptured
            />
          )}
        </LaserOffsetGroup>
      </group>
    </XRSpace>
  );
}

function isLaserHand(hand: XRHandedness): hand is LaserHand {
  return hand === "left" || hand === "right";
}

/**
 * A child of target-ray space posed at the hand's laser offset ({@link applyLaserOffset}): the
 * select and grab rays hang from it, so both follow the reposed laser.
 */
const LaserOffsetGroup = forwardRef<Object3D, { hand: XRHandedness; children?: React.ReactNode }>(
  function LaserOffsetGroup({ hand, children }, ref) {
    const groupRef = useRef<Object3D>(null);
    useImperativeHandle(ref, () => groupRef.current!, []);
    useFrame(() => {
      const group = groupRef.current;
      if (group != null && isLaserHand(hand)) applyLaserOffset(group, hand);
    });
    return <group ref={groupRef as never}>{children}</group>;
  },
);

/** Thin across, long along the beam, from a little behind the laser's origin forward. */
const LASER_HANDLE_WIDTH = 0.02;
const LASER_HANDLE_LENGTH = 0.09;
const LASER_HANDLE_BEHIND = 0.02;
/**
 * The keyboard's order (20), which ranks ahead of distance in pointer intersection: at the same
 * order the nearer of the two wins, so aiming at a handle in front of the keyboard grabs the handle.
 */
const LASER_HANDLE_POINTER_EVENTS_ORDER = 20;
const LASER_GUIDE_LENGTH = 0.3;
const LASER_HANDLE_COLOR = 0x5ec8ff;

/**
 * Edit layout mode: a small grab box where the hand's laser starts, with a short guide beam
 * along it. Grabbing it with the other hand moves and turns the laser relative to its controller;
 * letting go saves the pose for this controller model and hand.
 */
function LaserOffsetHandle() {
  const state = useXRInputSourceStateContext();
  const hand = state.inputSource.handedness;
  const editing = useToolEditMode();
  const targetRef = useRef<Object3D>(null);
  const storeRef = useRef<HandleStore<unknown> | null>(null);
  const options = useMemo(() => ({
    scale: false as const,
    multitouch: false,
    apply: (handleState: HandleState<unknown>, target: Object3D) => {
      defaultApply(handleState, target as never);
      if (!isLaserHand(hand)) return;
      // Held back within reach of the controller: the handle stops where the laser would.
      const offset = clampLaserOffset(poseOffsetOf(target as never));
      target.position.fromArray(offset.position);
      if (handleState.last) saveLaserOffset(hand, offset);
      else setLiveLaserOffset(hand, offset);
    },
  }), [hand]);
  // Only the other hand: this one's own grab volumes sit right on its laser's origin.
  const grabFilter = useMemo(
    () => (event: PenPointerEvent) =>
      editing && event.pointerType !== "ray" && event.pointerType !== "poker" &&
      isLaserHand(hand) && readPointerHandedness(event.pointerState) === otherHand(hand),
    [editing, hand],
  );
  const hullFilter = useMemo(
    () => (_pointerId: number, _pointerType: string, pointerState: unknown) =>
      isLaserHand(hand) && readPointerHandedness(pointerState) === otherHand(hand),
    [hand],
  );
  useFrame(() => {
    const target = targetRef.current;
    const grabbing = (storeRef.current?.capturedObjects.size ?? 0) > 0;
    if (target != null && !grabbing && isLaserHand(hand)) applyLaserOffset(target, hand);
  });
  if (!editing || !isLaserHand(hand)) return null;
  return (
    <XRSpace space="target-ray-space">
      <group ref={targetRef as never}>
        <group
          position={[0, 0, LASER_HANDLE_BEHIND - LASER_HANDLE_LENGTH / 2]}
          {...({ pointerEventsOrder: LASER_HANDLE_POINTER_EVENTS_ORDER } as Record<
            string,
            unknown
          >)}
        >
          <GrabBox
            width={LASER_HANDLE_WIDTH}
            height={LASER_HANDLE_WIDTH}
            depth={LASER_HANDLE_LENGTH}
            lineColor={LASER_HANDLE_COLOR}
            // Squeeze-grab only, and invisible to its own hand: that hand's grab sphere sits on it
            // and would otherwise prefer it ({@link NEAR_GRAB_PRIORITY}) over anything else.
            shellRayPickable={false}
            interactionHullFilter={hullFilter}
            manipulationTargetRef={targetRef as never}
            manipulationOptions={options}
            manipulationStoreRef={storeRef}
            grabFilter={grabFilter}
            userData={{ laserOffsetHandle: hand, [NEAR_GRAB_PRIORITY]: true }}
          />
        </group>
        <mesh
          position={[0, 0, -LASER_GUIDE_LENGTH / 2]}
          scale={[0.003, 0.003, LASER_GUIDE_LENGTH]}
          userData={{ raythreeHudOverUi: true }}
          {...({ pointerEvents: "none" } as Record<string, unknown>)}
        >
          <boxGeometry />
          <meshBasicMaterial
            color={LASER_HANDLE_COLOR}
            transparent
            opacity={0.8}
            depthTest={false}
            depthWrite={false}
          />
        </mesh>
        <LaserHandleMenu hand={hand} />
      </group>
    </XRSpace>
  );
}

/** Below the handle, in world metres, so it reads upright however the controller is held. */
const LASER_MENU_DROP = 0.07;
/** Above the keyboard and toolbars (20), like the snap pills. */
const LASER_MENU_POINTER_EVENTS_ORDER = 30;
const WORLD_UP = new Vector3(0, 1, 0);

/**
 * World matrix of an object under an XR space. Composed by hand: XR spaces write `matrix` without
 * flagging `matrixWorldNeedsUpdate`, so `updateWorldMatrix` would return a stale pose.
 */
function freshWorldMatrix(object: Object3D, target: Matrix4): Matrix4 {
  if (object.matrixAutoUpdate) object.updateMatrix();
  target.copy(object.matrix);
  for (let node = object.parent; node != null; node = node.parent) {
    if (node.matrixAutoUpdate) node.updateMatrix();
    target.premultiply(node.matrix);
  }
  return target;
}

/**
 * Under a laser handle in edit layout mode, turned toward the head every frame: copy this laser
 * onto the other hand as its mirror image (once), and put this laser back on the controller tip.
 */
function LaserHandleMenu({ hand }: { hand: LaserHand }) {
  const ref = useRef<Object3D>(null);
  const scratch = useMemo(() => ({
    parent: new Matrix4(),
    world: new Matrix4(),
    position: new Vector3(),
    head: new Vector3(),
    rotation: new Quaternion(),
    unit: new Vector3(1, 1, 1),
  }), []);
  useFrame((state) => {
    const card = ref.current;
    const parent = card?.parent;
    if (card == null || parent == null) return;
    freshWorldMatrix(parent, scratch.parent);
    scratch.position.setFromMatrixPosition(scratch.parent);
    scratch.position.y -= LASER_MENU_DROP;
    const head = getHeadObject(state.gl, state.camera);
    head.updateWorldMatrix(true, false);
    scratch.head.setFromMatrixPosition(head.matrixWorld);
    // +Z, the side uikit draws on, toward the head, with world up kept upright.
    scratch.rotation.setFromRotationMatrix(
      scratch.world.lookAt(scratch.head, scratch.position, WORLD_UP),
    );
    scratch.world.compose(scratch.position, scratch.rotation, scratch.unit);
    // Into the parent's frame, dropping its scale so the card keeps its size.
    scratch.world.premultiply(scratch.parent.invert());
    scratch.world.decompose(card.position, card.quaternion, card.scale);
  });
  return (
    <group
      ref={ref as never}
      name="laser-handle-menu"
      {...({ pointerEventsOrder: LASER_MENU_POINTER_EVENTS_ORDER } as Record<string, unknown>)}
    >
      <Container
        pixelSize={0.001}
        flexDirection="row"
        gap={INNER_GAP}
        padding={INNER_GAP}
        borderRadius={RADIUS.shell}
        backgroundColor={COLOR.ground}
        backgroundOpacity={0.9}
      >
        <Pill slots={2} units={1} fontSize={12} onClick={() => mirrorLaserOffset(hand)}>
          MIRROR
        </Pill>
        <Pill slots={2} units={1} fontSize={12} onClick={() => resetLaserOffset(hand)}>
          RESET
        </Pill>
      </Container>
    </group>
  );
}

function otherHand(hand: LaserHand): LaserHand {
  return hand === "left" ? "right" : "left";
}

/** The grab rays, which {@link LaserFirstGrabPointer} prefers over the grip sphere. */
const laserGrabPointers = new WeakSet<Pointer>();

/** The `CombinedPointer` fields its own choice uses; private in its typings. */
type CombinedPointerInternals = {
  pointers: (Pointer | CombinedPointerImpl)[];
  activePointer: Pointer | CombinedPointerImpl | undefined;
  computeActivePointer: () => void;
};

function realHit(intersection: Intersection | undefined): intersection is Intersection {
  return intersection != null && intersection.object.isVoidObject !== true;
}

/** Marks a grab target the sphere keeps even when the laser points elsewhere (edit handles). */
export const NEAR_GRAB_PRIORITY = "nearGrabPriority";

function prefersNearGrab(object: Object3D): boolean {
  for (let o: Object3D | null = object; o != null; o = o.parent) {
    if (o.userData[NEAR_GRAB_PRIORITY] === true) return true;
  }
  return false;
}

/** The scene node (display, keyboard, wrist menu…) an intersected object belongs to. */
function spatialElementOf(object: Object3D): Object3D | null {
  for (let o: Object3D | null = object; o != null; o = o.parent) {
    if (o.userData.spatialElement === true) return o;
  }
  return null;
}

/**
 * Picks the grab after pmndrs' nearest-hit choice, which always took the grip sphere when in range.
 * What the laser points at wins instead: aiming at a display or the keyboard while the hand is
 * near the wrist menu grabs the display. The sphere keeps it when both reach the same node, so a
 * window in the hand is grabbed at the hand, and a held grab is never switched. Targets marked
 * {@link NEAR_GRAB_PRIORITY} (the laser handles, reached for while the laser points elsewhere)
 * always keep the sphere.
 */
export function preferLaserGrab(combined: CombinedPointerInternals): void {
  const active = combined.activePointer;
  if (active == null || !(active instanceof Pointer)) return;
  if (active.getPointerCapture() != null || laserGrabPointers.has(active)) return;
  const laser = combined.pointers.find((p): p is Pointer =>
    p instanceof Pointer && laserGrabPointers.has(p)
  );
  if (laser == null) return;
  const laserHit = laser.getIntersection();
  if (!realHit(laserHit)) return;
  const sphereHit = active.getIntersection();
  if (realHit(sphereHit)) {
    if (prefersNearGrab(sphereHit.object)) return;
    const node = spatialElementOf(sphereHit.object);
    if (node != null && node === spatialElementOf(laserHit.object)) return;
  }
  combined.activePointer = laser;
}

/** `CombinedPointer` with {@link preferLaserGrab}'s choice. */
function LaserFirstGrabPointer({ children }: { children?: React.ReactNode }) {
  const pointer = useMemo(() => {
    const combined = new CombinedPointerImpl(false);
    const internals = combined as unknown as CombinedPointerInternals;
    const nearest = internals.computeActivePointer.bind(combined);
    internals.computeActivePointer = () => {
      nearest();
      preferLaserGrab(internals);
    };
    return combined;
  }, []);
  const parent = useContext(combinedPointerContext);
  useEffect(() => parent?.register(pointer), [parent, pointer]);
  return (
    <combinedPointerContext.Provider value={pointer}>{children}</combinedPointerContext.Provider>
  );
}

/** Publishes this controller's grip space, so windows can be attached to the hand. */
function HandOriginSpace() {
  const state = useXRInputSourceStateContext();
  const handedness = state.inputSource.handedness;
  const ref = useRef<Object3D>(null);
  useEffect(() => {
    const object = ref.current;
    if (object == null || (handedness !== "left" && handedness !== "right")) return;
    return registerHandOrigin(`${handedness}-hand`, object);
  }, [handedness]);
  return <XRSpace ref={ref} space="grip-space" />;
}

/** Tag the actual grip-space parent, preserving the controller model's local calibration. */
function RenderTrackedControllerModel(props: React.ComponentProps<typeof XRControllerModel>) {
  const state = useXRInputSourceStateContext();
  const ref = useRef<Object3D>(null);
  useFrame(() => {
    const root = ref.current?.parent;
    const hand = state.inputSource.handedness;
    if (root && (hand === "left" || hand === "right")) {
      root.userData.renderTrackingAnchor = `${hand}-hand`;
    }
  });
  return <XRControllerModel {...props} ref={ref} />;
}

/**
 * Hit-capped aim beam, select ray, teleport, and both grip-sphere and laser grab on squeeze.
 * The inner {@link LaserFirstGrabPointer} picks one active grab: what the laser points at, else
 * the sphere when in range (the sphere also wins when both reach the same node).
 */
export function PetplayDefaultXRController(props: DefaultXRControllerOptions) {
  const modelOptions = props.model;
  const grabPointerOptions = props.grabPointer;
  const rayPointerOptions = props.rayPointer;
  const teleportPointerOptions = props.teleportPointer ?? false;
  const laserEnabled = useControllerLaserEnabled();

  const rayP = (spreadable(rayPointerOptions) ?? {}) as DefaultXRInputSourceRayPointerOptions;
  const grabO = (spreadable(grabPointerOptions) ?? {}) as DefaultXRInputSourceGrabPointerOptions;
  const { cursorModel: _cursorModel, ...grabPointerProps } = grabO;
  void _cursorModel;
  const minD = rayP.minDistance ?? 0.2;
  const {
    cursorModel: _gcm,
    radius: _gr,
    makeDefault: _gmd,
    ...grabForRay
  } = grabO;
  void _gcm;
  void _gr;
  void _gmd;

  return (
    <>
      {/* <HandPoker /> */}
      <HandOriginSpace />
      <LaserOffsetHandle />
      {modelOptions !== false && (
        <Suspense>
          <RenderTrackedControllerModel {...spreadable(modelOptions)} />
        </Suspense>
      )}
      {grabPointerOptions !== false && (
        <LaserFirstGrabPointer>
          <PetplayGrabSpherePointer {...grabPointerProps} />
          <PetplayGrabRayPointer
            {...(grabForRay as RayPointerOptions)}
            minDistance={minD}
            beam={laserEnabled && rayPointerOptions !== false}
          />
        </LaserFirstGrabPointer>
      )}
      {
        /*
        The laser setting hides the beam only. Dropping the pointer too would leave no way to point
        at the wrist menu's settings page and turn it back on.
      */
      }
      {rayPointerOptions !== false && (
        <PetplayDefaultXRInputSourceRayPointer
          {...rayP}
          {...(laserEnabled ? {} : { rayModel: false })}
          makeDefault
          minDistance={minD}
        />
      )}
      {teleportPointerOptions !== false && (
        <DefaultXRInputSourceTeleportPointer {...spreadable(teleportPointerOptions)} />
      )}
    </>
  );
}
