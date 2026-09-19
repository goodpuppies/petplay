/**
 * Which pointers the wrist menu will accept.
 *
 * Kept separate from `logic.tsx` so the rule can be tested on its own — that
 * file pulls in React, three and the whole XR stack, and this is pure logic
 * that governs whether the panel is usable at all.
 */

/**
 * Pointer types that act at arm's-length-or-closer.
 *
 * These are the ones that fire when the panel sits on top of the very
 * controller carrying it: a ray has to be aimed, but a poke or a grab happens
 * simply by the hand being where the panel is.
 */
const NEAR_FIELD_POINTER_TYPES = new Set(["poker", "grab"]);

export function readPointerHandedness(pointerState: unknown): string | undefined {
  if (pointerState == null || typeof pointerState !== "object") {
    return undefined;
  }
  const source = (pointerState as { inputSource?: { handedness?: string } }).inputSource;
  return source?.handedness;
}

/**
 * The menu must never interact with the controller it is mounted on.
 *
 * Mounted on a wrist, the panel sits within centimetres of its own controller,
 * so without this that controller's poke and grab volumes are permanently
 * inside the panel — it swallows presses and grabs meant for the world behind
 * it. The menu is operated by pointing the *other* hand at it.
 *
 * **Fails closed.** An earlier version rejected a pointer only when its
 * handedness matched the host's, so an unattributed pointer — a runtime
 * reporting `"none"`, a hand-tracking source carrying no handedness — passed
 * straight through, and the guard disabled itself entirely whenever
 * `hostHandedness` came back undefined. Anything near-field whose origin cannot
 * be established is now refused as well. Losing an occasional legitimate poke
 * from the far hand costs far less than a panel that eats its own controller's
 * input, and a ray is still always allowed, since aiming one at your own wrist
 * is deliberate.
 *
 * @param attached distinguishes "mounted on a controller" from "floating in
 * front of the camera" (the desktop HUD), where there is no host to guard
 * against.
 */
export function isPointerBlockedByHost(
  pointerType: string,
  pointerState: unknown,
  host: "left" | "right" | undefined,
  attached: boolean,
): boolean {
  if (!attached) {
    return false;
  }
  const handedness = readPointerHandedness(pointerState);
  if (host != null && handedness === host) {
    return true;
  }
  if (handedness == null || handedness === "none") {
    return NEAR_FIELD_POINTER_TYPES.has(pointerType);
  }
  return false;
}
