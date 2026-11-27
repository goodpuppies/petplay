# Native UI panel overlays submit via OpenGL instead of zero-copy shared textures

Status: fixed 2026-11-27 (`classes/nativeOverlayPanels.ts`, `classes/openVrNativeOverlays.ts`, `petplay/overlayRenderOwner.ts`)

## What happens

`classes/openVrNativeOverlays.ts` submits native UI panel quads to SteamVR using
`TextureType_OpenGL` (`SetOverlayTexture` with a raylib GL texture ID). While static panels cost
zero SteamVR calls per frame (redrawing only when `surface.contentRevision` changes), active panels
(typing on the virtual keyboard, scrolling, 1 Hz clocks/OSC, or animated `dynamicOverlay` shaders)
still go through `vrclient`'s OpenGL copy path.

On Windows (`vrclient_x64.dll`), that GL→D3D11 interop path also permanently locks each overlay
slot to the dimensions of its first GL texture, forcing `OpenVrNativeOverlays` to carry
size-quantized slot parking and mismatch detection (`GetOverlayTextureSize`).

## Expected

Submit native UI panel textures through the same zero-copy shared-texture path used by the
panorama/projection banks (DMA-BUF / Vulkan on Linux, DXGI shared handles on Windows), eliminating
the per-redraw GL copy and (once verified on Windows) removing the GL slot-size-lock fallback
machinery.

## Notes / evidence

- Filed 2026-11-27 after landing flat-panel native overlay v1 (`77387f1`, `4a8c26d`) and verifying
  Linux SteamVR 2.18.4 in `vrlab` (`docs/NATIVE_OVERLAYS.md`).
- Relevant code: `classes/openVrNativeOverlays.ts`, `classes/webxrOverlayRaylib.ts`,
  `petplay/overlayRenderOwner.ts`.
