/**
 * Where the wrist menu sits in desktop views, in camera space, without the saved wrist offset
 * (that only applies on a wrist). The raylib desktop-control surface mounts its menu at the fixed
 * head-locked transform below; browser scene views place the live wrist menu with
 * {@link cornerWristHud}. The XR path keeps its own wrist-relative transform in `logic.tsx`.
 *
 * Tunable without a rebuild via PETPLAY_WRIST_HUD_{DISTANCE,SCALE,X,Y}, since a restart costs far
 * more than the tweak being tried.
 */
export type WristHudTransform = {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
};

function envNumber(name: string, fallback: number): number {
  const parsed = Number(typeof Deno !== "undefined" ? Deno.env.get(name) : undefined);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function desktopWristHudTransform(): WristHudTransform {
  const s = envNumber("PETPLAY_WRIST_HUD_SCALE", 0.5);
  return {
    position: [
      envNumber("PETPLAY_WRIST_HUD_X", 0),
      envNumber("PETPLAY_WRIST_HUD_Y", -0.04),
      -Math.abs(envNumber("PETPLAY_WRIST_HUD_DISTANCE", 0.35)),
    ],
    rotation: [0, 0, 0],
    scale: [s, s, s],
  };
}

/** The wrist menu panel's side in its own frame: 528 UI px at `pixelSize` 0.001. */
export const WRIST_PANEL_SIZE = 0.528;

/**
 * The wrist menu as a corner HUD in a perspective view (browser scene views): bottom right, a
 * fixed share of the view's height (narrowed to fit a portrait view), squared up to the camera.
 * Depends on the view's lens, so views compute it per frame rather than taking one transform.
 */
export function cornerWristHud(
  fovYDegrees: number,
  aspect: number,
  { heightShare = 0.34, margin = 0.025, bottomMargin = 0.07, distance = 0.35 } = {},
): WristHudTransform {
  const halfHeight = distance * Math.tan((fovYDegrees * Math.PI) / 360);
  const halfWidth = halfHeight * aspect;
  const size = Math.min(2 * halfHeight * heightShare, 2 * halfWidth * 0.6);
  const inset = 2 * halfHeight * margin;
  // Clear of a status line along the bottom edge.
  const bottom = 2 * halfHeight * bottomMargin;
  const s = size / WRIST_PANEL_SIZE;
  return {
    position: [halfWidth - inset - size / 2, -halfHeight + bottom + size / 2, -distance],
    rotation: [0, 0, 0],
    scale: [s, s, s],
  };
}
