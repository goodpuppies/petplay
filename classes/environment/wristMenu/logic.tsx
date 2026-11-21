import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { extend, ThreeToJSXElements } from "@react-three/fiber/webgpu";
import { useXRInputSourceStateContext, XRSpace } from "@pmndrs/xr";
import type {
  AllowedPointerEventsType,
  PointerEvent as PenPointerEvent,
} from "@pmndrs/pointer-events";
import { PetplayDefaultXRController } from "../petplayXrController.tsx";
import { PostMan } from "../../../submodules/stageforge/mod.ts";
import { WristMenuUi } from "./ui.tsx";
import type { WristMenuButtonId, WristMenuStateSnapshot } from "./types.ts";
import { setToolEditMode } from "../toolEditMode.ts";
import { requestLayoutRecenter, setWindowLayerVisible } from "../windowLayerMode.ts";
import { getAgentReplBaseUrl } from "../../utils.ts";
import {
  addWorkspaceLayoutOutput,
  assignWorkspaceLayoutOutput,
  loadLayoutSlot,
  saveLayoutSlot,
  useWorkspaceLayoutSnapshot,
} from "../workspaceLayoutStore.ts";
import { toggleSettingsWindow } from "../settingsWindowStore.ts";
import { GrabBox, type GrabBoxManipulationOptions } from "../grabbox.tsx";
import { isPointerBlockedByHost } from "./pointerFilter.ts";
import { getSetting, setSetting, useSetting } from "../../settings.ts";
import { defaultApply, type HandleState } from "@pmndrs/handle";
import { wristOffsetForHand } from "./offset.ts";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

