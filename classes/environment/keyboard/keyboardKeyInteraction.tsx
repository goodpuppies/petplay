import React, { useEffect, useRef } from "react";
// @deno-types="@types/three/webgpu"
import type * as THREE from "three/webgpu";
import { Text } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Container } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { KEYCAP_FRONT_RENDER_PROPS, KeyCapChrome } from "./keyboardUi.tsx";
import type { NormalizedKeyFace } from "./types.ts";
import { keyTextColor, tokenBackground, tokenBorderColor } from "./theme.ts";
import { ICON_CODEPOINTS, type IconName } from "../ui/icons.tsx";
import { COLOR } from "../ui/tokens.ts";
import { keyboardRepeat } from "./keyRepeat.ts";
import { KeyHold, type KeyPhase } from "./keyHold.ts";
import { recordPress } from "../pressLog.ts";

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
/** The AltGr legend's inset from the cap's bottom-right corner, as a fraction of the cap. */
const SECONDARY_LEGEND_INSET = 0.08;

/**
 * Legends drawn from the icon font. Roboto's atlas has no glyph for these, and a run with no
 * glyphs measures as infinitely small, which uikit then scales up to fill the cap: the legend
 * came out metres tall, floating above the keyboard (found by `tests/playtest/keyboard.ts`).
 */
const LEGEND_ICONS: Record<string, IconName> = {
  "⌫": "backspace",
  "↵": "keyboard_return",
  "☰": "menu",
  "↑": "arrow_upward",
  "↓": "arrow_downward",
  "←": "arrow_back",
  "→": "arrow_forward",
};

/**
 * Roboto's atlas stops at ASCII (plus a few Latin-1 signs). The icon atlas also carries Roboto's
 * Latin-1 letters and €, added with `add-glyphs.py --ttf`, for legends such as ö ä å § ´ ¨ ½.
 */
const BEYOND_TEXT_ATLAS = /[^\x20-\x7e]/;

/** The text and font a legend is drawn with. */
export function legendGlyph(label: string): { text: string; font?: "material-icons" } {
  const icon = LEGEND_ICONS[label];
  if (icon != null) {
    return { text: String.fromCodePoint(ICON_CODEPOINTS[icon]), font: "material-icons" };
  }
  return BEYOND_TEXT_ATLAS.test(label) ? { text: label, font: "material-icons" } : { text: label };
}
/** A double-tap-held modifier's white ring around the latched fill, to tell it from a one-shot latch. */
const HELD_BORDER_WIDTH = 5;

type ImperativeUIKitRef = {
  setProperties?: (props: Record<string, unknown>) => void;
  /** The properties the component currently holds (UIKit's own field). */
  inputProperties?: Record<string, unknown>;
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
  onActivate: (
    face: NormalizedKeyFace,
    source: THREE.Object3D | null,
    worldPoint?: readonly [number, number, number],
    phase?: KeyPhase,
  ) => void;
  /** For testing: notify on any pointer down. */
  onTestPointerDown?: (face: NormalizedKeyFace) => void;
  /** Latched modifier (caps/shift/ctrl/alt/meta) — same visual as held. */
  latched?: boolean;
  /** Held down by a double tap until the next tap: latched, plus a thick white ring. */
  held?: boolean;
};

/**
 * One key: press feedback; primary legend + optional secondary (e.g. JIS kana) from `face`.
 *
 * Memoized: the 74 caps must not re-render when an unrelated part of the spatial graph updates
 * (hover, selection, another node's transform commit).
 */
