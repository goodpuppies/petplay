# Projection overlay mode cannot sort with native desktop quad overlays

Status: open

## What happens

`overlayPresentMode: "projection"` (`SetOverlayTransformProjection`) eliminates both the head-locked panorama's double resampling (varggles shader) and head-rotation judder (via compositor ATW), while keeping full per-pixel depth testing and VRChat depth occlusion.

However, SteamVR always composites projection overlays *behind* all quad overlays. Because PetPlay's desktop screens are native SteamVR quads, `petplay/webxr.ts:1260` has to suppress the native desktop quads in `projection` mode and fall back to drawing desktop surfaces inside the eye buffers (`drawDesktopSurfaces: !panoramaMode` at `petplay/overlayRenderOwner.ts:1122`). That regresses desktop window text sharpness and keeps `panorama` as the default mode.

## Expected

Document and explore whether `projection` mode can coexist with sharp desktop surfaces (e.g., higher-quality desktop sampling / mipmaps / anisotropic filtering in the eye pass, or selective depth/masking approaches), or confirm the exact SteamVR compositor constraints so we know how far `projection` can be pushed relative to `panorama` and `native`.

## Notes / evidence

- Noted 2026-11-27 while reviewing PR #11 (`feat/native-steamvr-overlays`).
- Relevant code:
  - `petplay/webxr.ts:1260-1270` (`desktopSuppressedForProjection`)
  - `petplay/overlayRenderOwner.ts:1120-1126` (`drawDesktopSurfaces`)
  - `docs/PROJECTION_OVERLAYS.md`
