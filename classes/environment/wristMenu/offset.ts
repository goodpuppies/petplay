/**
 * Where the wrist menu sits relative to its default mount, after the user grabbed it with the
 * other hand and let go. Stored in right-hand terms, so moving it on one hand carries over,
 * mirrored, when it is switched to the other.
 */
export type WristOffset = {
  /** In the mount's local units (the panel is 0.528 across). */
  position: [number, number, number];
  /** Quaternion x, y, z, w. */
  rotation: [number, number, number, number];
};

/** A position + rotation offset in some parent frame; the wrist menu's and the lasers' share it. */
export type PoseOffset = WristOffset;

const isFiniteTuple = (value: unknown, length: number): boolean =>
  Array.isArray(value) && value.length === length &&
  value.every((n) => typeof n === "number" && Number.isFinite(n));

export function isWristOffset(value: unknown): value is WristOffset {
  if (value == null || typeof value !== "object") return false;
  const { position, rotation } = value as Record<string, unknown>;
  return isFiniteTuple(position, 3) && isFiniteTuple(rotation, 4);
}

/**
 * Converts between right-hand terms and the given hand's. The left mount is the right one
 * reflected across the YZ plane (see `controllerWristTransform`), so an offset inside it reflects
 * the same way: negate x, and the quaternion's y and z. Its own inverse.
 */
export function wristOffsetForHand(offset: WristOffset, hand: "left" | "right"): WristOffset {
  if (hand === "right") return offset;
  const [x, y, z] = offset.position;
  const [qx, qy, qz, qw] = offset.rotation;
  return { position: [-x, y, z], rotation: [qx, -qy, -qz, qw] };
}
