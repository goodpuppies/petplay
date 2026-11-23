/**
 * FloatingWindow: a draggable, resizable, z-layered window panel that displays any `feedId`
 * (with optional `crop`) and routes pointer, wheel, and keyboard input to its owning machine.
 *
 * Z-layering within a window's allocated z-band (`zBase`):
 * - `zBase + 0`: uikit window frame & titlebar
 * - `zBase + 1`: `videoSurface` quad
 * - `zBase + 2`: invisible hit-test plane for video pointer/wheel input
 * - `zBase + 3`: bottom-right resize grip
 */
import React, { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber/webgpu";
import { Container, Text } from "../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import type { VideoSurfaceMarker } from "../../classes/sceneStoreWriter.ts";
import { useTabSize } from "../classes/browserTab.ts";
import type { FeedCrop } from "../classes/tabProtocol.ts";
import type { InputEvent } from "../desktopInput.ts";
import { scanCode } from "../classes/scanCodes.ts";

export const WINDOW_TITLEBAR_HEIGHT = 32;
const MIN_WINDOW_WIDTH = 280;
const MIN_WINDOW_HEIGHT = 180;
const RESIZE_HANDLE_SIZE = 18;
const BUTTONS = ["left", "middle", "right"] as const;
const FULL_CROP: FeedCrop = { x: 0, y: 0, width: 1, height: 1 };

export type FloatingWindowData = {
  id: string;
  feedId: string;
  title: string;
  machine: string;
  app?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  muted: boolean;
  crop?: FeedCrop;
  /** Native pixel size of this window's content (used for aspect-fitting without stretching). */
  srcSize?: { width: number; height: number };
};

export type FloatingWindowProps = {
  window: FloatingWindowData;
  /** World Z base for this window (e.g. `10 + stackIndex * 10`). */
  zBase: number;
  focused: boolean;
  hasFeed: boolean;
  hasAudio?: boolean;
  onFocus: () => void;
  onMove: (x: number, y: number, width: number, height: number) => void;
  onResizeEnd?: (width: number, height: number) => void;
  onMinimize: () => void;
  onMuteToggle: () => void;
  onClose: () => void;
  onInput: (event: InputEvent) => void;
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const MACHINE_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#a855f7", "#ec4899", "#06b6d4"];
function machineColor(machine: string): string {
  let hash = 0;
  for (let i = 0; i < machine.length; i++) hash = (hash * 31 + machine.charCodeAt(i)) | 0;
  return MACHINE_COLORS[Math.abs(hash) % MACHINE_COLORS.length]!;
}

export function FloatingWindow({
  window: win,
  zBase,
  focused,
  hasFeed,
  hasAudio = false,
  onFocus,
  onMove,
  onResizeEnd,
  onMinimize,
  onMuteToggle,
  onClose,
  onInput,
}: FloatingWindowProps) {
  const tab = useTabSize();
  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const crop = win.crop ?? FULL_CROP;
  const marker = useMemo<VideoSurfaceMarker>(
    () => ({ feed: win.feedId, geometry, crop, opacity: 1 }),
    [win.feedId, geometry, crop.x, crop.y, crop.width, crop.height],
  );

  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;
  const heldKeys = useRef(new Set<string>());

  // Drag / resize tracking refs.
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null,
  );
  const resizeRef = useRef<
    { startX: number; startY: number; origW: number; origH: number } | null
  >(null);

  // Release held keys when unfocused or unmounted.
  useEffect(() => {
    if (!focused && heldKeys.current.size > 0) {
      for (const scan of heldKeys.current) onInputRef.current({ t: "key", scan, down: false });
      heldKeys.current.clear();
    }
  }, [focused]);

  useEffect(() => {
    const onKey = (event: Event) => {
      if (!focusedRef.current) return;
      const { type, code } = event as Event & { code: string };
      const scan = scanCode(code);
      if (!scan) return;
      const down = type === "keydown";
      if (down) heldKeys.current.add(scan);
      else heldKeys.current.delete(scan);
      onInputRef.current({ t: "key", scan, down });
    };
    globalThis.addEventListener("keydown", onKey);
    globalThis.addEventListener("keyup", onKey);
    return () => {
      globalThis.removeEventListener("keydown", onKey);
      globalThis.removeEventListener("keyup", onKey);
      for (const scan of heldKeys.current) onInputRef.current({ t: "key", scan, down: false });
      heldKeys.current.clear();
    };
  }, []);

  if (win.minimized) return null;

  const contentH = Math.max(40, win.height - WINDOW_TITLEBAR_HEIGHT);
  const availW = Math.max(16, win.width - 2);
  const availH = Math.max(16, contentH - 2);
  // Aspect-fit the video inside the window content area when native size is known, so
  // windows never stretch across mismatched remote/host monitor aspect ratios.
  let fitW = availW;
  let fitH = availH;
  if (win.srcSize && win.srcSize.width > 0 && win.srcSize.height > 0) {
    const aspect = win.srcSize.width / win.srcSize.height;
    if (availW / availH > aspect) {
      fitH = availH;
      fitW = availH * aspect;
    } else {
      fitW = availW;
      fitH = availW / aspect;
    }
  }
  const fitLeft = win.x + 1 + (availW - fitW) / 2;
  const fitTop = win.y + WINDOW_TITLEBAR_HEIGHT + 1 + (availH - fitH) / 2;

  // Orthographic center coordinates: (0,0) is tab center, +Y is up.
  const frameCx = win.x + win.width / 2 - tab.width / 2;
  const frameCy = tab.height / 2 - (win.y + win.height / 2);
  const videoCx = fitLeft + fitW / 2 - tab.width / 2;
  const videoCy = tab.height / 2 - (fitTop + fitH / 2);
  const gripCx = win.x + win.width - RESIZE_HANDLE_SIZE / 2 - tab.width / 2;
  const gripCy = tab.height / 2 - (win.y + win.height - RESIZE_HANDLE_SIZE / 2);

  const toWindow = (event: ThreeEvent<PointerEvent | WheelEvent>) => {
    const native = event.nativeEvent as unknown as { offsetX: number; offsetY: number };
    onInputRef.current({
      t: "pointer",
      x: clamp01((native.offsetX - fitLeft) / fitW),
      y: clamp01((native.offsetY - fitTop) / fitH),
    });
  };

  const badgeBg = machineColor(win.machine);

  return (
    <>
      {/* Window chrome + titlebar at zBase */}
      <group position={[frameCx, frameCy, zBase]}>
        <Container
          sizeX={win.width}
          sizeY={win.height}
          pixelSize={1}
          width={win.width}
          height={win.height}
          flexDirection="column"
          backgroundColor="#181c24"
          borderWidth={focused ? 2 : 1}
          borderColor={focused ? "#60a5fa" : "#2f3747"}
          borderRadius={8}
        >
          {/* Draggable titlebar */}
          <Container
            height={WINDOW_TITLEBAR_HEIGHT}
            flexShrink={0}
            flexDirection="row"
            alignItems="center"
            paddingX={8}
            gap={8}
            backgroundColor={focused ? "#232a38" : "#1b202b"}
            borderTopLeftRadius={7}
            borderTopRightRadius={7}
            onPointerDown={(event) => {
              event.stopPropagation();
              onFocus();
              const native = event.nativeEvent as unknown as { offsetX: number; offsetY: number };
              (event.target as unknown as { setPointerCapture(id: number): void })
                .setPointerCapture(event.pointerId);
              dragRef.current = {
                startX: native.offsetX,
                startY: native.offsetY,
                origX: win.x,
                origY: win.y,
              };
            }}
            onPointerMove={(event) => {
              if (!dragRef.current) return;
              event.stopPropagation();
              const native = event.nativeEvent as unknown as { offsetX: number; offsetY: number };
              const nx = Math.max(
                -win.width + 80,
                Math.min(tab.width - 80, dragRef.current.origX + (native.offsetX - dragRef.current.startX)),
              );
              const ny = Math.max(
                0,
                Math.min(tab.height - 80, dragRef.current.origY + (native.offsetY - dragRef.current.startY)),
              );
              onMove(Math.round(nx), Math.round(ny), win.width, win.height);
            }}
            onPointerUp={(event) => {
              if (!dragRef.current) return;
              event.stopPropagation();
              dragRef.current = null;
              (event.target as unknown as { releasePointerCapture(id: number): void })
                .releasePointerCapture(event.pointerId);
            }}
          >
            <Container
              paddingX={6}
              paddingY={2}
              borderRadius={4}
              backgroundColor={badgeBg}
            >
              <Text fontSize={11} color="#ffffff">{win.machine}</Text>
            </Container>
            <Container flexGrow={1} overflow="hidden">
              <Text fontSize={12} color={focused ? "#f1f5f9" : "#94a3b8"}>
                {win.title.slice(0, 42)}
              </Text>
            </Container>
            {/* Mute toggle (only shown when the source advertises audio) */}
            {hasAudio
              ? (
                <Container
                  paddingX={6}
                  height={22}
                  borderRadius={4}
                  backgroundColor={win.muted ? "#334155" : "#262f3f"}
                  alignItems="center"
                  justifyContent="center"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onMuteToggle();
                  }}
                >
                  <Text fontSize={10} color={win.muted ? "#f87171" : "#cbd5e1"}>
                    {win.muted ? "Muted" : "Audio"}
                  </Text>
                </Container>
              )
              : null}
            {/* Minimize */}
            <Container
              width={22}
              height={22}
              borderRadius={4}
              backgroundColor="#262f3f"
              alignItems="center"
              justifyContent="center"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onMinimize();
              }}
            >
              <Text fontSize={12} color="#cbd5e1">_</Text>
            </Container>
            {/* Close */}
            <Container
              width={22}
              height={22}
              borderRadius={4}
              backgroundColor="#7f1d1d"
              alignItems="center"
              justifyContent="center"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
            >
              <Text fontSize={12} color="#fecaca">x</Text>
            </Container>
          </Container>

          {/* Placeholder behind video while connecting */}
          <Container flexGrow={1} alignItems="center" justifyContent="center">
            {!hasFeed
              ? <Text fontSize={13} color="#64748b">Connecting video...</Text>
              : null}
          </Container>
        </Container>
      </group>

      {/* Video surface at zBase + 1 */}
      {hasFeed
        ? (
          <group
            position={[videoCx, videoCy, zBase + 1]}
            scale={[fitW, fitH, 1]}
            userData={{ videoSurface: marker }}
          />
        )
        : null}

      {/* Invisible hit-test plane for video pointer/wheel input at zBase + 2 */}
      <mesh
        position={[videoCx, videoCy, zBase + 2]}
        scale={[fitW, fitH, 1]}
        userData={{ bridge: { kind: "skip" } }}
        onPointerMove={(event) => {
          event.stopPropagation();
          toWindow(event);
        }}
        onPointerDown={(event) => {
          event.stopPropagation();
          focusedRef.current = true;
          onFocus();
          (event.target as unknown as { setPointerCapture(id: number): void })
            .setPointerCapture(event.pointerId);
          toWindow(event);
          const button = BUTTONS[event.button];
          if (button) onInputRef.current({ t: "button", button, down: true });
        }}
        onPointerUp={(event) => {
          event.stopPropagation();
          (event.target as unknown as { releasePointerCapture(id: number): void })
            .releasePointerCapture(event.pointerId);
          toWindow(event);
          const button = BUTTONS[event.button];
          if (button) onInputRef.current({ t: "button", button, down: false });
        }}
        onWheel={(event) => {
          event.stopPropagation();
          const deltaY = (event.nativeEvent as WheelEvent).deltaY;
          if (!deltaY) return;
          toWindow(event);
          const notches = Math.max(1, Math.round(Math.abs(deltaY) / 100));
          onInputRef.current({ t: "wheel", delta: deltaY > 0 ? notches : -notches });
        }}
      >
        <primitive object={geometry} attach="geometry" />
        <meshBasicMaterial visible={false} />
      </mesh>

      {/* Bottom-right resize grip at zBase + 3 */}
      <group position={[gripCx, gripCy, zBase + 3]}>
        <Container
          sizeX={RESIZE_HANDLE_SIZE}
          sizeY={RESIZE_HANDLE_SIZE}
          pixelSize={1}
          width={RESIZE_HANDLE_SIZE}
          height={RESIZE_HANDLE_SIZE}
          backgroundColor={focused ? "#3b82f6" : "#334155"}
          borderTopLeftRadius={4}
          borderBottomRightRadius={7}
          onPointerDown={(event) => {
            event.stopPropagation();
            onFocus();
            const native = event.nativeEvent as unknown as { offsetX: number; offsetY: number };
            (event.target as unknown as { setPointerCapture(id: number): void })
              .setPointerCapture(event.pointerId);
            resizeRef.current = {
              startX: native.offsetX,
              startY: native.offsetY,
              origW: win.width,
              origH: win.height,
            };
          }}
          onPointerMove={(event) => {
            if (!resizeRef.current) return;
            event.stopPropagation();
            const native = event.nativeEvent as unknown as { offsetX: number; offsetY: number };
            const nw = Math.max(
              MIN_WINDOW_WIDTH,
              resizeRef.current.origW + (native.offsetX - resizeRef.current.startX),
            );
            const nh = Math.max(
              MIN_WINDOW_HEIGHT,
              resizeRef.current.origH + (native.offsetY - resizeRef.current.startY),
            );
            onMove(win.x, win.y, Math.round(nw), Math.round(nh));
          }}
          onPointerUp={(event) => {
            if (!resizeRef.current) return;
            event.stopPropagation();
            const native = event.nativeEvent as unknown as { offsetX: number; offsetY: number };
            const finalW = Math.round(
              Math.max(
                MIN_WINDOW_WIDTH,
                resizeRef.current.origW + (native.offsetX - resizeRef.current.startX),
              ),
            );
            const finalH = Math.round(
              Math.max(
                MIN_WINDOW_HEIGHT,
                resizeRef.current.origH + (native.offsetY - resizeRef.current.startY),
              ),
            );
            resizeRef.current = null;
            (event.target as unknown as { releasePointerCapture(id: number): void })
              .releasePointerCapture(event.pointerId);
            onMove(win.x, win.y, finalW, finalH);
            onResizeEnd?.(finalW, finalH);
          }}
        />
      </group>
    </>
  );
}
