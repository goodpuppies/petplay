import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { extend, type ThreeToJSXElements, useFrame, useThree } from "@react-three/fiber/webgpu";
import { defaultApply, type HandleState, type HandleStore } from "@pmndrs/handle";
import { PetPlayHandle, type PetPlayHandleOptions } from "./petplayHandleStore.tsx";
import { Container } from "../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Icon } from "./ui/icons.tsx";
import { COLOR } from "./ui/tokens.ts";
import { readGrabPointerStickY, withOneHandScale } from "./oneHandScale.ts";
import { pushPullGrab } from "./pushPull.ts";
import type {
  PointerEvent as PenPointerEvent,
  WheelEvent as PenWheelEvent,
} from "@pmndrs/pointer-events";
import { useGrabboxOutlineVisible } from "./grabboxOutlineMode.ts";
import { penHandler } from "./penEvents.ts";
import { PetplayElement } from "./petplayElement.tsx";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

declare module "@react-three/fiber/webgpu" {
  // deno-lint-ignore no-empty-interface
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

/** Default frame tint (shared with the display wireframe in prior code paths). */
export const DEFAULT_GRABBOX_LINE_COLOR = 0x7ec8e3;
/** Default thumbstick push/pull speed along the grabbing ray (metres per second). */
export const JOYSTICK_PUSH_PULL_METERS_PER_SECOND = 2;
/** World max-extent below which shrinking a GrabBox arms dismiss (delete/close on release). */
export const DISMISS_ARM_SIZE_METERS = 0.1;
/** Hysteresis threshold above which an armed GrabBox disarms again. */
export const DISMISS_DISARM_SIZE_METERS = 0.13;

export function nextDismissArmed(currentlyArmed: boolean, worldSizeMeters: number): boolean {
  return currentlyArmed
    ? worldSizeMeters < DISMISS_DISARM_SIZE_METERS
    : worldSizeMeters < DISMISS_ARM_SIZE_METERS;
}

/**
 * The one-hand trigger resize ({@link withOneHandScale}): while one hand grabs the box, pulling
 * its trigger resizes the target. Leave it off where a grab must not resize (a locked node).
 */
export type TriggerResize = {
  /** Let the renderer carry the target with the grabbing controller (free grabs, not hinges). */
  carryWithController?: boolean;
};

/** Handle options, plus the trigger resize, which travels with them through wrapping layers. */
export type GrabBoxManipulationOptions = Omit<PetPlayHandleOptions<unknown>, "filter"> & {
  triggerResize?: TriggerResize;
};

export type GrabBoxProps = {
  width: number;
  height: number;
  depth: number;
  /** Albedo / emissive tint. */
  lineColor?: number;
  /** `edges` draws only the 12 box edges; `mesh` keeps the old triangle wireframe with face diagonals. */
  wireframeMode?: "edges" | "mesh";
  /**
   * When `false`, XR **trigger rays** ignore this hull so they can hit children behind the shell
   * (keyboard keys). Squeeze “grab” still collides. Default `true` for generic shells like the display bezel.
   */
  shellRayPickable?: boolean;
  /** Include the invisible interaction hull. Use `false` for purely visual/edit hints. */
  interactionHull?: boolean;
  interactionHullFilter?: (
    pointerId: number,
    pointerType: string,
    pointerState: unknown,
  ) => boolean;
  /** Draw the wireframe chrome. The invisible interaction hull remains active. */
  visibleChrome?: boolean;
  /**
   * Whether this spatial-object boundary owns manipulation for its complete subtree.
   * Defaults to true; decorative/action-only boxes must explicitly opt out.
   */
  grabbable?: boolean;
  /** Whether thumbstick up/down pushes/pulls this box along the grabbing ray. Defaults to true. */
  joystickPushPull?: boolean;
  manipulationTargetRef?: React.RefObject<THREE.Object3D | null>;
  manipulationOptions?: GrabBoxManipulationOptions;
  manipulationStoreRef?: React.Ref<HandleStore<unknown>>;
  grabFilter?: (event: PenPointerEvent) => boolean;
  /** Select/focus this spatial object without coupling its contents to a specific node type. */
  onSpatialFocus?: () => void;
  /** Report hover at the spatial-object boundary without coupling chrome to its contents. */
  onSpatialHoverChange?: (hovered: boolean) => void;
  /**
   * Universal close / trash / delete callback for this spatial element. When provided, shrinking
   * the box below `DISMISS_ARM_SIZE_METERS` (via two-hand pinch OR one-hand trigger resize) arms
   * the red dismiss indicator and invokes `onDismiss` on release.
   */
  onDismiss?: () => void;
  userData?: Record<string, unknown>;
  /** Uikit + this box both use a centered origin; children only need a `contentOffset` nudge, not a pivot correction. */
  children?: React.ReactNode;
};

/**
 * Ends a grab whose pointer no longer holds capture of the handle.
 *
 * A pointer can drop its capture without emitting `pointerup` or
 * `pointercancel`: when it is disabled (`CombinedPointer` swapping the grip
 * sphere and the grab ray, a controller losing its input source), when it
 * exits, or when the squeeze is released while it is disabled. The
 * `HandleStore` never hears about it and keeps the pointer as grabbing, and
 * because it only checks its own bookkeeping, every later hover of that
 * pointer over the handle moves the object again.
 *
 * @returns whether a stale grab was cancelled
 */
export function cancelStaleHandleGrab(store: HandleStore<unknown>): boolean {
  for (const [pointerId, object] of store.capturedObjects) {
    if (!object.hasPointerCapture(pointerId)) {
      store.cancel();
      return true;
    }
  }
  return false;
}

/**
 * Bar cross-section in meters. The headset sees these bars at full eye
 * resolution, where 2 mm already reads as a clear line; the desktop preview
 * only has 1080p over the same FOV, so it is worth capturing larger to inspect
 * them.
 */
export const GRABBOX_CHROME_THICKNESS = 0.002;

/**
 * The box outline as twelve thin bars.
 *
 * This used to be a `lineSegments` with a raythree `bridge`, which the lowerer
 * turns into merged tube geometry: the overlay extracts and uploads it, issues
 * the draw, and nothing appears — grab boxes had no chrome in the headset or in
 * captures. Meshes draw on both the raylib and WebGPU paths, so the outline is
 * built from boxes instead of lines. `raythreeHudOverUi` keeps it above the
 * uikit pass that draws the keys and panels over everything before it.
 */
/**
 * Build one merged `BufferGeometry` containing all 12 wireframe edge bars of a box centered at
 * `(0, 0, 0)`. One mesh + one draw call, with exact `boundingBox` / `boundingSphere` matching the
 * grab box itself.
 */
function buildGrabBoxFrameGeometry(
  width: number,
  height: number,
  depth: number,
  t: number,
): THREE.BufferGeometry {
  const hx = width / 2;
  const hy = height / 2;
  const hz = depth / 2;
  const bars: Array<{ position: [number, number, number]; size: [number, number, number] }> = [];
  for (const y of [-hy, hy]) {
    for (const z of [-hz, hz]) {
      bars.push({ position: [0, y, z], size: [width + t, t, t] });
    }
  }
  for (const x of [-hx, hx]) {
    for (const z of [-hz, hz]) {
      bars.push({ position: [x, 0, z], size: [t, height + t, t] });
    }
  }
  for (const x of [-hx, hx]) {
    for (const y of [-hy, hy]) {
      bars.push({ position: [x, y, 0], size: [t, t, depth + t] });
    }
  }

  const vertsPerBar = 24;
  const indicesPerBar = 36;
  const positions = new Float32Array(bars.length * vertsPerBar * 3);
  const normals = new Float32Array(bars.length * vertsPerBar * 3);
  const uvs = new Float32Array(bars.length * vertsPerBar * 2);
  const indices = new Uint16Array(bars.length * indicesPerBar);

  for (let b = 0; b < bars.length; b++) {
    const bar = bars[b]!;
    const box = new THREE.BoxGeometry(bar.size[0], bar.size[1], bar.size[2]);
    const posAttr = box.getAttribute("position") as THREE.BufferAttribute;
    const normAttr = box.getAttribute("normal") as THREE.BufferAttribute;
    const uvAttr = box.getAttribute("uv") as THREE.BufferAttribute;
    const idxAttr = box.getIndex()!;
    const vOff = b * vertsPerBar;
    const iOff = b * indicesPerBar;
    for (let i = 0; i < vertsPerBar; i++) {
      positions[(vOff + i) * 3] = posAttr.getX(i) + bar.position[0];
      positions[(vOff + i) * 3 + 1] = posAttr.getY(i) + bar.position[1];
      positions[(vOff + i) * 3 + 2] = posAttr.getZ(i) + bar.position[2];
      normals[(vOff + i) * 3] = normAttr.getX(i);
      normals[(vOff + i) * 3 + 1] = normAttr.getY(i);
      normals[(vOff + i) * 3 + 2] = normAttr.getZ(i);
      uvs[(vOff + i) * 2] = uvAttr.getX(i);
      uvs[(vOff + i) * 2 + 1] = uvAttr.getY(i);
    }
    for (let i = 0; i < indicesPerBar; i++) {
      indices[iOff + i] = idxAttr.getX(i) + vOff;
    }
    box.dispose();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function GrabBoxFrame(
  { width, height, depth, color }: {
    width: number;
    height: number;
    depth: number;
    color: THREE.Color;
  },
) {
  const t = GRABBOX_CHROME_THICKNESS;
  const geometry = useMemo(
    () => buildGrabBoxFrameGeometry(width, height, depth, t),
    [width, height, depth, t],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  const renderProps = useMemo(
    () => ({ overlayRole: "stereo" as const, hudOverUi: true }),
    [],
  );
  return (
    <PetplayElement renderProps={renderProps}>
      <mesh
        geometry={geometry}
        {...({ pointerEvents: "none" } as Record<string, unknown>)}
      >
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
    </PetplayElement>
  );
}

const NO_POINTER_EVENTS = () => false;
const _dismissHeadPos = new THREE.Vector3();
const _dismissSelfPos = new THREE.Vector3();
const _dismissParentScale = new THREE.Vector3();
const _dismissParentQuat = new THREE.Quaternion();
const _dismissWorldQuat = new THREE.Quaternion();
const _dismissLookMat = new THREE.Matrix4();
const _dismissUp = new THREE.Vector3(0, 1, 0);

/**
 * Translucent red trash icon projected on the shrunken element, always billboarding toward the
 * user's head and counter-scaling the parent so it stays a crisp constant world size (~12 cm).
 */
function DismissIndicator() {
  const groupRef = useRef<THREE.Group>(null);
  const camera = useThree((state) => state.camera);
  const renderer = useThree((state) => state.renderer);

  useFrame(() => {
    const node = groupRef.current;
    const parent = node?.parent;
    if (!node || !parent) return;

    const xr = (renderer as unknown as {
      xr?: { getCamera?: (cam: THREE.Camera) => THREE.Camera };
    }).xr;
    const head = Deno.args.includes("--desktop")
      ? camera
      : xr?.getCamera?.(camera as unknown as THREE.Camera) ?? camera;
    head.updateWorldMatrix(true, false);
    head.getWorldPosition(_dismissHeadPos);

    parent.updateWorldMatrix(true, false);
    parent.getWorldScale(_dismissParentScale);
    parent.getWorldQuaternion(_dismissParentQuat);
    node.getWorldPosition(_dismissSelfPos);

    // Counter-scale so the 120px (0.12 m) badge stays readable even when the box is tiny.
    node.scale.set(
      1 / Math.max(1e-4, Math.abs(_dismissParentScale.x)),
      1 / Math.max(1e-4, Math.abs(_dismissParentScale.y)),
      1 / Math.max(1e-4, Math.abs(_dismissParentScale.z)),
    );

    // Point local +Z toward the user's head in parent-local space.
    _dismissLookMat.lookAt(_dismissHeadPos, _dismissSelfPos, _dismissUp);
    _dismissWorldQuat.setFromRotationMatrix(_dismissLookMat);
    node.quaternion.copy(_dismissParentQuat).invert().multiply(_dismissWorldQuat);
  });

  return (
    <group ref={groupRef} userData={{ bridge: { kind: "skip" }, dismissIndicator: true }}>
      <Container
        pixelSize={0.001}
        width={120}
        height={120}
        borderRadius={60}
        backgroundColor={COLOR.danger}
        backgroundOpacity={0.32}
        opacity={0.82}
        alignItems="center"
        justifyContent="center"
        pointerEventsType={NO_POINTER_EVENTS}
      >
        <Icon name="delete" size={76} color={COLOR.dangerBright} />
      </Container>
    </group>
  );
}

/**
 * Canonical spatial-object boundary for an arbitrary subtree (from one widget to a complete OS UI).
 * It owns manipulation, push/pull, interaction hull, chrome, and spatial metadata in one place.
 *
 * `wireframeMode="edges"` draws only the AABB outline and keeps a separate invisible mesh as the
 * interaction hull. `wireframeMode="mesh"` preserves the old triangle-wireframe visual.
 */
export const GrabBox = forwardRef<THREE.Group, GrabBoxProps>(function GrabBox(
  {
    width,
    height,
    depth,
    lineColor = DEFAULT_GRABBOX_LINE_COLOR,
    wireframeMode = "edges",
    shellRayPickable = true,
    interactionHull = true,
    interactionHullFilter,
    visibleChrome = true,
    grabbable = true,
    joystickPushPull = true,
    manipulationTargetRef,
    manipulationOptions,
    manipulationStoreRef,
    grabFilter,
    onSpatialFocus,
    onSpatialHoverChange,
    onDismiss,
    userData,
    children,
  },
  ref,
) {
  const boxRef = useRef<THREE.Group>(null);
  const globalOutlineVisible = useGrabboxOutlineVisible();
  const chromeVisible = visibleChrome && globalOutlineVisible;
  const handleStoreRef = useRef<HandleStore<unknown> | null>(null);
  const [dismissArmed, setDismissArmed] = useState(false);
  const dismissArmedRef = useRef(false);
  const sawScaleRef = useRef(false);
  const startScaleRef = useRef(1);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const setArmed = useCallback((next: boolean) => {
    if (dismissArmedRef.current === next) return;
    dismissArmedRef.current = next;
    setDismissArmed(next);
  }, []);
  useEffect(() => {
    if (onDismiss == null) setArmed(false);
  }, [onDismiss, setArmed]);
  useImperativeHandle(ref, () => boxRef.current!, []);
  // `withOneHandScale` finds the grabbing pointer through the store its state belongs to.
  const resizeStores = useMemo(() => new Map<string, HandleStore<unknown>>(), []);
  const setHandleStore = useCallback((store: HandleStore<unknown> | null) => {
    handleStoreRef.current = store;
    if (store) resizeStores.set("box", store);
    else resizeStores.delete("box");
    if (typeof manipulationStoreRef === "function") manipulationStoreRef(store);
    else if (manipulationStoreRef != null) {
      (manipulationStoreRef as React.MutableRefObject<HandleStore<unknown> | null>).current = store;
    }
  }, [manipulationStoreRef, resizeStores]);
  const worldScale = useMemo(() => new THREE.Vector3(), []);
  const handleOptions = useMemo((): Omit<PetPlayHandleOptions<unknown>, "filter"> | undefined => {
    const { triggerResize, ...options } = manipulationOptions ?? {};
    let innerApply = options.apply ?? defaultApply;
    let alwaysUpdate = options.alwaysUpdate;

    if (triggerResize != null) {
      const measure = {
        width: () => {
          const box = boxRef.current;
          if (box == null) return width;
          box.updateWorldMatrix(true, false);
          return width * Math.abs(box.getWorldScale(worldScale).x);
        },
        // The box geometry is centred on its group.
        center: (out: THREE.Vector3) => boxRef.current?.getWorldPosition(out) ?? out.set(0, 0, 0),
      };
      innerApply = withOneHandScale(
        innerApply,
        resizeStores,
        measure,
        triggerResize.carryWithController ?? false,
      );
      // The trigger resizes while the hand holds still, so apply runs every frame.
      alwaysUpdate = true;
    }

    if (onDismiss == null && manipulationOptions == null) return undefined;
    if (onDismiss == null) {
      return { ...options, apply: innerApply, alwaysUpdate };
    }

    const applyWithDismiss = (state: HandleState<unknown>, target: import("three").Object3D) => {
      const targetObj = target as unknown as THREE.Object3D;
      if (state.first) {
        sawScaleRef.current = false;
        startScaleRef.current = Math.abs(targetObj.scale.x);
        setArmed(false);
      }
      if (state.last && dismissArmedRef.current && state.event != null) {
        setArmed(false);
        sawScaleRef.current = false;
        onDismissRef.current?.();
        return;
      }

      innerApply(state, target);

      if (!state.last) {
        if (
          state.current.pointerAmount >= 2 ||
          Math.abs(Math.abs(targetObj.scale.x) - startScaleRef.current) > 1e-3
        ) {
          sawScaleRef.current = true;
        }
        if (sawScaleRef.current) {
          targetObj.updateWorldMatrix(true, false);
          targetObj.getWorldScale(worldScale);
          const worldSize = Math.max(
            Math.abs(worldScale.x) * width,
            Math.abs(worldScale.y) * height,
            Math.abs(worldScale.z) * depth,
          );
          setArmed(nextDismissArmed(dismissArmedRef.current, worldSize));
        }
      } else {
        setArmed(false);
        sawScaleRef.current = false;
      }
    };

    return {
      ...options,
      apply: applyWithDismiss,
      alwaysUpdate,
    };
  }, [manipulationOptions, onDismiss, resizeStores, setArmed, width, height, depth, worldScale]);
  const handleWheel = useCallback((event: PenWheelEvent) => {
    const store = handleStoreRef.current;
    const notches = -event.deltaY / 100;
    if (store != null && pushPullGrab(store, event.pointerId, notches * 0.08)) {
      event.stopPropagation();
    }
  }, []);
  const color = useMemo(() => new THREE.Color(lineColor), [lineColor]);
  useFrame((_state, delta) => {
    const store = handleStoreRef.current;
    if (store == null) return;
    if (store.capturedObjects.size > 0 && cancelStaleHandleGrab(store)) return;
    if (!joystickPushPull || store.inputState.size === 0) return;
    const dt = Math.min(delta, 0.1);
    for (const pointerId of store.inputState.keys()) {
      const axis = readGrabPointerStickY(pointerId);
      if (axis !== 0) {
        pushPullGrab(store, pointerId, axis * JOYSTICK_PUSH_PULL_METERS_PER_SECOND * dt);
      }
    }
  });

  const shellPointerMods = !shellRayPickable
    ? ({
      // This hull exists solely for squeeze-grab. Explicitly allow that one
      // pointer type so trigger rays always continue to the inner flat/key
      // surface instead of ending at the box depth.
      pointerEventsType: interactionHullFilter == null
        ? { allow: "grab" }
        : (pointerId: number, pointerType: string, pointerState: unknown) =>
          pointerType === "grab" && interactionHullFilter(pointerId, pointerType, pointerState),
    } as Record<string, unknown>)
    : {};

  // Hover enter/leave fires per laser sweep, including the laser-off edge.
  // Guard with a ref so repeat enters don't re-invoke the callback: parents
  // wire this straight to React state (DisplaySpatialNodeView `setHovered`),
  // and a redundant setState burns a full subtree re-render + uikit text
  // rebuild on every pointermove that happens to re-enter.
  const hoveredRef = useRef(false);
  const handleHoverEnter = useCallback(() => {
    if (hoveredRef.current) return;
    hoveredRef.current = true;
    onSpatialHoverChange?.(true);
  }, [onSpatialHoverChange]);
  const handleHoverLeave = useCallback(() => {
    if (!hoveredRef.current) return;
    hoveredRef.current = false;
    onSpatialHoverChange?.(false);
  }, [onSpatialHoverChange]);

  const box = (
    <group
      ref={boxRef}
      onWheel={penHandler(handleWheel)}
      onPointerOver={onSpatialFocus}
      onPointerEnter={handleHoverEnter}
      onPointerLeave={handleHoverLeave}
      userData={{ ...userData, grabbox: true, grabboxSize: [width, height, depth] as const }}
    >
      {wireframeMode === "edges"
        ? (
          <>
            {chromeVisible
              ? <GrabBoxFrame width={width} height={height} depth={depth} color={color} />
              : null}
            {interactionHull
              ? (
                <mesh renderOrder={-100} {...shellPointerMods}>
                  <boxGeometry args={[width, height, depth]} />
                  <meshBasicMaterial
                    depthTest
                    // The hull is only a pointer/grab proxy. It must not write
                    // invisible depth that clips controller lasers before they
                    // reach interactive children inside the box.
                    depthWrite={false}
                    colorWrite={false}
                    side={THREE.DoubleSide}
                  />
                </mesh>
              )
              : null}
          </>
        )
        : (
          <mesh {...shellPointerMods}>
            <boxGeometry args={[width, height, depth]} />
            <meshLambertMaterial
              wireframe
              color={color}
              emissive={color}
              emissiveIntensity={0.2}
              visible={chromeVisible}
              side={THREE.DoubleSide}
            />
          </mesh>
        )}
      {dismissArmed ? <DismissIndicator /> : null}
      {children}
    </group>
  );
  if (!grabbable) return box;
  return (
    <PetPlayHandle
      ref={setHandleStore}
      handleRef={boxRef as unknown as React.RefObject<import("three").Object3D | null>}
      targetRef={manipulationTargetRef as React.RefObject<import("three").Object3D | null>}
      {...handleOptions}
      multitouch={handleOptions?.multitouch ?? true}
      scale={handleOptions?.scale ?? { uniform: true }}
      filter={grabFilter}
    >
      {box}
    </PetPlayHandle>
  );
});
