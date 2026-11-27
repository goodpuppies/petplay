# Native overlays: UI panels as SteamVR quads

PetPlay normally draws its whole scene into one stereo image glued to the head (the panorama; see
[PROJECTION_OVERLAYS.md](PROJECTION_OVERLAYS.md)). Because the panorama has no depth and is
head-locked, SteamVR cannot reproject it for head movement between render and display, and UI
pixels are resampled twice (eye → panorama → lenses). Desktop screens avoid both problems because
they are already native SteamVR quad overlays.

`overlayPresentMode: "native"` (Settings → General → Overlay Mode → **NATIVE**) promotes PetPlay's
flat UI panels (`uikit` roots) out of the panorama into individual world-placed or device-attached
SteamVR quad overlays, while keeping the default `panorama` mode unchanged.

## Architecture

```text
scene worker (webxr)                      renderer process (overlayRenderOwner)
────────────────────                      ──────────────────────────────────────
extractWebXRRaythreeUi                    eye pass (panorama)
  ui.surfaces[{surfaceId, rootIndex,        stripReadyNativePanels(payload, readySurfaceIds)
    worldMatrix, pixelWidth/Height,           strips ONLY surfaces whose quads are already live
    contentRevision, depthPanelIndex,         keeps their backgrounds in ui.depthOnlyPanels
    nativeOverlay, dynamicOverlay,          renderRaythreeFrame(eyePayload) → submit panorama
    renderAnchor}]                        native pass (AFTER panorama submission)
                                            NativePanelOverlayLayer.present(...)
                                              contentRevision changed? → renderNativePanel (cap 3/frame)
                                              OpenVrNativeOverlays.present → SteamVR quad
```

Key design properties:

- **Built on `ui.surfaces` (`classes/webxrRaythreeUi.ts`):** Each visible `uikit` root exports an
  immutable surface descriptor with a stable epoch-scoped `surfaceId`, a monotonic
  `contentRevision` (bumped only on real content/clipping/text-rendering changes, not pure
  tracking motion), a unified `depthPanelIndex`, and `<PetplayElement renderProps={...}>` policy
  (`nativeOverlay: false` to opt out, `dynamicOverlay: true` auto-enabled for procedural shaders
  such as `glass-chrome`).
- **UI can never vanish:** `stripReadyNativePanels` only removes a surface from the eye image once
  its SteamVR quad is confirmed textured and shown. On a panel's first frame — or if any error
  disables native mode — it stays in the eye image.
- **Never delays the panorama:** `NativePanelOverlayLayer.present` runs *after* panorama
  submission/fencing, with a per-frame redraw cap (`3`) so opening large panels cannot stall the
  panorama.
- **Direct device-local attachment:** Surfaces riding a single tracked device (head, hand,
  one-handed grab) compose `anchorToDevice * rigid(anchor.localMatrix)` directly via
  `OpenVrControllerTipPoseResolver.getTipOffsetMatrix()` without inverting moving world poses,
  so `SetOverlayTransformTrackedDeviceRelative` is sent once and SteamVR tracks the panel at
  display rate.
- **Premultiplied alpha everywhere:** UI, translucent meshes, panorama combine, and all SteamVR
  overlays (`VROverlayFlags_IsPremultiplied = true`) share one premultiplied alpha convention.
- **Bounded resources:** Double-buffered native targets use atomic pair allocation, a 128 MB pool
  byte cap, and full pool teardown on mode-off. SteamVR overlays are capped at 48 total (with FIFO
  hidden eviction and spare trimming).

## Platform findings (SteamVR 2.18.4)

- **Windows (GTX 1660 Ti Max-Q, NVIDIA 576.40, SteamVR 2.18.4, 2026-11-27):**
  - Verified live via remote Iroh renderer (`--mode=native --banks=3`, `dxgi_banks.zig`):
    `transport="DXGI 3-bank panorama flip (7120x7120)"`, `native(panels=1, redraws=1, tx=shared, mis=0)`,
    1,022 frames at 90 Hz with zero errors and zero slot mismatches via `TextureType_DXGISharedHandle`.
  - On the legacy `TextureType_OpenGL` fallback path (`vrclient_x64.dll`), OpenGL overlays lock their
    underlying slot to the dimensions of their first GL texture; `OpenVrNativeOverlays` detects this via
    `GetOverlayTextureSize` and falls back to size-keyed slot parking only when needed.
- **Linux (`vrlab`, Mesa radeonsi / RX 7900 XTX, 2026-11-27):**
  - Verified live with both flat UI panels and 1-mesh stereo grab-box outlines over zero-copy DMA-BUF
    (`transport: "shared"`): upright with default top-down V bounds, `panels: 1`, `stereo: 1`,
    `panelRedraws: 1`, `stereoRedraws: 1`, `presents: 1`, `transforms: 1`, `sizeMismatches: 0`,
    `nativeError: null`.
  - GL slot probe (`_scratch/native-overlays/steamvr_slot_probe.ts`) also confirmed Linux SteamVR
    resizes live GL overlays, recycled slots, and reallocated GL textures in place with zero lock.

## Current scope

- **Flat UI panels + 1-mesh stereo grab-box outlines:** Both render over zero-copy shared textures
  (DMA-BUF / Vulkan on Linux, DXGI / D3D11 on Windows) with automatic `TextureType_OpenGL` fallback.
  Grab-box outlines (`GrabBoxFrame` in `classes/environment/grabbox.tsx`) are a single merged mesh
  wrapped in `<PetplayElement renderProps={{ overlayRole: "stereo", hudOverUi: true }}>`; their
  nearer-face stereo quad is derived directly from `GeometryAsset.bounds.min/max`, redrawing only
  when eyes move past the 0.3 mm parallax threshold (≥2 mm travel) and falling back cleanly to the
  eye image when viewed edge-on or from inside the box.
- **Pointer lasers & cursor dots:** Kept in the eye image so beam and hit-dot stay locked to one
  pose sample and depth-test against panels.

## Code

| File | Role |
| --- | --- |
| `classes/webxrRaythreeUi.ts` | `ui.surfaces` export (`surfaceId`, `contentRevision`, `depthPanelIndex`, `UI_PANEL_DATA`) |
| `classes/renderProps.ts`, `classes/environment/petplayElement.tsx` | Typed `<PetplayElement renderProps={...}>` metadata & geometry shape classifier |
| `classes/nativeOverlayPanels.ts` | Camera framing, direct device-local attachment, ready-gated eye stripping, `NativePanelOverlayLayer` |
| `classes/openVrNativeOverlays.ts` | SteamVR quad lifecycle, in-place resize + Windows slot-mismatch fallback, overlay budget |
| `classes/webxrOverlayRaylib.ts`, `classes/webxrRaythreeRaylibRenderer.ts` | `renderNativePanel`, `renderUiOnly`, byte-capped double-buffered target pool |
| `petplay/overlayRenderOwner.ts`, `petplay/webxr.ts` | Post-panorama native pass, `SETNATIVEPANELS`, settings wiring |
