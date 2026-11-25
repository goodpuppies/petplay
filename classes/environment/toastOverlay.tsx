/**
 * Wrist-mounted notification list (`WristToastStack`) replacing the old head-locked overlay.
 *
 * Notifications extend upwards as a vertical list directly above the wrist panel and vibrate the
 * controller that wrist is on whenever a new notification arrives. Tapping a card with the
 * opposite hand's ray dismisses it early.
 *
 * `ToastOverlay` is retained only for `--desktop` preview mode (where no wrist controller exists).
 */
import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import { useFrame, useThree } from "@react-three/fiber/webgpu";
import type { AllowedPointerEventsType } from "@pmndrs/pointer-events";
import { Container } from "../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Text } from "./ui/text.tsx";
import { measureMsdfText } from "../../submodules/threewebxrwebgpudeno/msdf-text.tsx";
import { COLOR, GAP, OUTLINE_WIDTH, RADIUS, SHELL_SIZE } from "./ui/tokens.ts";
import { type Toast, toastQueue, useVisibleToasts } from "./toastStore.ts";
import { wrapText } from "./ui/wrapText.ts";
import { type HapticHand, pulseForPointerEvent, pulseHand } from "./haptics.ts";

/** In head space (desktop preview fallback only). */
const HEAD_OFFSET = new THREE.Vector3(0, -0.17, -0.6);
const FOLLOW_RATE = 8;
const TICK_INTERVAL_S = 0.25;
const CARD_WIDTH = SHELL_SIZE;
const CARD_PADDING_X = 22;
const TEXT_WIDTH = CARD_WIDTH - 2 * CARD_PADDING_X;
const NO_POINTER_EVENTS = () => false;

function toneColor(toast: Toast): string {
  return toast.tone === "error"
    ? COLOR.danger
    : toast.tone === "warning"
    ? COLOR.accent
    : COLOR.outline;
}

/** Text broken onto lines that fit the card; the unwrapped text shows until measuring finishes. */
function useWrapped(text: string, fontSize: number): string {
  const [wrapped, setWrapped] = useState(text);
  useEffect(() => {
    let cancelled = false;
    wrapText(text, TEXT_WIDTH, async (line) => (await measureMsdfText(line, fontSize)).width)
      .then((next) => {
        if (!cancelled) setWrapped(next);
      });
    return () => {
      cancelled = true;
    };
  }, [text, fontSize]);
  return wrapped;
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss?: () => void;
}) {
  const title = useWrapped(toast.title, 22);
  const content = useWrapped(toast.content, 17);
  return (
    <Container
      width={CARD_WIDTH}
      flexDirection="column"
      gap={4}
      paddingX={CARD_PADDING_X}
      paddingY={16}
      borderRadius={RADIUS.shell - GAP}
      backgroundColor={COLOR.ground}
      backgroundOpacity={0.94}
      borderWidth={OUTLINE_WIDTH}
      borderColor={toneColor(toast)}
      onClick={onDismiss
        ? (event: unknown) => {
          pulseForPointerEvent(event, "click");
          onDismiss();
        }
        : undefined}
    >
      <Text color={COLOR.inkDim} fontSize={14}>{toast.source}</Text>
      <Text color={COLOR.ink} fontSize={22}>{title}</Text>
      {content !== "" && <Text color={COLOR.ink} fontSize={17}>{content}</Text>}
    </Container>
  );
}

/**
 * Notification list extending upward above the wrist panel. Vibrates `hostHandedness` on each
 * new notification arrival and ticks `toastQueue` for expiration.
 */
export function WristToastStack({
  hostHandedness,
  position,
  pointerEventsType = NO_POINTER_EVENTS,
}: {
  hostHandedness: HapticHand;
  position: [number, number, number];
  pointerEventsType?: AllowedPointerEventsType;
}) {
  const toasts = useVisibleToasts();
  const sinceTick = useRef(0);
  const lastVibratedId = useRef(0);

  // Vibrate the wrist's controller whenever a newly arrived toast appears.
  useEffect(() => {
    let newest = lastVibratedId.current;
    for (const toast of toasts) {
      if (toast.id > newest) newest = toast.id;
    }
    if (newest > lastVibratedId.current) {
      lastVibratedId.current = newest;
      pulseHand(hostHandedness, "notify");
    }
  }, [toasts, hostHandedness]);

  useFrame((_state, delta) => {
    sinceTick.current += delta;
    if (sinceTick.current >= TICK_INTERVAL_S) {
      sinceTick.current = 0;
      toastQueue.tick();
    }
  });

  if (toasts.length === 0) return null;
  return (
    <group position={position} userData={{ toastOverlay: true, wristToastStack: true }}>
      <Container
        pixelSize={0.001}
        anchorX="center"
        anchorY="bottom"
        pointerEventsType={pointerEventsType}
        pointerEventsOrder={100}
        flexDirection="column-reverse"
        alignItems="center"
        gap={GAP}
      >
        {toasts.map((toast) => (
          <ToastCard
            key={toast.id}
            toast={toast}
            onDismiss={() => toastQueue.dismiss(toast.id)}
          />
        ))}
      </Container>
    </group>
  );
}

/** Desktop-mode fallback only; in VR, notifications render on the wrist via `WristToastStack`. */
export function ToastOverlay() {
  const isDesktop = Deno.args.includes("--desktop");
  const toasts = useVisibleToasts();
  const group = useRef<THREE.Group>(null);
  const camera = useThree((state) => state.camera);
  const renderer = useThree((state) => state.renderer);
  const scratch = useRef({
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    sinceTick: 0,
    placed: false,
  });

  useFrame((_state, delta) => {
    if (!isDesktop) return;
    const s = scratch.current;
    s.sinceTick += delta;
    if (s.sinceTick >= TICK_INTERVAL_S) {
      s.sinceTick = 0;
      toastQueue.tick();
    }
    const node = group.current;
    if (node == null || toasts.length === 0) {
      s.placed = false;
      return;
    }
    const xr = (renderer as unknown as {
      xr?: { getCamera?: (camera: THREE.Camera) => THREE.Camera };
    }).xr;
    const head = xr?.getCamera?.(camera as unknown as THREE.Camera) ?? camera;
    head.updateWorldMatrix(true, false);
    head.getWorldPosition(s.position);
    head.getWorldQuaternion(s.quaternion);
    s.position.add(HEAD_OFFSET.clone().applyQuaternion(s.quaternion));
    const t = s.placed ? 1 - Math.exp(-FOLLOW_RATE * delta) : 1;
    node.position.lerp(s.position, t);
    node.quaternion.slerp(s.quaternion, t);
    s.placed = true;
  });

  if (!isDesktop || toasts.length === 0) return null;
  return (
    <group ref={group} userData={{ toastOverlay: true }}>
      <Container
        pixelSize={0.0007}
        pointerEventsType={NO_POINTER_EVENTS}
        flexDirection="column"
        alignItems="center"
        gap={8}
      >
        {toasts.map((toast) => <ToastCard key={toast.id} toast={toast} />)}
      </Container>
    </group>
  );
}