export const InteractiveKeyCap = React.memo(function InteractiveKeyCap(
  {
    face,
    minWidth,
    minHeight,
    pixelSize,
    currentLabel,
    onActivate,
    onTestPointerDown,
    latched = false,
    held = false,
  }: InteractiveKeyCapProps,
) {
  const activationRef = useRef({ face, onActivate });
  activationRef.current = { face, onActivate };
  const pressLocationRef = useRef<{
    source: THREE.Object3D | null;
    worldPoint?: readonly [number, number, number];
  }>({ source: null });
  const holdRef = useRef<KeyHold | null>(null);
  if (holdRef.current == null) {
    holdRef.current = new KeyHold((phase) => {
      const { face, onActivate } = activationRef.current;
      const { source, worldPoint } = pressLocationRef.current;
      onActivate(face, source, worldPoint, phase);
    });
  }
  const visualRef = useRef<ImperativeUIKitRef | null>(null);
  const primaryTextRef = useRef<TextMeshRef | null>(null);
  const secondaryTextRef = useRef<TextMeshRef | null>(null);
  const hoveredRef = useRef(false);
  const releaseRafRef = useRef<number | null>(null);
  const depressRef = useRef(0);
  /** Modifiers and toggles latch instead: holding them must not repeat. */
  const canRepeat = face.sticky !== true && face.toggle !== true;
  const stopRepeat = () => keyboardRepeat.stop(holdRef.current!);

  const litSurface = latched;
  const tc = keyTextColor(face.colorToken, litSurface);
  const font = Math.max(10, face.fontSize);
  const legend = legendGlyph(currentLabel);

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
      stopRepeat();
      holdRef.current?.releaseAll();
    },
    [],
  );

  const baseBorderWidth = held ? HELD_BORDER_WIDTH : litSurface ? 2 : 1;
  const baseBackgroundColor = tokenBackground(face.colorToken, litSurface);
  const baseBorderColor = held ? COLOR.outline : tokenBorderColor(face.colorToken, litSurface);

  const isVisualLit = (value: number): boolean => latched || hoveredRef.current || value > 0;

  const visualPropsForDepress = (value: number): Record<string, unknown> => {
    const pressed = isVisualLit(value);
    return {
      backgroundColor: tokenBackground(face.colorToken, pressed),
      borderColor: held ? COLOR.outline : tokenBorderColor(face.colorToken, pressed),
      // Border width is a flex property: changing it re-lays out the whole keyboard root. Hover
      // flips on every key a ray crosses (and ~20 times a second on a resting ray's jitter), so
      // only the rare latch and hold states change it; hover and press change colours alone.
      borderWidth: baseBorderWidth,
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
    // Showing the window layer re-runs the effect below on all 74 caps; re-setting values a cap
    // already holds still resets its whole property stack (~4 ms per show), so skip that.
    const visual = visualRef.current;
    const props = visualPropsForDepress(depressRef.current);
    const current = visual?.inputProperties;
    const changed = current == null ||
      Object.entries(props).some(([key, value]) => !Object.is(current[key], value));
    if (changed) visual?.setProperties?.(props);
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
      borderWidth={baseBorderWidth}
      onPointerOver={(e) => {
        if (!isTriggerLikePointer(e)) return;
        // Keycaps sit 4-deep in row/column/group containers. The pointer
        // system bubbles over/out to every ancestor, and each level runs
        // hovered-list signal updates + layout reads. Stop it at the cap.
        e.stopPropagation();
        // A re-enter mid-release must win over the 200ms ease-out loop, or
        // the loop eases the pressed visual away under a hovering laser.
        cancelReleaseRaf();
        if (hoveredRef.current) return;
        hoveredRef.current = true;
        applyCurrentVisual();
      }}
      onPointerDown={(e) => {
        if (!isPrimaryActivation(e)) return;
        // Cancel release rAF; new presses are not gated on release finishing.
        cancelReleaseRaf();
        onTestPointerDown?.(face);
        const point = (e as unknown as { point?: { x?: number; y?: number; z?: number } }).point;
        const worldPoint = point &&
            Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)
          ? [point.x!, point.y!, point.z!] as const
          : undefined;
        recordPress(`key:${face.id}`, e);
        pressLocationRef.current = {
          source: (e.object as unknown as THREE.Object3D | undefined) ?? null,
          worldPoint,
        };
        const firstPress = holdRef.current!.down(e.pointerId);

        updateDepressVisual(1);
        // Hold to repeat: one press now, then this key keeps firing until the
        // pointer leaves or lifts.
        if (canRepeat && firstPress) {
          keyboardRepeat.start(holdRef.current!, () => holdRef.current?.repeat());
        }
      }}
      onPointerOut={(e) => {
        if (!isTriggerLikePointer(e)) return;
        e.stopPropagation();
        if (holdRef.current?.up(e.pointerId)) stopRepeat();
        if (!hoveredRef.current && depressRef.current <= 0) return;
        hoveredRef.current = false;
        applyCurrentVisual();
        beginRelease();
      }}
      onPointerCancel={(e) => {
        if (!isTriggerLikePointer(e)) return;
        if (holdRef.current?.up(e.pointerId)) stopRepeat();
        beginRelease();
      }}
      onPointerUp={(e) => {
        if (!isTriggerLikePointer(e)) return;
        if (holdRef.current?.up(e.pointerId)) stopRepeat();
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
          // Remounted per legend: a run that once measured empty (a glyph missing from the
          // atlas) keeps its broken transform after relabelling, so a locale switch away from
          // it would leave the cap's legend floating metres off the keyboard.
          key={legend.text}
          ref={(mesh: TextMeshRef | null) => syncTextRef(primaryTextRef, mesh)}
          color={tc}
          fontSize={font * KEY_PRIMARY_LABEL_SCALE}
          font={legend.font}
          pixelSize={pixelSize}
          textAlign="center"
          {...KEYCAP_FRONT_RENDER_PROPS}
        >
          {legend.text}
        </Text>
      </Container>
      {face.hasSecondary && face.displayAlt
        ? (
          <Text
            key={face.displayAlt}
            ref={(mesh: TextMeshRef | null) => syncTextRef(secondaryTextRef, mesh)}
            color={tc}
            fontSize={font * KEY_SECONDARY_LABEL_SCALE}
            font={legendGlyph(face.displayAlt).font}
            pixelSize={pixelSize}
            textAlign="right"
            // The AltGr legend sits in the cap's bottom-right corner, as on a printed Finnish
            // keycap; stacked under the main legend the two ran together.
            positionType="absolute"
            positionRight={SECONDARY_LEGEND_INSET * minWidth}
            positionBottom={SECONDARY_LEGEND_INSET * minHeight}
            {...KEYCAP_FRONT_RENDER_PROPS}
          >
            {legendGlyph(face.displayAlt).text}
          </Text>
        )
        : null}
    </KeyCapChrome>
  );
});
