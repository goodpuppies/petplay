import type {
  PointerEvent as PenPointerEvent,
  WheelEvent as PenWheelEvent,
} from "@pmndrs/pointer-events";
import React, { forwardRef, useCallback, useEffect, useMemo, useRef } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import { extend, type ThreeToJSXElements } from "@react-three/fiber/webgpu";
import { Container } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { UiImage } from "../ui/image.tsx";
import { DEFAULT_GRABBOX_LINE_COLOR, GrabBox } from "../grabbox.tsx";
import { createMainControllerGate } from "../mainController.ts";
import type { DisplayMouseButton, DisplayMouseSink } from "./mouse.ts";
import { penHandler } from "../penEvents.ts";
import { isDesktopMousePointerType } from "../spatialPointer.ts";
import type { HandleOptions, HandleStore } from "@pmndrs/handle";
import {
  DEFAULT_DISPLAY_DEPTH,
  DEFAULT_DISPLAY_HEIGHT,
  DISPLAY_ASPECT_WIDTH_OVER_HEIGHT,
} from "../displayMetrics.ts";
import { createDisplaySurfaceGeometry } from "./curvedSurface.ts";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

declare module "@react-three/fiber/webgpu" {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

const STABLE_CLICK_HOLD_MS = 180;

const DISPLAY_GRAB_EDGE_HEIGHT = 0.025;

/**
 * Backplate logo: fraction of the display height the square logo occupies.
 * Kept well inside the frame so the grab-box chrome never overlaps it.
 */
const BACKPLATE_LOGO_SIZE = 0.45;
export type DisplayInstanceFrameProps = {
  /** Full height of the 16:9 frame. Width = height × `DISPLAY_ASPECT_WIDTH_OVER_HEIGHT`. */
  height?: number;
  /** Override bound game controls while an XR pointer interacts with this display. */
  blockGameInput?: boolean;
  depth?: number;
  /** Albedo / tint; same prop name as before. */
  lineColor?: number;
  /**
   * When `false` (default), the trigger **ray** ignores the wire hull; squeeze `grab` still collides — same
   * pattern as the keyboard `GrabBox` so you can aim with the laser and squeeze to move the display.
   */
  shellRayPickable?: boolean;
  /**
   * Native OpenVR overlays are not part of the Three.js scene, so ray beams need a local invisible
   * proxy surface to stop on the display instead of extending through it.
   */
  rayHitSurface?: boolean;
  /** OpenVR overlay curvature; the ray proxy bends to match (`curvedSurface.ts`). */
  curvature?: number;
  /**
   * The media feed this display shows and which part of it, for renderers that draw the picture
   * in the scene themselves (the scene stream's `videoSurface`, `classes/sceneStoreWriter.ts`).
   * The OpenVR overlay path does not use it.
   */
  videoFeed?: {
    feed: string;
    crop: { x: number; y: number; width: number; height: number };
    opacity: number;
  } | null;
  /** Optional display-space mouse sink; receives normalized 0..1 coordinates on the screen plane. */
  onMouse?: DisplayMouseSink;
  mouseButtonForPointer?: (event: PenPointerEvent) => DisplayMouseButton | undefined;
  manipulationTargetRef?: React.RefObject<THREE.Object3D | null>;
  manipulationOptions?: Omit<HandleOptions<unknown>, "filter">;
  manipulationStoreRef?: React.Ref<HandleStore<unknown>>;
  onSpatialFocus?: () => void;
  onSpatialHoverChange?: (hovered: boolean) => void;
  /** Controls and other spatial content structurally owned by this display. */
  children?: React.ReactNode;
};

function pointerButton(button: number | undefined): DisplayMouseButton {
  switch (button) {
    case 1:
      return "middle";
    case 2:
      return "right";
    default:
      return "left";
  }
}

function isDesktopDisplayGrab(e: PenPointerEvent): boolean {
  return isDesktopMousePointerType(e.pointerType) && e.nativeEvent.altKey &&
    e.nativeEvent.button === 0;
}

function displayCoordsFromPointerEvent(
  e: Pick<PenPointerEvent, "uv">,
): { x: number; y: number } | null {
  const uv = e.uv;
  if (uv == null) return null;
  return {
    x: Math.min(1, Math.max(0, uv.x)),
    y: Math.min(1, Math.max(0, 1 - uv.y)),
  };
}

type DisplayMousePoint = { x: number; y: number };

type PendingDisplayClick = {
  pointerId: number;
  button: DisplayMouseButton;
  start: DisplayMousePoint;
  latest: DisplayMousePoint;
  timer: ReturnType<typeof setTimeout> | null;
  dragStarted: boolean;
};

/**
 * Visual-only 16:9 thin box — a [GrabBox](grabbox.tsx) with fixed aspect. Wireframe and raylib
 * mirroring are documented on `GrabBox`.
 */
export const DisplayInstanceFrame = forwardRef<THREE.Group, DisplayInstanceFrameProps>(
  function DisplayInstanceFrame(
    {
      height = DEFAULT_DISPLAY_HEIGHT,
      blockGameInput = true,
      depth = DEFAULT_DISPLAY_DEPTH,
      lineColor = DEFAULT_GRABBOX_LINE_COLOR,
      shellRayPickable = false,
      rayHitSurface = true,
      curvature = 0,
      videoFeed = null,
      onMouse,
      mouseButtonForPointer,
      manipulationTargetRef,
      manipulationOptions,
      manipulationStoreRef,
      onSpatialFocus,
      onSpatialHoverChange,
      children,
    },
    ref,
  ) {
    const width = useMemo(
      () => height * DISPLAY_ASPECT_WIDTH_OVER_HEIGHT,
      [height],
    );
    const surfaceGeometry = useMemo(
      () => createDisplaySurfaceGeometry(width, height, curvature),
      [width, height, curvature],
    );
    useEffect(() => () => surfaceGeometry.dispose(), [surfaceGeometry]);
    const grabEdgeGeometry = useMemo(
      () => createDisplaySurfaceGeometry(width, DISPLAY_GRAB_EDGE_HEIGHT, curvature),
      [width, curvature],
    );
    useEffect(() => () => grabEdgeGeometry.dispose(), [grabEdgeGeometry]);
    const videoSurface = useMemo(
      () => videoFeed ? { ...videoFeed, geometry: surfaceGeometry } : null,
      [
        videoFeed?.feed,
        videoFeed?.crop.x,
        videoFeed?.crop.y,
        videoFeed?.crop.width,
        videoFeed?.crop.height,
        videoFeed?.opacity,
        surfaceGeometry,
      ],
    );
    const pendingClickRef = useRef<PendingDisplayClick | null>(null);
    const desktopMoves = useRef(new WeakSet<object>());
    const desktopGrabs = useRef(new Set<number>());
    const mainControllerGate = useMemo(() => createMainControllerGate(), []);

    const clearPendingTimer = useCallback((pending: PendingDisplayClick) => {
      if (pending.timer != null) clearTimeout(pending.timer);
      pending.timer = null;
    }, []);

    const beginDrag = useCallback((pending: PendingDisplayClick) => {
      if (onMouse == null || pending.dragStarted) return;
      pending.dragStarted = true;
      onMouse({ kind: "move", ...pending.start });
      onMouse({ kind: "button", button: pending.button, pressed: true, ...pending.start });
      onMouse({ kind: "move", ...pending.latest });
    }, [onMouse]);

    const releasePendingClick = useCallback(() => {
      const pending = pendingClickRef.current;
      if (pending == null) return;
      pendingClickRef.current = null;
      clearPendingTimer(pending);
      if (pending.dragStarted) {
        onMouse?.({ kind: "button", button: pending.button, pressed: false, ...pending.latest });
      }
    }, [clearPendingTimer, onMouse]);

    useEffect(() => {
      return () => {
        mainControllerGate.reset();
        releasePendingClick();
      };
    }, [mainControllerGate, releasePendingClick]);

    const emitMove = useCallback((e: PenPointerEvent) => {
      if (onMouse == null) return;
      if (isDesktopMousePointerType(e.pointerType)) {
        // The forwarding bridge can replay the last native move each scene frame.
        if (desktopMoves.current.has(e.nativeEvent)) return;
        desktopMoves.current.add(e.nativeEvent);
        if (desktopGrabs.current.has(e.pointerId)) return;
        if (e.nativeEvent.altKey && pendingClickRef.current?.pointerId !== e.pointerId) return;
      }
      if (mainControllerGate.move(e.pointerState) !== "emit") return;
      const coords = displayCoordsFromPointerEvent(e);
      if (coords == null) return;
      const pending = pendingClickRef.current;
      if (pending != null) {
        if (pending.pointerId !== e.pointerId) return;
        pending.latest = coords;
        if (pending.dragStarted) {
          onMouse({ kind: "move", ...coords });
        }
        return;
      }
      onMouse({ kind: "move", ...coords });
    }, [mainControllerGate, onMouse]);

    const emitButton = useCallback((e: PenPointerEvent, pressed: boolean, cancelled = false) => {
      if (pressed && isDesktopDisplayGrab(e)) {
        desktopGrabs.current.add(e.pointerId);
        return;
      }
      if (!pressed && desktopGrabs.current.delete(e.pointerId)) return;
      // A display still owns the press when its desktop input is unavailable or blocked.
      if (isDesktopMousePointerType(e.pointerType)) e.stopPropagation();
      if (onMouse == null) return;
      const current = pendingClickRef.current;
      const coords = displayCoordsFromPointerEvent(e) ??
        (!pressed && current?.pointerId === e.pointerId ? current.latest : null);
      if (coords == null) return;
      e.stopPropagation();
      const gated = pressed
        ? mainControllerGate.down(e.pointerState, e.pointerId)
        : mainControllerGate.up(e.pointerState, e.pointerId);
      if (gated !== "emit") {
        // A trigger press that promotes the other controller to main hand must not
        // also click, and its release must not reach the desktop either.
        if (gated === "switch" && pressed) {
          // The outgoing hand can still be holding its trigger; close that
          // interaction now, or its own release gets ignored and the button
          // stays stuck down on the desktop.
          releasePendingClick();
        }
        return;
      }
      const object = e.currentTarget as unknown as THREE.Object3D & {
        setPointerCapture?: (pointerId: number) => void;
        releasePointerCapture?: (pointerId: number) => void;
      };
      if (pressed) {
        object.setPointerCapture?.(e.pointerId);
        const previous = pendingClickRef.current;
        if (previous != null) {
          clearPendingTimer(previous);
          if (previous.dragStarted) {
            onMouse({
              kind: "button",
              button: previous.button,
              pressed: false,
              ...previous.latest,
            });
          }
        }
        const pending: PendingDisplayClick = {
          pointerId: e.pointerId,
          button: mouseButtonForPointer?.(e) ?? pointerButton(e.nativeEvent.button),
          start: coords,
          latest: coords,
          timer: null,
          dragStarted: false,
        };
        pending.timer = setTimeout(() => beginDrag(pending), STABLE_CLICK_HOLD_MS);
        pendingClickRef.current = pending;
      } else {
        const pending = pendingClickRef.current;
        if (pending != null && pending.pointerId === e.pointerId) {
          object.releasePointerCapture?.(e.pointerId);
          pendingClickRef.current = null;
          clearPendingTimer(pending);
          if (pending.dragStarted) {
            onMouse({ kind: "move", ...coords });
            onMouse({ kind: "button", button: pending.button, pressed: false, ...coords });
          } else if (!cancelled) {
            onMouse({ kind: "move", ...pending.start });
            onMouse({ kind: "button", button: pending.button, pressed: true, ...pending.start });
            onMouse({ kind: "button", button: pending.button, pressed: false, ...pending.start });
          }
        }
      }
    }, [
      beginDrag,
      clearPendingTimer,
      mainControllerGate,
      mouseButtonForPointer,
      onMouse,
      releasePendingClick,
    ]);

    const emitWheel = useCallback((e: PenWheelEvent) => {
      if (!isDesktopMousePointerType(e.pointerType)) return;
      e.stopPropagation();
      if (onMouse == null) return;
      const coords = displayCoordsFromPointerEvent(e);
      if (coords == null || e.deltaY === 0) return;
      onMouse({ kind: "wheel", deltaY: e.deltaY / 100, ...coords });
    }, [onMouse]);

    return (
      <GrabBox
        ref={ref}
        userData={{ blockGameInput }}
        width={width}
        height={height}
        depth={depth}
        lineColor={lineColor}
        shellRayPickable={shellRayPickable}
        manipulationTargetRef={manipulationTargetRef}
        manipulationOptions={manipulationOptions}
        manipulationStoreRef={manipulationStoreRef}
        onSpatialFocus={onSpatialFocus}
        onSpatialHoverChange={onSpatialHoverChange}
        grabFilter={(event) =>
          isDesktopMousePointerType(event.pointerType)
            ? isDesktopDisplayGrab(event) ||
              (event.button === 0 && event.object.userData.displayGrabEdge === true)
            : event.pointerType !== "ray" && event.pointerType !== "poker"}
      >
        {(rayHitSurface || shellRayPickable) && [-1, 1].map((side) => (
          <mesh
            key={side}
            position={[0, side * (height + DISPLAY_GRAB_EDGE_HEIGHT) / 2, 0]}
            userData={{ displayGrabEdge: true }}
            {...({
              pointerEventsType: { allow: ["grab", "screen-mouse", "mouse"] },
            } as Record<string, unknown>)}
          >
            <primitive object={grabEdgeGeometry} attach="geometry" />
            <meshBasicMaterial color={lineColor} toneMapped={false} side={THREE.DoubleSide} />
          </mesh>
        ))}
        {videoSurface ? <group userData={{ videoSurface }} /> : null}
        {rayHitSurface
          ? (
            <mesh
              renderOrder={-100}
              userData={{ displayInstanceRayHitSurface: true, passthroughCutout: true }}
              onPointerMove={penHandler(emitMove)}
              onPointerDown={penHandler((e: PenPointerEvent) => emitButton(e, true))}
              onPointerUp={penHandler((e: PenPointerEvent) => emitButton(e, false))}
              onPointerCancel={penHandler((e: PenPointerEvent) => emitButton(e, false, true))}
              onWheel={penHandler(emitWheel)}
              {...({
                pointerEvents: "auto",
                // Browser and native desktop views both forward DOM-style mouse rays.
                pointerEventsType: { allow: ["ray", "screen-mouse", "mouse"] },
                // Prefer the screen proxy over the surrounding GrabBox
                // hull, even though the hull is a little closer to the hand.
                pointerEventsOrder: 1,
              } as Record<string, unknown>)}
            >
              <primitive object={surfaceGeometry} attach="geometry" />
              <meshBasicMaterial
                depthTest
                depthWrite
                colorWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
          )
          : null}
        {
          /*
           * Backplate: opaque black card on the display's rear face with the logo.
           * The card is a plain front-facing scene mesh — the 3D pass depth-tests
           * with backface culling on, so it occludes like real geometry and shows
           * only from behind. The logo rides the uikit snapshot (the only route
           * that draws in both the raylib overlay and the desktop preview) inside
           * a transparent layout-only Container, and `drawUiImage` culls its
           * backface so it never paints over the front either. Not pickable: the
           * grab hull and screen proxy own pointer input.
           */
        }
        <group position={[0, 0, -depth / 2 - 0.001]} rotation={[0, Math.PI, 0]}>
          <mesh {...({ pointerEvents: "none" } as Record<string, unknown>)}>
            <planeGeometry args={[width, height]} />
            <meshBasicNodeMaterial colorNode={TSL.color(0x000000)} side={THREE.FrontSide} />
          </mesh>
          <Container
            width={width / 0.001}
            height={height / 0.001}
            pixelSize={0.001}
            backgroundColor="transparent"
            borderWidth={0}
            {...({ pointerEvents: "none" } as Record<string, unknown>)}
          >
            <UiImage
              texture="petplay"
              width={height * BACKPLATE_LOGO_SIZE / 0.001}
              height={height * BACKPLATE_LOGO_SIZE / 0.001}
              fit="cover"
              positionLeft={(width - height * BACKPLATE_LOGO_SIZE) / 2 / 0.001}
              positionTop={(height - height * BACKPLATE_LOGO_SIZE) / 2 / 0.001}
            />
          </Container>
        </group>
        {children}
      </GrabBox>
    );
  },
);
