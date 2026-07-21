import React from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { extend, type ThreeToJSXElements } from "@react-three/fiber/webgpu";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

declare module "@react-three/fiber/webgpu" {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

export type SpatialBoxHitboxProps = {
  id: string;
  size: [number, number, number];
  color?: number;
  visible?: boolean;
};

/** Non-interactive spatial capability visualization. Red wireframe is the development default. */
export function SpatialBoxHitbox(
  { id, size, color = 0xff334d, visible = true }: SpatialBoxHitboxProps,
) {
  const geometry = React.useMemo(() => {
    const box = new THREE.BoxGeometry(...size);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    return edges;
  }, [size[0], size[1], size[2]]);
  const tint = React.useMemo(() => new THREE.Color(color), [color]);

  React.useEffect(() => () => geometry.dispose(), [geometry]);
  if (!visible) return null;

  return (
    <lineSegments
      geometry={geometry as unknown as THREE.BufferGeometry}
      userData={{
        spatialHitbox: true,
        spatialHitboxId: id,
        bridge: { radius: 0.001, radialSegments: 4 },
      }}
      {...({ pointerEvents: "none" } as Record<string, unknown>)}
    >
      <lineBasicMaterial color={tint} depthTest={false} />
    </lineSegments>
  );
}
