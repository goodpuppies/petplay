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

- **Windows (Quest Pro / Oculus driver, `vrclient_x64.dll`):** OpenGL overlays permanently lock
  their underlying overlay *slot* (low 32 bits of handle) to the dimensions of their first GL
  texture for the lifetime of the process — even across `DestroyOverlay`.
- **Linux (`vrlab`, Mesa radeonsi / RX 7900 XTX, 2026-11-27):** Tested via
  `_scratch/native-overlays/steamvr_slot_probe.ts`:
  - Live overlay given a different GL texture ID at a new size (`600×400 → 300×500`): **resizes in place**.
  - Recycled overlay slot after `DestroyOverlay` (`640×320 → 320×640`): **resizes in place**.
  - Same GL texture ID reallocated via `glTexImage2D` (`400×300 → 200×500 → 600×600`): **resizes in place**.
  - Live `vrlab` run alongside 3-bank DMA-BUF panorama: upright with default bounds, `nativeError: null`,
    `sizeMismatches: 0`, `spareOverlays: 0`, `presents: 1`, `transforms: 1` over 69,000+ frames.

Accordingly, `OpenVrNativeOverlays` attempts in-place `SetOverlayTexture` updates first (zero slot
churn on Linux) and only falls back to size-keyed slot parking when `GetOverlayTextureSize` reports
a slot-size mismatch (Windows).

## Current scope & future work

- **Zero-copy shared-texture submission (DMA-BUF / DXGI):** Native panel quads use the same
  2-slot `DmabufBankPool` (`OverlayPresenterNative.createDmabufBankPool` + `bindDmabufOverlay`)
  used by the panorama banks — DMA-BUF / Vulkan on Linux and DXGI shared handles on Windows — with
  automatic fallback to `TextureType_OpenGL` when shared banks are disabled (`dmabufBanks = 0`).
  Shared textures bypass `vrclient`'s GL copy path and invert V (`vMin: 1, vMax: 0`) for top-down
  Vulkan/D3D11 sampling.
- **Flat UI panels only (v1):** Grab-box outlines (now a single merged mesh in
  `classes/environment/grabbox.tsx`) and pointer lasers/dots remain in the eye image for v1 so
  beam and hit-dot stay locked to one pose sample and depth-test against panels.

## Code

| File | Role |
| --- | --- |
| `classes/webxrRaythreeUi.ts` | `ui.surfaces` export (`surfaceId`, `contentRevision`, `depthPanelIndex`, `UI_PANEL_DATA`) |
| `classes/renderProps.ts`, `classes/environment/petplayElement.tsx` | Typed `<PetplayElement renderProps={...}>` metadata & geometry shape classifier |
| `classes/nativeOverlayPanels.ts` | Camera framing, direct device-local attachment, ready-gated eye stripping, `NativePanelOverlayLayer` |
| `classes/openVrNativeOverlays.ts` | SteamVR quad lifecycle, in-place resize + Windows slot-mismatch fallback, overlay budget |
| `classes/webxrOverlayRaylib.ts`, `classes/webxrRaythreeRaylibRenderer.ts` | `renderNativePanel`, `renderUiOnly`, byte-capped double-buffered target pool |
| `petplay/overlayRenderOwner.ts`, `petplay/webxr.ts` | Post-panorama native pass, `SETNATIVEPANELS`, settings wiring |
