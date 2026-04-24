// R3F v10's scheduler no longer forwards the XRFrame through
// `advance(...)` -> useFrame callbacks. We stash it here around the
// `advance()` call so the vendored @pmndrs/xr code can read the current
// frame synchronously from inside its useFrame callbacks.
//
// Published on globalThis so vendored code (which shouldn't reach into
// our repo paths) can read it via a stable symbol.
export const XR_FRAME_BRIDGE_KEY = Symbol.for("petplay.xrFrameBridge");

export type XRFrameBridge = { value: XRFrame | undefined };

const g = globalThis as unknown as Record<symbol, unknown>;
export const currentXRFrame: XRFrameBridge =
  (g[XR_FRAME_BRIDGE_KEY] as XRFrameBridge | undefined) ?? { value: undefined };
g[XR_FRAME_BRIDGE_KEY] = currentXRFrame;
