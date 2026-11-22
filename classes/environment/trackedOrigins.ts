/**
 * Tracked spaces a window can be attached to, besides the world (`SCENE_ORIGIN_ID`).
 *
 * A root node whose `originId` is one of these renders under a group that follows that space every
 * frame (`TrackedOriginGroup` in `scene.tsx`). Controllers register their grip space here
 * (`petplayXrController.tsx`); the head is the XR camera and needs no registration.
 */
import * as THREE from "three/webgpu";
import { SCENE_ORIGIN_ID } from "./spatialGraph.ts";
import { getVRCOriginMatrixElements, isVRCOriginKnown } from "../webxrShadowScene.ts";

export const VRC_WORLD_ORIGIN_ID = "vrc-world" as const;
export const TRACKED_ORIGIN_IDS = ["head", "left-hand", "right-hand", VRC_WORLD_ORIGIN_ID] as const;
export type TrackedOriginId = typeof TRACKED_ORIGIN_IDS[number];
export type SpatialOriginId = typeof SCENE_ORIGIN_ID | TrackedOriginId;
export type HandOriginId = Exclude<TrackedOriginId, "head" | typeof VRC_WORLD_ORIGIN_ID>;

export const SPATIAL_ORIGIN_IDS: readonly SpatialOriginId[] = [
  SCENE_ORIGIN_ID,
  ...TRACKED_ORIGIN_IDS,
];

export const SPATIAL_ORIGIN_LABEL: Record<SpatialOriginId, string> = {
  [SCENE_ORIGIN_ID]: "World",
  head: "Head",
  "left-hand": "Left hand",
  "right-hand": "Right hand",
  [VRC_WORLD_ORIGIN_ID]: "VRC World",
};

export function isTrackedOriginId(id: string): id is TrackedOriginId {
  return (TRACKED_ORIGIN_IDS as readonly string[]).includes(id);
}

const hands = new Map<HandOriginId, THREE.Object3D>();

/** Returns the unregister function; a stale unregister leaves a newer registration alone. */
export function registerHandOrigin(id: HandOriginId, object: THREE.Object3D): () => void {
  hands.set(id, object);
  return () => {
    if (hands.get(id) === object) hands.delete(id);
  };
}

/** The registered grip-space object, for playtests and inspection. */
export function getHandOriginObject(id: HandOriginId): THREE.Object3D | undefined {
  return hands.get(id);
}

/** The headset pose object: the XR camera in a session, else the plain camera. */
export function getHeadObject(
  renderer: unknown,
  camera: THREE.Camera,
): THREE.Object3D {
  if (Deno.args.includes("--desktop")) return camera;
  const xr = (renderer as {
    xr?: { getCamera?: (camera: THREE.Camera) => THREE.Camera };
  }).xr;
  return xr?.getCamera?.(camera) ?? camera;
}

/**
 * World matrix of a tracked origin into `target`. False when the space isn't tracked right now
 * (a controller that is off), so callers can hold the last pose.
 */
export function getTrackedOriginWorldMatrix(
  id: TrackedOriginId,
  head: THREE.Object3D,
  target: THREE.Matrix4,
): boolean {
  if (id === "head") {
    head.updateWorldMatrix(true, false);
    target.copy(head.matrixWorld);
    return true;
  }
  if (id === VRC_WORLD_ORIGIN_ID) {
    if (!isVRCOriginKnown()) return false;
    target.fromArray(getVRCOriginMatrixElements());
    return true;
  }
  return getHandOriginWorldMatrix(id, target);
}

/** World matrix of a controller's grip space; false while that controller isn't registered. */
export function getHandOriginWorldMatrix(id: HandOriginId, target: THREE.Matrix4): boolean {
  const object = hands.get(id);
  if (object == null) return false;
  // Compose the chain by hand: XR spaces write `matrix` with `matrixAutoUpdate` off and never flag
  // `matrixWorldNeedsUpdate`, so `updateWorldMatrix` would keep a stale world matrix.
  target.copy(object.matrix);
  for (let node = object.parent; node != null; node = node.parent) {
    if (node.matrixAutoUpdate) node.updateMatrix();
    target.premultiply(node.matrix);
  }
  return true;
}
