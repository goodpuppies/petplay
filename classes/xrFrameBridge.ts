// R3F v10's scheduler no longer forwards the XRFrame through advance() into
// useFrame callbacks. webxrhost stashes the current frame here around its
// advance() call, and our useFrame shims in r3fCompat.ts / r3fWebgpuCompat.ts
// read it back as the third argument — so downstream consumers (notably
// @pmndrs/xr) still see the frame without needing modifications.
export const currentXRFrame: { value: XRFrame | undefined } = { value: undefined };
