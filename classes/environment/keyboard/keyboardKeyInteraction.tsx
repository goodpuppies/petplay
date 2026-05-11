import React, { useEffect, useRef } from "react";
import { Text } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Container } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { KEYCAP_FRONT_RENDER_PROPS, KeyCapChrome } from "./keyboardUi.tsx";
import type { NormalizedKeyFace } from "./types.ts";
import { keyTextColor, tokenBackground, tokenBorderColor } from "./theme.ts";

const requestAnimFrame: (c: (t: number) => void) => number = (c) =>
  (globalThis as unknown as { requestAnimationFrame: (c: (t: number) => void) => number })
    .requestAnimationFrame(c);
const cancelAnimFrame: (h: number) => void = (h) =>
  (globalThis as unknown as { cancelAnimationFrame: (h: number) => void }).cancelAnimationFrame(h);

/** Stronger shrink on press (uikit `transformScale`). */
const KEY_CLICK_SCALE = 0.78;
/** uikit `transformTranslateZ` raw units (scaled by pixelSize in layout). */
const KEY_DEPRESS_Z = -32;
/**
 * uikit applies transform props as an instant matrix change. We run a `requestAnimationFrame` loop to
 * ease `depress` from 1 toward 0 over this many ms after pointer up or out. New presses cancel this
 * (release does not have to finish). Increase for a slower return to the rest pose.
 */
const KEY_RELEASE_EASE_MS = 200;
const KEY_PRIMARY_LABEL_SCALE = 1.15;
const KEY_SECONDARY_LABEL_SCALE = 0.72;

type ImperativeUIKitRef = {
  setProperties?: (props: Record<string, unknown>) => void;
};

type TextMeshRef = {
  material?: { color?: string };
  userData?: {
    raythreeUiText?: {
      color?: [number, number, number, number];
    };
  };
};

function hexColorToRgb01(color: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(color);
  if (match == null) {
    return null;
  }
  const value = Number.parseInt(match[1], 16);
  return [
    ((value >> 16) & 0xff) / 255,
    ((value >> 8) & 0xff) / 255,
    (value & 0xff) / 255,
  ];
}

function setTextMeshColor(ref: React.RefObject<TextMeshRef | null>, color: string): void {
  const mesh = ref.current;
  if (mesh == null) {
    return;
  }
  if (mesh.material != null) {
    mesh.material.color = color;
  }
  const rgb = hexColorToRgb01(color);
  if (rgb != null && mesh.userData?.raythreeUiText != null) {
    const alpha = mesh.userData.raythreeUiText.color?.[3] ?? 1;
    mesh.userData.raythreeUiText.color = [rgb[0], rgb[1], rgb[2], alpha];
  }
}

function easeOutCubic(t: number): number {
  const u = 1 - Math.max(0, Math.min(1, t));
  return 1 - u * u * u;
}

/**
 * XR controller squeeze drives a grab pointer (`pointerType === "grab"`).
 * Key caps should only react to trigger-ray / mouse / touch so moving the panel does not type.
 */
function isTriggerLikePointer(event: { pointerType?: string }): boolean {
  return event.pointerType !== "grab";
}

function isPrimaryActivation(event: { button?: number; pointerType?: string }): boolean {
  if (!isTriggerLikePointer(event)) {
    return false;
  }
  return event.pointerType?.includes("mouse") ? event.button === 0 : true;
}

export type InteractiveKeyCapProps = {
  face: NormalizedKeyFace;
  minWidth: number;
  minHeight: number;
  pixelSize: number;
  /** Legend with current shift/caps (US QWERTY) or a fixed `label` from JSON. */
  currentLabel: string;
  onActivate: (face: NormalizedKeyFace) => void;
  /** For testing: notify on any pointer down. */
  onTestPointerDown?: (face: NormalizedKeyFace) => void;
  /** Latched modifier (caps/shift/ctrl/alt/meta) — same visual as held. */
  latched?: boolean;
};

/**
 * One key: press feedback; primary legend + optional secondary (e.g. JIS kana) from `face`.
 */
