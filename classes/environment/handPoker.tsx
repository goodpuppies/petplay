import React, { useEffect, useRef } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { extend, type ThreeToJSXElements, useFrame } from "@react-three/fiber/webgpu";
import { Handle } from "@react-three/handle";
import { useTouchPointer, useXRInputSourceStateContext, XRSpace } from "@pmndrs/xr";
import { GrabBox } from "./grabbox.tsx";
import { useToolEditMode } from "./toolEditMode.ts";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

declare module "@react-three/fiber/webgpu" {
  // deno-lint-ignore no-empty-interface
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

const DEFAULT_POKER_POSITION: [number, number, number] = [0, -0.025, -0.095];
const POKER_RADIUS = 0.012;
const POKER_HOVER_RADIUS = 0.04;
const POKER_PRESS_RADIUS = 0.010;
const POKER_RELEASE_RADIUS = 0.020;
const POKER_REARM_MS = 140;
const POKER_GRABBOX_SIZE = 0.075;

type PokerButtonHandler = (nativeEvent: { timeStamp: number; button: number }) => void;

function PokerBall() {
  return (
    <mesh
      renderOrder={30000}
      userData={{ handPokerBall: true, raythreeHudOverUi: true }}
      {...({ pointerEvents: "none" } as Record<string, unknown>)}
    >
      <sphereGeometry args={[POKER_RADIUS, 16, 12]} />
      <meshBasicMaterial
        color={0xffd166}
        transparent
        opacity={0.85}
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  );
}

export function HandPoker() {
  const state = useXRInputSourceStateContext();
  const toolEditActive = useToolEditMode();
  const pokerRef = useRef<THREE.Group | null>(null);
  const pressedRef = useRef(false);
  const nextPressAllowedAtRef = useRef(0);
  const originalDownRef = useRef<PokerButtonHandler | null>(null);
  const originalUpRef = useRef<PokerButtonHandler | null>(null);
  const pointer = useTouchPointer(
    pokerRef as React.RefObject<import("three").Object3D | null>,
    state,
    {
      hoverRadius: POKER_HOVER_RADIUS,
      downRadius: POKER_PRESS_RADIUS,
      button: 0,
      clickThresholdMs: 450,
    },
    "poker",
  );

  useEffect(() => {
    pokerRef.current?.position.set(...DEFAULT_POKER_POSITION);
  }, []);

  useEffect(() => {
    const originalDown = pointer.down.bind(pointer);
    const originalUp = pointer.up.bind(pointer);
    originalDownRef.current = originalDown;
    originalUpRef.current = originalUp;

    pointer.down = ((nativeEvent) => {
      const now = nativeEvent.timeStamp ?? performance.now();
      if (pressedRef.current || now < nextPressAllowedAtRef.current) {
        return;
      }
      pressedRef.current = true;
      originalDown(nativeEvent);
    }) as typeof pointer.down;

    pointer.up = (() => {
      // Release is handled with hysteresis in `useFrame`; the default touch pointer's single
      // threshold is too jittery near key edges.
    }) as typeof pointer.up;

    return () => {
      pointer.down = originalDown;
      pointer.up = originalUp;
      originalDownRef.current = null;
      originalUpRef.current = null;
      pressedRef.current = false;
    };
  }, [pointer]);

  useFrame(() => {
    const now = performance.now();
    if (toolEditActive) {
      if (pressedRef.current) {
        pressedRef.current = false;
        nextPressAllowedAtRef.current = now + POKER_REARM_MS;
        originalUpRef.current?.({ timeStamp: now, button: 0 });
      }
      pointer.setEnabled(false);
      return;
    }
    pointer.setEnabled(true);
    if (!pressedRef.current) {
      return;
    }
    const intersection = pointer.getIntersection();
    if (
      intersection == null ||
      intersection.object.isVoidObject === true ||
      intersection.distance > POKER_RELEASE_RADIUS
    ) {
      pressedRef.current = false;
      nextPressAllowedAtRef.current = now + POKER_REARM_MS;
      originalUpRef.current?.({ timeStamp: now, button: 0 });
    }
  });

  return (
    <XRSpace space="grip-space">
      <Handle
        handleRef={pokerRef as unknown as React.RefObject<import("three").Object3D | null>}
        multitouch
        scale={false}
        rotate={false}
        filter={(e) => toolEditActive && e.pointerType !== "poker"}
      >
        <group ref={pokerRef} userData={{ handPoker: true }}>
          <GrabBox
            width={POKER_GRABBOX_SIZE}
            height={POKER_GRABBOX_SIZE}
            depth={POKER_GRABBOX_SIZE}
            lineColor={0xffd166}
            shellRayPickable={toolEditActive}
            interactionHull={toolEditActive}
            visibleChrome={toolEditActive}
          >
            <PokerBall />
          </GrabBox>
        </group>
      </Handle>
    </XRSpace>
  );
}
