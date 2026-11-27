# VRChat depth occlusion and input-focus quads only reach the inline renderer

Status: open

## What happens

`tickHeadsetDepth` and `setDepthOccluder` only target `state.raylibOverlayRaylib`, the in-worker inline renderer (`petplay/webxr.ts:2144-2168`, `petplay/webxr.ts:3796`). `petplay/overlayRenderOwner.ts` — the decoupled renderer and the default on Windows and Linux — has no depth occluder input at all, so `vrchatDepth` appears to do nothing in the default setup.

Similarly, input-focus quads are only configured on the inline renderer path (`petplay/webxr.ts:3239`); the decoupled renderer branch returns before reaching that setup.

## Expected

Attach VRChat depth occlusion intake and input-focus quad configuration to the VR session / active renderer abstraction rather than only the inline renderer, so both work in the default decoupled setup.

## Notes / evidence

- Discovered 2026-11-27 while reviewing PR #11 (`markdown/pr11notes.md`).
- Needs headset/runtime confirmation that `vrchatDepth` is indeed inactive on the decoupled renderer.
- Relevant code: `petplay/webxr.ts:2144-2168`, `petplay/webxr.ts:3239`, `petplay/webxr.ts:3796`, `petplay/overlayRenderOwner.ts`.
