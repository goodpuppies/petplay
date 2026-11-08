import { Pointer, type RayPointerOptions } from "@pmndrs/pointer-events";
import {
  CombinedPointer,
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
} from "@pmndrs/xr";
import { useFrame } from "@react-three/fiber/webgpu";
import React, {
  forwardRef,
  Suspense,
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
import { registerHandOrigin } from "./trackedOrigins.ts";

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
  if (!pointer.getEnabled()) {
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
          // Aim feedback must remain visible over the screen receiving the ray.
          depthTest: false,
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
        depthTest: false,
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
    <XRSpace ref={ref} space="target-ray-space">
      <group userData={{ renderTrackingAnchor: `${handedness}-ray` }}>
        {rayModelOptions !== false && (
          <HudPointerRayModel
            pointer={pointer}
            {...PETPLAY_RAY_DEFAULTS}
            opacity={1}
            {...rayOpts}
          />
        )}
        {cursorModelOptions !== false && <HudPointerCursorModel pointer={pointer} />}
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

/** Squeeze + target-ray, `pointerType: "grab"`. Paired with `PetplayGrabSpherePointer` in `CombinedPointer`. */
function PetplayGrabRayPointer(
  { ...rayOpts }: RayPointerOptions,
) {
  const state = useXRInputSourceStateContext();
  const ref = useRef<Object3D>(null);
  const pointer = useRayPointer(ref, state, rayOpts, "grab");
  usePointerXRInputSourceEvents(pointer, state.inputSource, "squeeze", state.events);
  useRegisterGrabPointer(pointer, "ray");
  return <XRSpace ref={ref} space="target-ray-space" />;
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
 * Inner `CombinedPointer` picks one active grab (sphere when in range, else aim-ray grab).
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
      {modelOptions !== false && (
        <Suspense>
          <RenderTrackedControllerModel {...spreadable(modelOptions)} />
        </Suspense>
      )}
      {grabPointerOptions !== false && (
        <CombinedPointer>
          <PetplayGrabSpherePointer {...grabPointerProps} />
          <PetplayGrabRayPointer
            {...(grabForRay as RayPointerOptions)}
            minDistance={minD}
          />
        </CombinedPointer>
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
