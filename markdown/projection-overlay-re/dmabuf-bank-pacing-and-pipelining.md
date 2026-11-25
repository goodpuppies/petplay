# Addendum: Stereo-Panorama Bank Flip, Vsync-Locked Pacing, 1-Frame Async GPU Pipelining, and Implementation Review

This addendum documents the follow-up work after [dmabuf-bank-visibility-flip.md](dmabuf-bank-visibility-flip.md) to make the decoupled renderer the default on Linux and eliminate the remaining occasional and heavy-load wrist jitter in live SteamVR sessions (Bigscreen Beyond @ 75 Hz, VRChat + desktop displays + keyboard + wrist UI).

Credit to [SafariMonkey](https://github.com/SafariMonkey) for originally discovering the bind-once + visibility-flip overlay technique and for sharing key observations on SteamVR's projection-overlay asymmetric-frustum behavior and latch-phase sensitivity.

---

## 1. Extending 3-Bank DMA-BUF Flip to Stereo-Panorama & Defaulting Decoupled Mode

- **Why stereo-panorama remains the primary mode:** SteamVR draws projection overlays behind all quad overlays (including PetPlay's desktop displays). Extending the 3-bank DMA-BUF bind-once + visibility-flip path to `stereopanorama` (`presentMode: "panorama"`) gives PetPlay normal overlay sort order alongside desktop quads while retaining zero-copy DMA-BUF presentation (`~3 µs` publication, zero per-frame `SetOverlayTexture` calls). Projection mode remains available as an alternate mode.
- **Linux default:** `petplay/webxr.ts` now defaults `decoupledRenderer` to `true` on Linux (`--webxr-decoupled-renderer=0` / `--no-webxr-decoupled-renderer` opts out).
- **Files:** `classes/openVrOverlayTexture.ts` (`skipInitialTextureAndShow` + `flipVertical: true` for bottom-up GL FBO → top-down Vulkan/DMA-BUF sampling), `classes/overlayPresenterNative.ts`, `classes/webxrOverlayRaylib.ts` (`setExternalOutputBanks`), `petplay/overlayRenderOwner.ts`.

---

## 2. Diagnosing Remaining Wrist Jitter on Live Hardware

Even with 3-bank DMA-BUF panorama active, live testing in VRChat on a Bigscreen Beyond (75 Hz, `13.333 ms` period, `7736×7736` combined panorama) still showed occasional wrist jitter in normal areas and constant jitter when looking at GPU-heavy areas.

Live `SETFRAMETIMELINE` + `IVRCompositor::GetFrameTiming` captures exposed four distinct issues:

1. **Buggy `vsync` pacer free-running (~113 FPS):**
   - Probing `GetTimeSinceLastVsync` directly on the Beyond showed all 113/113 ticks in 1.5 s advanced cleanly by `+1` at `13.339 ms`, but `secondsSinceLastVsync` occasionally reached `13.4–14.46 ms` right before `frameIndex` incremented.
   - `OpenVrOverlayFramePacer`'s Steam Link guard (`msSinceVsync >= frameDurationMs`) misclassified those `13.4–14.46 ms` readings as an app-limited Steam Link stream, disabled the vsync wait, and dropped the renderer into ~113 FPS free-running.
2. **`frame-sync` (`WaitFrameSync`) starts too late:**
   - `WaitFrameSync` wakes around `4.7–6.3 ms` after vsync (`compositorUpdateEnd`), leaving only `~7–8 ms` before the next vsync (`13.33 ms`).
   - Under VRChat load, `glClientWaitSync` spiked from `1.8 ms` (p50) to `6–17 ms`, pushing `ShowOverlay`/`HideOverlay` past `13.33 ms` into `0–3 ms` of the next vsync (right across `compositorUpdateStart`, causing skipped and doubled frames).
3. **Pre-fence latch holds backfire when `glFinish` runs after the hold:**
   - Setting `panoramaPresentMinMs: 11` *before* `glClientWaitSync` caused `11 ms + ~2.5 ms GPU wait = 13.5 ms`, landing *every* frame at `0–2 ms` of the next vsync and turning occasional jitter into constant jitter.
   - Conversely, flipping at `6–8 ms` straddled SteamVR's `~8.5 ms` overlay latch window (187 sample-to-display latency flips in 5 s).
4. **GPU queue starvation behind VRChat on `amdgpu` (and why `CAP_SYS_NICE` is not shippable):**
   - Even a trivial `256×256` GL clear stalled for `p95 = 8.81 ms, max = 12.32 ms` on `glFinish` while VRChat saturated the RX 7900's `NORMAL` GPU ring (`totalRenderGpuMs: 14–18 ms`), and the `7736×7736` linear DMA-BUF combine added another `~3–5 ms` (`p95 = 12.12 ms, max = 17.12 ms`, 131 skipped vsyncs in 10 s).
   - We implemented an opportunistic Linux EGL 3.3 Core context upgrade (`classes/eglHighPriorityContext.ts` + `eglGetCurrentContext` support in `classes/glHealth.ts`) requesting `EGL_CONTEXT_PRIORITY_HIGH_IMG`. Although Mesa reports `EGL_CONTEXT_PRIORITY_HIGH_IMG` in `eglQueryContext`, a direct `DRM_IOCTL_AMDGPU_CTX` probe against `/dev/dri/renderD128` proved the kernel rejects `AMDGPU_CTX_PRIORITY_HIGH (512)` with **`EACCES` (errno 13)** unless the process holds `CAP_SYS_NICE` (which is why SteamVR ships `vrcompositor-launcher` with `cap_sys_nice=eip`).
   - Because requiring `sudo setcap` is not shippable for PetPlay, the high-priority EGL upgrade stays as a zero-cost opportunistic path (cleanly active with `GL_NO_ERROR`, and automatically effective on any system/driver that grants it), while the real shippable fix had to beat a `12–17 ms` GPU stall **without `sudo`**.

---

## 3. Shippable Fixes (Zero `sudo`)

### 3.1 `vsync-locked` Pacing + Post-Fence Latch Floor
- `petplay/overlayRenderOwner.ts` now defaults to `panoramaPacing: "vsync-locked"` and `panoramaPresentMinMs: 10.5`:
  - Wakes once per HMD vsync at **`phaseMs = 1.5 ms`** (late enough to never wake before `frameIndex` increments and cause `predMs` to teleport from `14.4 ms → 2.2 ms`, yet `~3.5–4.5 ms` earlier than `WaitFrameSync`).
  - If a fresh `frameIndex > lastLockedVsync` has already started (e.g. after a brief decode/GC during `await wait(0)`), runs it immediately instead of skipping a full 13.33 ms period.
  - Waits for the GPU fence **first**, and only holds *after* the fence if `effectivePhaseMs < 10.5 ms`—so fast frames flip cleanly at `10.5 ms` (past the `~8.5 ms` latch) and slow frames flip immediately without adding hold time on top of GPU latency.

### 3.2 1-Frame Async GPU Fence Pipeline Across 3 DMA-BUF Banks
- Added non-blocking split fence primitives in pure Zig (`native/overlayPresenter/src/dmabuf_banks.zig`):
  - `pp_overlay_fence_create()`: inserts `glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0)`, calls `glFlush()`, returns the `GLsync` handle immediately.
  - `pp_overlay_fence_wait(sync, stats)`: waits on the fence via `glClientWaitSync` + `glDeleteSync`.
  - `pp_overlay_fence_delete(sync)`: cleans up unwaited fences on teardown/mode switch.
- In `vsync-locked` 3-bank panorama mode (`overlayRenderOwner.ts`):
  - Frame `N` renders into `nextBank` (distinct from both `activeBank` and `pendingPanorama.bank`) and flushes with `createGpuFence()` without blocking.
  - It then calls `waitGpuFence(pendingPanorama.fence)` for **frame `N - 1`'s bank**, which has already had **`~13.3 ms`** to complete on the GPU in parallel with VRChat, holds until `10.5 ms` if early, and flips `ShowOverlay(N-1)` / `HideOverlay(N-2)` in `~3 µs`.
  - Automatically adds `+1` to `pacer.extraPredictionFrames` to match the 1-frame pipeline depth.
- **Result (10 s live VRChat laggy-area capture, 758 frames, zero `sudo`):**
  - `fenceWait`: **`2.42 / 12.12 / 17.12 ms` → `0.14 / 0.65 / 6.61 ms`** (and **`0.14 / 0.48 / 2.96 ms`** after GC trims) — **18–25× lower p95**.
  - `latch 6 ms` & `latch 8.5 ms`: **`758 / 758` windows — 0 empty (0.0%), 0 double, 0 latency changes**.
  - `present vsync gaps`: **`131` skips → `2` skips (`753 / 757` = 99.5% on exact 1-vsync cadence)**.

### 3.3 Per-Frame Renderer Heap Churn Reductions
- `classes/overlayRenderTracking.ts`: replaced per-anchored-item `new THREE.Matrix4()` / `Vector4` / `Matrix3` allocations in `resolveRenderAnchors` with module-level scratch instances (cutting `sample->render0` heap churn roughly in half).
- `petplay/overlayRenderOwner.ts`: reused scratch `Matrix4` and 16-element arrays for `sampledHead`, `lastRenderTracking.head`, and `renderedAnchors`.
- `classes/glyphText.ts`: added a bounded content-addressed L2 cache (`placementContentCache`, 1024 entries, FNV-1a + exact float check) behind the `WeakMap<Float32Array, ResolvedPlacements>` L1 cache so unchanged text labels arriving in fresh wire packets (triggered whenever a controller ray moves) reuse their resolved typed arrays with zero allocations.

---

## 4. Detailed Review Against SafariMonkey's Visibility-Swap & Symmetric-Frustum Findings

Reviewing PetPlay's current implementation point-by-point against SafariMonkey's visibility-swap design and projection-overlay findings:

| Area | SafariMonkey's Technique / Finding | PetPlay's Current Implementation | Status / Follow-up |
| --- | --- | --- | --- |
| **Texture binding** | Bind each shared texture handle once at startup via `SetOverlayTexture`; never call `SetOverlayTexture` in the frame loop. | Identical: `pp_dmabuf_bank_bind_overlay` binds each `SharedTextureHandle_t` (`TextureType_SharedTextureHandle = 8`) once at startup for both `panorama` and `projection`. | **Matches** |
| **Shared buffer count** | Rotate across `N` (`2` or `3`) pre-bound overlay banks so the producer never overwrites a bank SteamVR may still be sampling. | Default `dmabufBanks = 3` (configurable `2` or `3`). With 1-frame async pipelining in `panorama`, bank `k` renders while `k-1` awaits flip and `k-2` is displayed. | **Matches** (if compositor ever lags >1 frame, a 4th bank would add another full frame of retirement safety at +240 MB VRAM, though 3 banks showed zero tearing/artifacts in live testing). |
| **Atomic handoff / GPU sync** | Render to an unshared RT, `CopyResource` into the shared bank, flush, and wait on a GPU event query before flipping visibility. | Renders directly into the hidden bank's DMA-BUF FBO, then waits on a `GLsync` fence (`glFenceSync` + `glClientWaitSync`) before `ShowOverlay`. Because the bank is hidden during rendering, no intermediate state is ever visible to SteamVR, saving a full-frame VRAM copy. | **Matches intent** (1 fewer copy; hidden bank guarantees atomicity). |
| **Visibility flip order** | Default `ShowOverlay(current)` then `HideOverlay(previous)` (avoiding a 1-frame blank gap if a latch falls between calls). | Identical: `pp_overlay_flip_banks` calls `ShowOverlay` for the new bank(s) first, then `HideOverlay` for the previous bank(s) back-to-back in ~3 µs. | **Matches** |
| **Pacing & latch phase** | `WaitFrameSync(100)` at top of loop + optional pre-submit sleep sweep to stay clear of bad compositor latch phases. | `panorama` uses `vsync-locked` (`phaseMs = 1.5 ms`) + 1-frame async fence + post-fence `panoramaPresentMinMs = 10.5 ms`, keeping flips cleanly in `10–12 ms` even under heavy VRChat GPU load. | **Stronger under GPU contention** (absorbs 12–17 ms VRChat GPU stalls without `sudo`). |
| **Projection mode pipelining** | Projection overlays update `SetOverlayTransformProjection` on the hidden bank before flipping visibility. | `projection` mode already updates transforms on the hidden bank before `pp_overlay_flip_banks`, **but still uses the serial `presentProjectionBank` fence + `WaitFrameSync`**, so it still drops ~15.6% of windows under heavy VRChat load. | **Future follow-up** when revisiting projection mode: port the 1-frame async fence pipeline to `projection` too (and preserve per-bank `cameras` alongside the pending fence so transforms match the rendered pixels). |
| **Symmetric frustum & texture bounds** | SteamVR's projection overlay mishandles asymmetric frusta (treating `uv = 0.5` as the optical axis); either render & submit a symmetric frustum (`±max(|L|,|R|)`, `±max(|T|,|B|)`) or render symmetric and map an off-center sub-region via `SetOverlayTextureBounds` + raw projection. | `overlayRenderOwner.ts` defaults to `projectionMode: "scene-compatible"`, which renders and submits a **symmetric** frustum, avoiding the asymmetric-frustum bug. (`projectionMode: "headset"` is diagnostic-only.) | **Matches**; if we ever want native asymmetric HMD frusta in projection mode without wasting peripheral pixels, apply the symmetric-texture + `SetOverlayTextureBounds` mapping. |
| **Linear vs. tiled DMA-BUF** | Shared textures on D3D11/Vulkan benefit from native GPU tiling/compression. | `dmabuf_banks.zig` currently allocates `VK_IMAGE_TILING_LINEAR` (`ulModifier = 0`). `IVRIPCResourceManagerClient_003::getDmabufModifiers` is already in our vtable struct but unused. | **Optional future optimization**: querying `getDmabufModifiers` + `VK_IMAGE_TILING_DRM_FORMAT_MODIFIER_EXT` could reduce `7736×7736` VRAM bandwidth and idle GPU time further. |
