import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { extend, type ThreeToJSXElements, useFrame } from "@react-three/fiber/webgpu";
import { Handle } from "@react-three/handle";
import { defaultApply, type HandleOptions, type HandleStore } from "@pmndrs/handle";
import { withOneHandScale } from "./oneHandScale.ts";
import { pushPullGrab } from "./pushPull.ts";
import type {
  PointerEvent as PenPointerEvent,
  WheelEvent as PenWheelEvent,
} from "@pmndrs/pointer-events";
import { useGrabboxOutlineVisible } from "./grabboxOutlineMode.ts";
import { penHandler } from "./penEvents.ts";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

declare module "@react-three/fiber/webgpu" {
  // deno-lint-ignore no-empty-interface
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

/** Default frame tint (shared with the display wireframe in prior code paths). */
export const DEFAULT_GRABBOX_LINE_COLOR = 0x7ec8e3;

/**
 * The one-hand trigger resize ({@link withOneHandScale}): while one hand grabs the box, pulling
 * its trigger resizes the target. Leave it off where a grab must not resize (a locked node).
 */
export type TriggerResize = {
  /** Let the renderer carry the target with the grabbing controller (free grabs, not hinges). */
  carryWithController?: boolean;
};

/** Handle options, plus the trigger resize, which travels with them through wrapping layers. */
export type GrabBoxManipulationOptions = Omit<HandleOptions<unknown>, "filter"> & {
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
  manipulationTargetRef?: React.RefObject<THREE.Object3D | null>;
  manipulationOptions?: GrabBoxManipulationOptions;
  manipulationStoreRef?: React.Ref<HandleStore<unknown>>;
  grabFilter?: (event: PenPointerEvent) => boolean;
  /** Select/focus this spatial object without coupling its contents to a specific node type. */
  onSpatialFocus?: () => void;
  /** Report hover at the spatial-object boundary without coupling chrome to its contents. */
  onSpatialHoverChange?: (hovered: boolean) => void;
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
function GrabBoxFrame(
  { width, height, depth, color }: {
    width: number;
    height: number;
    depth: number;
    color: THREE.Color;
  },
) {
  const t = GRABBOX_CHROME_THICKNESS;
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
  return (
    <>
      {bars.map((bar, index) => (
        <mesh
          key={index}
          position={bar.position}
          userData={{ raythreeHudOverUi: true }}
          {...({ pointerEvents: "none" } as Record<string, unknown>)}
        >
          <boxGeometry args={bar.size} />
          <meshBasicMaterial color={color} toneMapped={false} />
        </mesh>
      ))}
    </>
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
    manipulationTargetRef,
    manipulationOptions,
    manipulationStoreRef,
    grabFilter,
    onSpatialFocus,
    onSpatialHoverChange,
    userData,
    children,
  },
  ref,
) {
  const boxRef = useRef<THREE.Group>(null);
  const globalOutlineVisible = useGrabboxOutlineVisible();
  const chromeVisible = visibleChrome && globalOutlineVisible;
  const handleStoreRef = useRef<HandleStore<unknown> | null>(null);
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
  const handleOptions = useMemo((): Omit<HandleOptions<unknown>, "filter"> | undefined => {
    if (manipulationOptions == null) return undefined;
    const { triggerResize, ...options } = manipulationOptions;
    if (triggerResize == null) return options;
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
    return {
      ...options,
      apply: withOneHandScale(
        options.apply ?? defaultApply,
        resizeStores,
        measure,
        triggerResize.carryWithController ?? false,
      ),
      // The trigger resizes while the hand holds still, so apply runs every frame.
      alwaysUpdate: true,
    };
  }, [manipulationOptions, resizeStores, width, worldScale]);
  const handleWheel = useCallback((event: PenWheelEvent) => {
    const store = handleStoreRef.current;
    const notches = -event.deltaY / 100;
    if (store != null && pushPullGrab(store, event.pointerId, notches * 0.08)) {
      event.stopPropagation();
    }
  }, []);
  const color = useMemo(() => new THREE.Color(lineColor), [lineColor]);
  useFrame(() => {
    const store = handleStoreRef.current;
    if (store != null && store.capturedObjects.size > 0) cancelStaleHandleGrab(store);
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
      {children}
    </group>
  );
  if (!grabbable) return box;
  return (
    <Handle
      ref={setHandleStore}
      handleRef={boxRef as unknown as React.RefObject<import("three").Object3D | null>}
      targetRef={manipulationTargetRef as React.RefObject<import("three").Object3D | null>}
      {...handleOptions}
      multitouch={handleOptions?.multitouch ?? true}
      scale={handleOptions?.scale ?? { uniform: true }}
      filter={grabFilter}
    >
      {box}
    </Handle>
  );
});
