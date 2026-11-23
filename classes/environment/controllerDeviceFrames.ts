/**
 * Where a controller pose space sits on its OpenVR tracked device, for overlays that other
 * processes position (desktop screens): while a controller carries a window they are set relative
 * to the device, so the compositor moves them with its own fresh controller pose like the
 * decoupled renderer does for the window itself.
 *
 * The webxr worker registers the resolver once OpenVR is up; without it everything stays absolute.
 */
import type { FollowPair, RenderAnchorSpace } from "../overlayRenderTracking.ts";

export type ControllerDeviceFrame = {
  deviceIndex: number;
  /** Column-major 4×4: the pose space (target ray or grip) in the device's own frame. */
  deviceToPose: ArrayLike<number>;
};

let resolver: ((space: RenderAnchorSpace) => ControllerDeviceFrame | null) | null = null;

export function setControllerDeviceFrameResolver(next: typeof resolver): void {
  resolver = next;
}

export function getControllerDeviceFrame(space: RenderAnchorSpace): ControllerDeviceFrame | null {
  return resolver?.(space) ?? null;
}

/**
 * Letting go of a carried window: the decoupled renderer freezes it at the controller pose it last
 * showed and returns that pose, so the worker can land the window exactly there. `land` gets the
 * pose (column-major 4×4), or null when no renderer answers in time.
 */
export type FollowReleaseSender = (
  carry: { space: RenderAnchorSpace; pair?: FollowPair },
  seq: number,
) => boolean;

let releaseSender: FollowReleaseSender | null = null;
let releaseSeq = 0;
const pendingReleases = new Map<number, (pose: ArrayLike<number> | null) => void>();
const FOLLOW_RELEASE_TIMEOUT_MS = 150;

export function setFollowReleaseSender(next: FollowReleaseSender | null): void {
  releaseSender = next;
}

export function requestFollowRelease(
  carry: { space: RenderAnchorSpace; pair?: FollowPair },
  land: (pose: ArrayLike<number> | null) => void,
): void {
  const seq = ++releaseSeq;
  if (releaseSender == null || !releaseSender(carry, seq)) return land(null);
  pendingReleases.set(seq, land);
  setTimeout(() => settleFollowRelease(seq, null), FOLLOW_RELEASE_TIMEOUT_MS);
}

/** The renderer's answer (FOLLOWRELEASED); later or repeated answers are ignored. */
export function settleFollowRelease(seq: number, pose: ArrayLike<number> | null): void {
  const land = pendingReleases.get(seq);
  if (land == null) return;
  pendingReleases.delete(seq);
  land(pose);
}

/**
 * Displays re-send their OpenVR pose at once after a landing, instead of on the next frame, so a
 * screen attached to the controller lets go as soon as the window does.
 */
const displaySyncs = new Set<() => void>();
const followReleaseActors = new Map<string, number>();

export function registerFollowReleaseActor(actorId: string): () => void {
  followReleaseActors.set(actorId, (followReleaseActors.get(actorId) ?? 0) + 1);
  return () => {
    const next = (followReleaseActors.get(actorId) ?? 1) - 1;
    if (next <= 0) followReleaseActors.delete(actorId);
    else followReleaseActors.set(actorId, next);
  };
}

export function getFollowReleaseActors(): string[] {
  return [...followReleaseActors.keys()];
}

export function registerDisplaySync(sync: () => void): () => void {
  displaySyncs.add(sync);
  return () => displaySyncs.delete(sync);
}

export function syncDisplaysNow(): void {
  for (const sync of displaySyncs) sync();
}
