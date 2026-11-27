import React, { forwardRef, useMemo } from "react";
// @deno-types="@types/three/webgpu"
import type * as THREE from "three/webgpu";
import { PETPLAY_RENDER_PROPS_KEY, type PetplayRenderProps } from "../renderProps.ts";

export type PetplayElementProps = {
  renderProps: PetplayRenderProps;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: number | [number, number, number];
  visible?: boolean;
  children?: React.ReactNode;
};

/**
 * Typed scene wrapper for custom PetPlay elements that need explicit renderer metadata
 * (overlay role, sort order, opt-out, dynamic redraws, HUD-over-UI) rather than scattering
 * untyped `userData` keys across JSX.
 */
export const PetplayElement = forwardRef<THREE.Group, PetplayElementProps>(
  function PetplayElement(
    { renderProps, position, rotation, scale, visible, children },
    ref,
  ) {
    const userData = useMemo(
      () => ({
        [PETPLAY_RENDER_PROPS_KEY]: renderProps,
        ...(renderProps.hudOverUi ? { raythreeHudOverUi: true } : {}),
      }),
      [renderProps],
    );
    return (
      <group
        ref={ref}
        position={position}
        rotation={rotation}
        scale={scale}
        visible={visible}
        userData={userData}
      >
        {children}
      </group>
    );
  },
);
