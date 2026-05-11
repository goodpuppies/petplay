import React, { useCallback, useEffect, useRef, useState } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { extend, ThreeToJSXElements } from "@react-three/fiber/webgpu";
import { Handle } from "@react-three/handle";
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
import { setControllerLaserEnabled } from "../controllerLaserMode.ts";

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
const CONTROLLER_UI_SCALE: [number, number, number] = [0.47, 0.47, 0.47];

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
  transform?: WristMenuTransform;
  actorId?: string | null;
  initialState?: Partial<WristMenuStateSnapshot>;
};

function wristMenuPointerEventsForHost(
  host: "left" | "right",
): AllowedPointerEventsType {
  return (_id, _pointerType, st) => !isPointerStateFromHostHand(st, host);
}

function isPointerStateFromHostHand(
  pointerState: unknown,
  host: "left" | "right",
): boolean {
  if (
    pointerState == null || typeof pointerState !== "object" || !("inputSource" in pointerState)
  ) {
    return false;
  }
  const h = (pointerState as { inputSource?: { handedness?: XRHandedness } }).inputSource
    ?.handedness;
  return h === host;
}

function isPointerEventFromHostHand(
  event: PenPointerEvent,
  host: "left" | "right" | undefined,
): boolean {
  return host != null && isPointerStateFromHostHand(event.pointerState, host);
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
  return {
    layersActive: value?.layersActive ?? false,
    musicActive: value?.musicActive ?? false,
    signalActive: value?.signalActive ?? false,
  };
}

function applyToggle(state: WristMenuStateSnapshot, id: WristMenuButtonId): WristMenuStateSnapshot {
  switch (id) {
    case "layers":
      return { ...state, layersActive: !state.layersActive };
    case "music":
      return { ...state, musicActive: !state.musicActive };
    case "signal":
      return { ...state, signalActive: !state.signalActive };
  }
}

async function fetchActorState(actorId: string): Promise<WristMenuStateSnapshot | null> {
  try {
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

export function WristMenuPanel(
  { hostHandedness, transform, actorId, initialState }: WristMenuPanelProps,
) {
  const menuPointerType = hostHandedness != null
    ? wristMenuPointerEventsForHost(hostHandedness)
    : "all" satisfies AllowedPointerEventsType;
  const startedAt = useRef(performance.now());
  const [buttonState, setButtonState] = useState(() => toStateSnapshot(initialState));
  const [now, setNow] = useState(() => Date.now());

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
    setToolEditMode(buttonState.musicActive);
    return () => {
      setToolEditMode(false);
    };
  }, [buttonState.musicActive]);

  useEffect(() => {
    setControllerLaserEnabled(!buttonState.layersActive);
    return () => {
      setControllerLaserEnabled(true);
    };
  }, [buttonState.layersActive]);

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

  const currentDate = new Date(now);
  const position = transform?.position ?? CONTROLLER_UI_POSITION;
  const rotation = transform?.rotation ?? CONTROLLER_UI_ROTATION;
  const scale = transform?.scale ?? CONTROLLER_UI_SCALE;

  return (
    <group
      position={position}
      rotation={rotation}
      scale={scale}
      userData={{ bridge: { kind: "skip" }, wristMenuActor: actorId ?? null }}
    >
      <Handle
        filter={(e: PenPointerEvent) =>
          e.pointerType !== "poker" && !isPointerEventFromHostHand(e, hostHandedness)}
      >
        <WristMenuUi
          clock={formatClock(currentDate)}
          dateLabel={formatDate(currentDate)}
          elapsed={formatElapsed(startedAt.current, now)}
          layersActive={buttonState.layersActive}
          musicActive={buttonState.musicActive}
          signalActive={buttonState.signalActive}
          onToggle={handleToggle}
          pointerEventsType={menuPointerType}
        />
      </Handle>
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
        <WristMenuPanel hostHandedness={hostHandedness} actorId={actorId} />
      </XRSpace>
    </>
  );
}
