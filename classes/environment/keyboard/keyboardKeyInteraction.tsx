import React, { useState } from "react";
import { Text } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { KeyCapChrome } from "./keyboardUi.tsx";
import type { NormalizedKeyFace } from "./types.ts";
import { keyTextColor } from "./theme.ts";
import { Container } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";

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
  }: InteractiveKeyCapProps,
) {
  const [pressed, setPressed] = useState(false);
  const tc = keyTextColor(face.colorToken);
  const font = Math.max(10, face.fontSize);

  return (
    <KeyCapChrome
      face={face}
      minWidth={minWidth}
      minHeight={minHeight}
      pixelSize={pixelSize}
      pressedVisual={pressed}
      onPointerDown={() => {
        onTestPointerDown?.(face);
        setPressed(true);
      }}
      onPointerUp={() => setPressed(false)}
      onPointerOut={() => setPressed(false)}
      onClick={() => onActivate(face)}
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
