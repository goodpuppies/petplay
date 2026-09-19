import React, { useCallback, useEffect, useRef, useState } from "react";
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
import { setWindowLayerVisible } from "../windowLayerMode.ts";
import {
  addWorkspaceLayoutOutput,
  assignWorkspaceLayoutOutput,
  useWorkspaceLayoutSnapshot,
} from "../workspaceLayoutStore.ts";
import { GrabBox } from "../grabbox.tsx";
import { isPointerBlockedByHost } from "./pointerFilter.ts";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

declare module "@react-three/fiber/webgpu" {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

const CONTROLLER_UI_POSITION: [number, number, number] = [0.14, 0.0, 0.04];
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
  const response = await fetch("http://127.0.0.1:3987/message", {
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

export function WristMenuPanel(
  { hostHandedness, transform, actorId, initialState, attachedToController }: WristMenuPanelProps,
) {
  // Controller-mounted whenever it is rendered from `WristMenuControllerHud`,
  // which is the only caller that has a host controller. Passed explicitly
  // rather than inferred from `hostHandedness != null`, because a runtime that
  // reports handedness as "none" would otherwise read as "not attached" and
  // turn the guard off exactly when it is needed.
  const attached = attachedToController ?? hostHandedness != null;
  const menuPointerType = wristMenuPointerEvents(hostHandedness, attached);
  const startedAt = useRef(performance.now());
  const [buttonState, setButtonState] = useState(() => toStateSnapshot(initialState));
  const [now, setNow] = useState(() => Date.now());
  const workspaceLayout = useWorkspaceLayoutSnapshot();

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

  return (
    <group
      position={position}
      rotation={rotation}
      scale={scale}
      userData={{ bridge: { kind: "skip" }, wristMenuActor: actorId ?? null }}
      {...({ pointerEventsOrder: WRIST_MENU_POINTER_EVENTS_ORDER } as Record<string, unknown>)}
    >
      <GrabBox
        width={0.528}
        height={0.528}
        depth={0.04}
        visibleChrome={false}
        shellRayPickable={false}
        interactionHullFilter={(_id, pointerType, pointerState) =>
          !isPointerBlockedByHost(pointerType, pointerState, hostHandedness, attached)}
        grabFilter={(e: PenPointerEvent) =>
          e.pointerType !== "poker" &&
          !isPointerEventFromHostHand(e, hostHandedness, attached)}
      >
        <WristMenuUi
          clock={clockLabel}
          dateLabel={dateLabel}
          elapsed={elapsedLabel}
          layoutActive={buttonState.layoutActive}
          editActive={buttonState.editActive}
          onToggle={handleToggle}
          workspaceLayout={workspaceLayout}
          onAssignOutput={assignWorkspaceLayoutOutput}
          onAddOutput={addWorkspaceLayoutOutput}
          pointerEventsType={menuPointerType}
        />
      </GrabBox>
    </group>
  );
}

export function WristMenuControllerHud({ actorId }: { actorId?: string | null }) {
  const xrState = useXRInputSourceStateContext();
  const h = xrState.inputSource.handedness;
  const hostHandedness: "left" | "right" | undefined = h === "left" || h === "right"
    ? h
    : undefined;
  return (
    <>
      <PetplayDefaultXRController
        model={false}
        rayPointer={{
          minDistance: -1,
        }}
      />
      <XRSpace space="grip-space">
        <WristMenuPanel
          hostHandedness={hostHandedness}
          attachedToController
          actorId={actorId}
        />
      </XRSpace>
    </>
  );
}
