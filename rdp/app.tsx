/**
 * The remote desktop app, as a page in a headless browser tab (`classes/browserTab.ts`): a
 * toolbar and the desktop's video below it, fitted to its aspect. 2D uikit in CSS pixels; the tab
 * draws it from the scene store, and the same tree can later sit on a panel in VR.
 *
 * Input: pointer and wheel events over the video become desktopInput events, mapped through the
 * video's rectangle in tab pixels (so a drag that leaves the video keeps tracking, clamped). A
 * press on the video focuses it: keys then go to the desktop, by physical key, until the toolbar
 * is clicked.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber/webgpu";
import { Container, Text } from "../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import type { VideoSurfaceMarker } from "../classes/sceneStoreWriter.ts";
import { TabBody, useTabSize } from "./classes/browserTab.ts";
import { scanCode } from "./classes/scanCodes.ts";
import type { InputEvent } from "./desktopInput.ts";

export const TOOLBAR_HEIGHT = 44;
export const DESKTOP_FEED = "desktop";
const BUTTONS = ["left", "middle", "right"] as const;

export type DesktopInputSink = { send(event: InputEvent): void };

export type RdpAppProps = {
  /** Where input goes; null shows the desktop without control. */
  input: DesktopInputSink | null;
  /** The feed's intrinsic size once the tab knows it; null until the desktop feed is up. */
  feed: { width: number; height: number } | null;
  status: string;
  /** Desktops to pick from (more than one shows a picker). */
  desktops?: Array<{ id: string; label: string }>;
  selected?: string | null;
  onSelect?: (id: string) => void;
};

/** Where the video sits in tab pixels: the area below the toolbar, fitted to the feed's aspect. */
export function videoRect(
  tab: { width: number; height: number },
  feed: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const areaW = tab.width;
  const areaH = Math.max(1, tab.height - TOOLBAR_HEIGHT);
  const aspect = feed.width / feed.height;
  const width = areaW / areaH > aspect ? areaH * aspect : areaW;
  const height = width / aspect;
  return { x: (areaW - width) / 2, y: TOOLBAR_HEIGHT + (areaH - height) / 2, width, height };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function RdpApp(
  { input, feed, status, desktops = [], selected = null, onSelect }: RdpAppProps,
) {
  const tab = useTabSize();
  // The ref is what key handling reads: it changes at once, while state waits for a render.
  const [focused, setFocused] = useState(false);
  const focusedRef = useRef(false);
  const inputRef = useRef(input);
  inputRef.current = input;
  const heldKeys = useRef(new Set<string>());

  const rect = feed ? videoRect(tab, feed) : null;
  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const marker = useMemo<VideoSurfaceMarker>(() => ({
    feed: DESKTOP_FEED,
    geometry,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    opacity: 1,
  }), [geometry]);

  // Keys go to the desktop while the video is focused, like a page with a focused element.
  useEffect(() => {
    const onKey = (event: Event) => {
      if (!focusedRef.current) return;
      const { type, code } = event as Event & { code: string };
      const scan = scanCode(code);
      if (!scan) return;
      const down = type === "keydown";
      if (down) heldKeys.current.add(scan);
      else heldKeys.current.delete(scan);
      inputRef.current?.send({ t: "key", scan, down });
    };
    globalThis.addEventListener("keydown", onKey);
    globalThis.addEventListener("keyup", onKey);
    return () => {
      globalThis.removeEventListener("keydown", onKey);
      globalThis.removeEventListener("keyup", onKey);
    };
  }, []);

  const unfocus = () => {
    if (!focusedRef.current) return;
    focusedRef.current = false;
    setFocused(false);
    for (const scan of heldKeys.current) inputRef.current?.send({ t: "key", scan, down: false });
    heldKeys.current.clear();
  };

  const toDesktop = (event: ThreeEvent<PointerEvent | WheelEvent>) => {
    const native = event.nativeEvent as unknown as { offsetX: number; offsetY: number };
    if (!rect) return;
    inputRef.current?.send({
      t: "pointer",
      x: clamp01((native.offsetX - rect.x) / rect.width),
      y: clamp01((native.offsetY - rect.y) / rect.height),
    });
  };

  // Tab pixels to the orthographic world: the camera looks at the tab's center.
  const center = rect
    ? [rect.x + rect.width / 2 - tab.width / 2, tab.height / 2 - (rect.y + rect.height / 2)]
    : [0, 0];

  return (
    <>
      <TabBody flexDirection="column">
        <Container
          height={TOOLBAR_HEIGHT}
          flexShrink={0}
          flexDirection="row"
          alignItems="center"
          paddingX={14}
          gap={14}
          backgroundColor="#1f232b"
          onClick={unfocus}
        >
          {desktops.length > 1
            ? desktops.map((desktop) => (
              <Container
                key={desktop.id}
                paddingX={10}
                paddingY={5}
                borderRadius={6}
                backgroundColor={desktop.id === selected ? "#3b4252" : "#2a2f39"}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect?.(desktop.id);
                }}
              >
                <Text fontSize={14} color={desktop.id === selected ? "#e8ebf1" : "#9aa3b2"}>
                  {desktop.label}
                </Text>
              </Container>
            ))
            : (
              <Text fontSize={16} color="#e8ebf1">
                {desktops[0]?.label ?? "Desktop"}
              </Text>
            )}
          <Text fontSize={13} color="#9aa3b2">{status}</Text>
          <Container flexGrow={1} />
          <Text fontSize={13} color={focused ? "#8fd18f" : "#9aa3b2"}>
            {focused ? "keyboard -> desktop" : input ? "click the desktop to type" : "view only"}
          </Text>
        </Container>
        {!rect
          ? (
            <Container flexGrow={1} alignItems="center" justifyContent="center">
              <Text fontSize={15} color="#9aa3b2">Waiting for the desktop feed...</Text>
            </Container>
          )
          : null}
      </TabBody>
      {rect
        ? (
          <>
            <group
              position={[center[0], center[1], 1]}
              scale={[rect.width, rect.height, 1]}
              userData={{ videoSurface: marker }}
            />
            <mesh
              position={[center[0], center[1], 2]}
              scale={[rect.width, rect.height, 1]}
              // Only for hit testing: the scene bridge must not ship it (it ignores
              // material.visible, and would draw a white quad over the video).
              userData={{ bridge: { kind: "skip" } }}
              onPointerMove={toDesktop}
              onPointerDown={(event) => {
                (event.target as unknown as { setPointerCapture(id: number): void })
                  .setPointerCapture(event.pointerId);
                focusedRef.current = true;
                setFocused(true);
                toDesktop(event);
                const button = BUTTONS[event.button];
                if (button) inputRef.current?.send({ t: "button", button, down: true });
              }}
              onPointerUp={(event) => {
                (event.target as unknown as { releasePointerCapture(id: number): void })
                  .releasePointerCapture(event.pointerId);
                toDesktop(event);
                const button = BUTTONS[event.button];
                if (button) inputRef.current?.send({ t: "button", button, down: false });
              }}
              onWheel={(event) => {
                const deltaY = (event.nativeEvent as WheelEvent).deltaY;
                if (!deltaY) return;
                toDesktop(event);
                // A wheel notch is ~100 px; positive scrolls down, as in the DOM.
                const notches = Math.max(1, Math.round(Math.abs(deltaY) / 100));
                inputRef.current?.send({ t: "wheel", delta: deltaY > 0 ? notches : -notches });
              }}
            >
              <primitive object={geometry} attach="geometry" />
              <meshBasicMaterial visible={false} />
            </mesh>
          </>
        )
        : null}
    </>
  );
}