declare module "@react-three/fiber/webgpu" {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

const CONTROLLER_UI_POSITION: [number, number, number] = [0.14, 0.0, 0.04];
/** Wrist panel bounds: the grab box, and the occluder behind it, both derive from these. */
const WRIST_UI_WIDTH = 0.528;
const WRIST_UI_HEIGHT = 0.528;
const WRIST_UI_DEPTH = 0.04;
const CONTROLLER_UI_ROTATION: [number, number, number] = [
  -1.1064536056499201,
  -0.5691113573725565,
  -1.1867850376947444,
];
/**
 * Wrist-mounted scale in XR.
 *
 * The panel is 528px square at `pixelSize` 0.001, so it measures `0.528 * scale`
 * metres on a side — 0.235 puts it at about 12.4cm, roughly a large watch face.
 * Half what it was: the previous 0.47 (~25cm) was sized against the desktop
 * preview, where the panel is head-locked at arm's length rather than strapped
 * to a wrist you have to look down at.
 *
 * The desktop HUD passes its own transform (see `desktopControlSurface.tsx`),
 * so this value only affects XR.
 */
const CONTROLLER_UI_SCALE: [number, number, number] = [0.235, 0.235, 0.235];
const WRIST_MENU_POINTER_EVENTS_ORDER = 100;

/**
 * The default mount, tuned on the right grip. Grip-space +X points into the right palm but out of
 * the left one, so the left hand mirrors it across the YZ plane: negate x, and the Y and Z Euler
 * angles.
 */
export function controllerWristTransform(
  hand: "left" | "right" | undefined,
  scale = 1,
): Required<WristMenuTransform> {
  const [x, y, z] = CONTROLLER_UI_POSITION;
  const [rx, ry, rz] = CONTROLLER_UI_ROTATION;
  const s = CONTROLLER_UI_SCALE[0] * scale;
  return hand === "left"
    ? { position: [-x, y, z], rotation: [rx, -ry, -rz], scale: [s, s, s] }
    : { position: [x, y, z], rotation: [rx, ry, rz], scale: [s, s, s] };
}

export type WristMenuTransform = {
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
};

export type WristMenuPanelProps = {
  /**
   * When set (e.g. from the controller the panel is parented to), the wrist only accepts
   * pointers from the *other* hand; the host hand’s ray/grip does not see this UI.
   */
  hostHandedness?: "left" | "right";
  /**
   * Is this panel mounted on a controller? When it is, that controller must
   * never be able to interact with it — see {@link isPointerBlockedByHost}.
   * Defaults to whether a handedness was supplied.
   */
  attachedToController?: boolean;
  transform?: WristMenuTransform;
  actorId?: string | null;
  initialState?: Partial<WristMenuStateSnapshot>;
};

function wristMenuPointerEvents(
  host: "left" | "right" | undefined,
  attached: boolean,
): AllowedPointerEventsType {
  return (_id, pointerType, st) => !isPointerBlockedByHost(pointerType, st, host, attached);
}

function isPointerEventFromHostHand(
  event: PenPointerEvent,
  host: "left" | "right" | undefined,
  attached: boolean,
): boolean {
  return isPointerBlockedByHost(event.pointerType, event.pointerState, host, attached);
}

function formatClock(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function formatDate(date: Date) {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear()).padStart(4, "0");
  return `${weekday} ${day}/${month}/${year}`;
}

function formatElapsed(startedAt: number, now: number) {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function toStateSnapshot(
  value: Partial<WristMenuStateSnapshot> | null | undefined,
): WristMenuStateSnapshot {
  const layoutActive = value?.layoutActive ?? false;
  return {
    layoutActive,
    // Enforced on the way in too: a stored state from before edit was gated (or
    // a hand-written one over the REPL) must not produce edit-without-layout.
    editActive: layoutActive && (value?.editActive ?? false),
  };
}

function applyToggle(state: WristMenuStateSnapshot, id: WristMenuButtonId): WristMenuStateSnapshot {
  switch (id) {
    case "layout": {
      // Edit mode adds manipulation *on top of* layout mode, so it cannot
      // outlive it: hiding the spatial layer hides what edit mode acts on.
      const layoutActive = !state.layoutActive;
      return { layoutActive, editActive: layoutActive && state.editActive };
    }
    case "edit":
      // Only meaningful while layout is on. The button is disabled otherwise;
      // this guard keeps that true regardless of who calls it.
      if (!state.layoutActive) return state;
      return { ...state, editActive: !state.editActive };
  }
}

async function fetchActorState(actorId: string): Promise<WristMenuStateSnapshot | null> {
  try {
    if (Deno.args.includes("--desktop-control-child")) {
      return await requestDesktopActor<WristMenuStateSnapshot>(
        actorId,
        "GETWRISTMENUSTATE",
        null,
      );
    }
    return await PostMan.PostMessage({
      target: actorId,
      type: "GETWRISTMENUSTATE",
      payload: null,
    }, true) as WristMenuStateSnapshot;
  } catch (error) {
    console.warn("[wristMenu] failed to read actor state", error);
    return null;
  }
}

async function toggleActorState(
  actorId: string,
  id: WristMenuButtonId,
): Promise<WristMenuStateSnapshot | null> {
  try {
    if (Deno.args.includes("--desktop-control-child")) {
      return await requestDesktopActor<WristMenuStateSnapshot>(
        actorId,
        "TOGGLEWRISTMENUACTION",
        id,
      );
    }
    return await PostMan.PostMessage({
      target: actorId,
      type: "TOGGLEWRISTMENUACTION",
      payload: id,
    }, true) as WristMenuStateSnapshot;
  } catch (error) {
    console.warn("[wristMenu] failed to toggle actor state", error);
    return null;
  }
}

async function requestDesktopActor<T>(
  target: string,
  type: string,
  payload: unknown,
): Promise<T> {
  const response = await fetch(`${getAgentReplBaseUrl()}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, type, payload, reply: true }),
  });
  const body = await response.json() as { ok?: boolean; error?: string; result?: T };
  if (!response.ok || body.ok !== true) {
    throw new Error(body.error ?? `Actor request failed (${response.status})`);
  }
  return body.result as T;
}

/** How far a grab on the wrist panel has to move before it counts as a drag rather than a press. */
const WRIST_DRAG_SLOP_METERS = 0.01;
const WRIST_DRAG_SLOP_RADIANS = 0.05;

export function WristMenuPanel(
  { hostHandedness, transform, actorId, initialState, attachedToController }: WristMenuPanelProps,
) {
  // Controller-mounted whenever it is rendered from `WristMenuControllerHud`,
  // which is the only caller that has a host controller. Passed explicitly
  // rather than inferred from `hostHandedness != null`, because a runtime that
  // reports handedness as "none" would otherwise read as "not attached" and
  // turn the guard off exactly when it is needed.
  const attached = attachedToController ?? hostHandedness != null;
  // Stable across the clock's per-second renders: a new filter function restyles the menu shell.
  const menuPointerType = useMemo(
    () => wristMenuPointerEvents(hostHandedness, attached),
    [hostHandedness, attached],
  );
  const startedAt = useRef(performance.now());
  const [buttonState, setButtonState] = useState(() => toStateSnapshot(initialState));
  const [now, setNow] = useState(() => Date.now());
  const workspaceLayout = useWorkspaceLayoutSnapshot();
  const opacity = useSetting("wristMenuOpacity");
  const savedOffset = useSetting("wristMenuOffset");
  const offsetHand = hostHandedness ?? "right";
  // Where the menu sits on the wrist; a desktop HUD isn't on one and stays square to the view.
  const offset = savedOffset == null || !attached
    ? null
    : wristOffsetForHand(savedOffset, offsetHand);
  const offsetRef = useRef<THREE.Group>(null);
  const dragging = useRef(false);
  /** A resize was saved to `wristMenuScale`; the grab's own scale resets when that arrives. */
  const resizeSaved = useRef(false);
  // Grabbing the panel with the other hand moves it (and its occluder) within the mount; letting
  // go saves where it ended up. Two hands don't scale it; the grabbing hand's trigger resizes it
  // (GrabBox's trigger resize), and letting go folds that into the `wristMenuScale` setting. The
  // desktop HUD isn't on a wrist and keeps the default grab.
  //
  // Every trigger click on a wrist button also reaches the handle as a grab that barely moves.
  // Until the grab passes a small slop the panel stays put, so a press neither nudges the menu by
  // the hand's jitter nor saves an offset (which would read "Position: moved").
  const grabOptions = useMemo((): GrabBoxManipulationOptions | undefined =>
    attached
      ? {
        scale: false,
        triggerResize: {},
        apply: (state: HandleState<unknown>, target: import("three").Object3D) => {
          if (state.first) dragging.current = false;
          const { position, quaternion, scale } = state.current;
          // A degenerate grab must leave the last valid transform on the live wrist mount.
          if (
            ![
              position.x,
              position.y,
              position.z,
              quaternion.x,
              quaternion.y,
              quaternion.z,
              quaternion.w,
              scale.x,
              scale.y,
              scale.z,
            ].every(Number.isFinite)
          ) return;
          const resized = Math.abs(target.scale.x - 1) > 1e-4;
          if (!dragging.current && !resized) {
            const moved = state.initial.position.distanceTo(state.current.position);
            const turned = state.initial.quaternion.angleTo(state.current.quaternion);
            if (moved < WRIST_DRAG_SLOP_METERS && turned < WRIST_DRAG_SLOP_RADIANS) return;
            dragging.current = true;
          }
          defaultApply(state, target);
          if (!state.last) return;
          let offsetPosition = target.position;
          if (resized) {
            const current = getSetting("wristMenuScale");
            const next = Math.min(2, Math.max(0.5, current * target.scale.x));
            // The offset sits inside the scaled mount: keep the panel where it is in the world.
            offsetPosition = target.position.clone().multiplyScalar(current / next);
            if (next !== current) {
              resizeSaved.current = true;
              setSetting("wristMenuScale", next);
            } else {
              target.scale.setScalar(1);
            }
          }
          setSetting(
            "wristMenuOffset",
            wristOffsetForHand({
              position: offsetPosition.toArray() as [number, number, number],
              rotation: target.quaternion.toArray() as [number, number, number, number],
            }, offsetHand),
          );
        },
      }
      : undefined, [attached, offsetHand]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!actorId) {
      setButtonState(toStateSnapshot(initialState));
      return;
    }
    void fetchActorState(actorId).then((nextState) => {
      if (!cancelled && nextState) {
        setButtonState(toStateSnapshot(nextState));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [actorId, initialState]);

  useEffect(() => {
    setToolEditMode(buttonState.editActive);
    return () => {
      setToolEditMode(false);
    };
  }, [buttonState.editActive]);

  useEffect(() => {
    setWindowLayerVisible(buttonState.layoutActive);
    return () => {
      setWindowLayerVisible(false);
    };
  }, [buttonState.layoutActive]);

  const handleToggle = useCallback((id: WristMenuButtonId) => {
    if (!actorId) {
      setButtonState((current) => applyToggle(current, id));
      return;
    }
    setButtonState((current) => applyToggle(current, id));
    void toggleActorState(actorId, id).then((nextState) => {
      if (nextState) {
        setButtonState(toStateSnapshot(nextState));
      }
    });
  }, [actorId]);

  const currentDate = React.useMemo(() => new Date(now), [now]);
  const clockLabel = React.useMemo(() => formatClock(currentDate), [currentDate]);
  const dateLabel = React.useMemo(() => formatDate(currentDate), [currentDate]);
  const elapsedLabel = React.useMemo(
    () => formatElapsed(startedAt.current, now),
    // `startedAt` is a stable ref; only the tick matters.
    [now],
  );
  const position = transform?.position ?? CONTROLLER_UI_POSITION;
  const rotation = transform?.rotation ?? CONTROLLER_UI_ROTATION;
  const scale = transform?.scale ?? CONTROLLER_UI_SCALE;
  // The mount now carries a trigger resize: drop it from the grab target in the same commit, so the
  // panel never shows both scales or neither for a frame.
  useLayoutEffect(() => {
    if (!resizeSaved.current) return;
    resizeSaved.current = false;
    offsetRef.current?.scale.setScalar(1);
  }, [scale]);

  return (
    <group
      position={position}
      rotation={rotation}
      scale={scale}
      {...({ pointerEventsOrder: WRIST_MENU_POINTER_EVENTS_ORDER } as Record<string, unknown>)}
    >
      <group
        ref={offsetRef}
        position={offset?.position ?? [0, 0, 0]}
        quaternion={offset?.rotation ?? [0, 0, 0, 1]}
        // The panel's own frame: desktop views put it at the HUD transform (`hud.ts`), without
        // the wrist offset, as the raylib desktop HUD does.
        userData={{ wristMenuMount: true }}
      >
        {typeof Deno !== "undefined" && Deno.args.includes("--wrist-motion-probe") && attached && (
          <mesh
            position={[-0.20, 0.20, 0.03]}
            userData={{ raythreeHudOverUi: true }}
            {...({ pointerEvents: "none" } as Record<string, unknown>)}
          >
            <planeGeometry args={[0.10, 0.10]} />
            <meshBasicMaterial
              color={0xff00ff}
              side={THREE.DoubleSide}
              depthTest={false}
              depthWrite={false}
            />
          </mesh>
        )}
        <group userData={{ bridge: { kind: "skip" }, wristMenuActor: actorId ?? null }}>
          <GrabBox
            manipulationTargetRef={attached ? offsetRef : undefined}
            manipulationOptions={grabOptions}
            width={WRIST_UI_WIDTH}
            height={WRIST_UI_HEIGHT}
            depth={WRIST_UI_DEPTH}
            visibleChrome={false}
            shellRayPickable={false}
            interactionHullFilter={(_id, pointerType, pointerState) =>
              !isPointerBlockedByHost(pointerType, pointerState, hostHandedness, attached)}
            grabFilter={(e: PenPointerEvent) =>
              // The trigger ray presses the menu's controls; only squeeze grabs.
              e.pointerType !== "ray" &&
              e.pointerType !== "poker" &&
              (!e.pointerType.startsWith("screen-") || e.button === 0) &&
              !isPointerEventFromHostHand(e, hostHandedness, attached)}
          >
            <WristMenuUi
              clock={clockLabel}
              dateLabel={dateLabel}
              elapsed={elapsedLabel}
              layoutActive={buttonState.layoutActive}
              editActive={buttonState.editActive}
              onToggle={handleToggle}
              onRecenter={requestLayoutRecenter}
              workspaceLayout={workspaceLayout}
              onAssignOutput={assignWorkspaceLayoutOutput}
              onAddOutput={addWorkspaceLayoutOutput}
              onSaveLayout={saveLayoutSlot}
              onLoadLayout={loadLayoutSlot}
              onOpenSettingsWindow={toggleSettingsWindow}
              pointerEventsType={menuPointerType}
            />
          </GrabBox>
        </group>
        {
          /*
           * Depth-only occluder, the pattern displays and the keyboard use: it paints depth and no
           * colour, drawn first, so whatever is depth-tested behind the wrist panel — the controller
           * model, a hand, another object's chrome — is hidden by it. Not pickable: the menu's own
           * surfaces own pointer input.
           *
           * Deliberately a sibling of the `bridge: { kind: "skip" }` group rather than a child of it:
           * that flag skips an entire subtree from the raylib IR (the menu's visuals travel in the
           * uikit payload instead), so an occluder inside it would never reach the overlay.
           *
           * Left out when the menu is faded, or it would hide what should show through.
           */
        }
        {opacity >= 1 && (
          <mesh
            position={[0, 0, -WRIST_UI_DEPTH / 2]}
            renderOrder={-100}
            {...({ pointerEvents: "none" } as Record<string, unknown>)}
          >
            <planeGeometry args={[WRIST_UI_WIDTH, WRIST_UI_HEIGHT]} />
            <meshBasicMaterial
              depthTest
              depthWrite
              colorWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
        )}
      </group>
    </group>
  );
}

export function WristMenuControllerHud({ actorId }: { actorId?: string | null }) {
  const xrState = useXRInputSourceStateContext();
  const h = xrState.inputSource.handedness;
  const hostHandedness: "left" | "right" | undefined = h === "left" || h === "right"
    ? h
    : undefined;
  const scale = useSetting("wristMenuScale");
  const transform = React.useMemo(
    () => controllerWristTransform(hostHandedness, scale),
    [hostHandedness, scale],
  );
  return (
    <>
      <PetplayDefaultXRController
        model={false}
        rayPointer={{
          minDistance: -1,
        }}
      />
      <XRSpace space="grip-space">
        <group
          userData={{ renderTrackingAnchor: hostHandedness ? `${hostHandedness}-hand` : undefined }}
        >
          <WristMenuPanel
            hostHandedness={hostHandedness}
            transform={transform}
            attachedToController
            actorId={actorId}
          />
        </group>
      </XRSpace>
    </>
  );
}
