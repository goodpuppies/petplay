/**
 * The mark above a shared display: a wifi glyph in a round badge. On the sharing side it marks a
 * display others can see (and, accented, one they may also drive); on the viewing side, a display
 * showing someone else's screen.
 */
import React from "react";
import { Container } from "../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Icon } from "./ui/icons.tsx";
import { COLOR, OUTLINE_WIDTH, UNIT } from "./ui/tokens.ts";

export function SharedIndicator({
  position,
  remoteInput = false,
}: {
  position: [number, number, number];
  /** Others may drive it: the badge is accented. */
  remoteInput?: boolean;
}) {
  const size = UNIT * 0.5;
  return (
    <group
      position={position}
      userData={{ sharedIndicator: true }}
      {...({ pointerEvents: "none" } as Record<string, unknown>)}
    >
      <Container
        pixelSize={0.001}
        width={size}
        height={size}
        alignItems="center"
        justifyContent="center"
        borderRadius={size / 2}
        borderWidth={OUTLINE_WIDTH}
        borderColor={remoteInput ? COLOR.accent : COLOR.outline}
        backgroundColor={COLOR.ground}
        backgroundOpacity={1}
      >
        <Icon name="wifi" size={size * 0.6} color={remoteInput ? COLOR.accent : COLOR.ink} />
      </Container>
    </group>
  );
}