export function InteractiveKeyCap(
  {
    face,
    minWidth,
    minHeight,
    pixelSize,
    currentLabel,
    onActivate,
    onTestPointerDown,
    latched = false,
  }: InteractiveKeyCapProps,
) {
  const visualRef = useRef<ImperativeUIKitRef | null>(null);
  const primaryTextRef = useRef<TextMeshRef | null>(null);
  const secondaryTextRef = useRef<TextMeshRef | null>(null);
  const hoveredRef = useRef(false);
  const releaseRafRef = useRef<number | null>(null);
  const depressRef = useRef(0);

  const litSurface = latched;
  const tc = keyTextColor(face.colorToken, litSurface);
  const font = Math.max(10, face.fontSize);

  const cancelReleaseRaf = () => {
    if (releaseRafRef.current != null) {
      cancelAnimFrame(releaseRafRef.current);
      releaseRafRef.current = null;
    }
  };

  const startEaseToRest = (from: number) => {
    const start = globalThis.performance.now();
    const t0 = from;
    const step = (now: number) => {
      const u = (now - start) / KEY_RELEASE_EASE_MS;
      if (u >= 1) {
        depressRef.current = 0;
        applyCurrentVisual();
        releaseRafRef.current = null;
        return;
      }
      const e = 1 - easeOutCubic(u);
      updateDepressVisual(t0 * e);
      releaseRafRef.current = requestAnimFrame(step);
    };
    releaseRafRef.current = requestAnimFrame(step);
  };

  const beginRelease = () => {
    cancelReleaseRaf();
    const t0 = depressRef.current;
    if (t0 <= 0) {
      return;
    }
    startEaseToRest(t0);
  };

  useEffect(
    () => () => {
      cancelReleaseRaf();
    },
    [],
  );

  const baseBorderWidth = litSurface ? 2 : 1;
  const baseBackgroundColor = tokenBackground(face.colorToken, litSurface);
  const baseBorderColor = tokenBorderColor(face.colorToken, litSurface);

  const isVisualLit = (value: number): boolean => latched || hoveredRef.current || value > 0;

  const visualPropsForDepress = (value: number): Record<string, unknown> => {
    const pressed = isVisualLit(value);
    return {
      backgroundColor: tokenBackground(face.colorToken, pressed),
      borderColor: tokenBorderColor(face.colorToken, pressed),
      borderWidth: pressed ? 2 : 1,
      transformScaleX: value > 0 ? 1 + (KEY_CLICK_SCALE - 1) * value : undefined,
      transformScaleY: value > 0 ? 1 + (KEY_CLICK_SCALE - 1) * value : undefined,
      transformTranslateZ: value > 0 ? KEY_DEPRESS_Z * value : undefined,
    };
  };

  const applyTextVisual = (value: number) => {
    const color = keyTextColor(face.colorToken, isVisualLit(value));
    setTextMeshColor(primaryTextRef, color);
    setTextMeshColor(secondaryTextRef, color);
  };

  const syncTextRef = (
    targetRef: React.MutableRefObject<TextMeshRef | null>,
    mesh: TextMeshRef | null,
  ) => {
    targetRef.current = mesh;
    if (mesh != null) {
      setTextMeshColor(targetRef, keyTextColor(face.colorToken, isVisualLit(depressRef.current)));
    }
  };

  const updateDepressVisual = (value: number) => {
    depressRef.current = value;
    visualRef.current?.setProperties?.(visualPropsForDepress(value));
    applyTextVisual(value);
  };

  const applyCurrentVisual = () => {
    visualRef.current?.setProperties?.(visualPropsForDepress(depressRef.current));
    applyTextVisual(depressRef.current);
  };

  useEffect(() => {
    applyCurrentVisual();
  }, [baseBackgroundColor, baseBorderColor, baseBorderWidth]);

  return (
    <KeyCapChrome
      visualRef={visualRef}
      face={face}
      minWidth={minWidth}
      minHeight={minHeight}
      pixelSize={pixelSize}
      pressedVisual={litSurface}
      onPointerOver={(e) => {
        if (!isTriggerLikePointer(e)) return;
        hoveredRef.current = true;
        applyCurrentVisual();
      }}
      onPointerDown={(e) => {
        if (!isPrimaryActivation(e)) return;
        // Cancel release rAF; new presses are not gated on release finishing.
        cancelReleaseRaf();
        onTestPointerDown?.(face);
        onActivate(face);
        updateDepressVisual(1);
      }}
      onPointerUp={(e) => {
        if (!isTriggerLikePointer(e)) return;
        beginRelease();
      }}
      onPointerOut={(e) => {
        if (!isTriggerLikePointer(e)) return;
        hoveredRef.current = false;
        applyCurrentVisual();
        beginRelease();
      }}
    >
      <Container
        pixelSize={pixelSize}
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        minHeight={minHeight * 0.35}
        backgroundColor="transparent"
        borderWidth={0}
      >
        <Text
          ref={(mesh: TextMeshRef | null) => syncTextRef(primaryTextRef, mesh)}
          color={tc}
          fontSize={font * KEY_PRIMARY_LABEL_SCALE}
          pixelSize={pixelSize}
          textAlign="center"
          {...KEYCAP_FRONT_RENDER_PROPS}
        >
          {currentLabel}
        </Text>
        {face.hasSecondary && face.displayAlt
          ? (
            <Text
              ref={(mesh: TextMeshRef | null) => syncTextRef(secondaryTextRef, mesh)}
              color={tc}
              fontSize={font * KEY_SECONDARY_LABEL_SCALE}
              pixelSize={pixelSize}
              textAlign="center"
              {...KEYCAP_FRONT_RENDER_PROPS}
            >
              {face.displayAlt}
            </Text>
          )
          : null}
      </Container>
    </KeyCapChrome>
  );
}
