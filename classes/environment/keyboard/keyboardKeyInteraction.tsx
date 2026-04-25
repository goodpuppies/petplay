import React, { useState } from "react";
import { Text } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { KeyCapChrome } from "./keyboardUi.tsx";
import type { NormalizedKeyFace } from "./types.ts";
import { keyTextColor } from "./theme.ts";
import { Container } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";

/**
 * XR controller squeeze drives a sphere “grab” pointer (`pointerType === "grab"`).
 * Key caps should only react to trigger-ray / mouse / touch so moving the panel doesn’t type.
 */
function isTriggerLikePointer(event: { pointerType?: string }): boolean {
  return event.pointerType !== "grab";
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
  const [pressed, setPressed] = useState(false);
  const down = pressed || latched;
  const tc = keyTextColor(face.colorToken, down);
  const font = Math.max(10, face.fontSize);

  return (
    <KeyCapChrome
      face={face}
      minWidth={minWidth}
      minHeight={minHeight}
      pixelSize={pixelSize}
      pressedVisual={down}
      onPointerDown={(e) => {
        if (!isTriggerLikePointer(e)) return;
        onTestPointerDown?.(face);
        setPressed(true);
      }}
      onPointerUp={(e) => {
        if (!isTriggerLikePointer(e)) return;
        setPressed(false);
      }}
      onPointerOut={(e) => {
        if (!isTriggerLikePointer(e)) return;
        setPressed(false);
      }}
      onClick={(e) => {
        if (!isTriggerLikePointer(e)) return;
        onActivate(face);
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
          color={tc}
          fontSize={font * 0.9}
          pixelSize={pixelSize}
          textAlign="center"
        >
          {currentLabel}
        </Text>
        {face.hasSecondary && face.displayAlt
          ? (
            <Text
              color={tc}
              fontSize={font * 0.58}
              pixelSize={pixelSize}
              textAlign="center"
            >
              {face.displayAlt}
            </Text>
          )
          : null}
      </Container>
    </KeyCapChrome>
  );
}
