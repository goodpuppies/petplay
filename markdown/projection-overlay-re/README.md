# Reverse engineering how SteamVR consumes overlay pose and texture

**Start with the [standalone frame-pacing deep dive](deep-dive.md)** for the complete research
story, corrected findings, GPU and VRChat results, and remaining limitations. For the
**implemented zero-copy Linux fix** (2/3-bank DMA-BUF bind-once + visibility-flip in pure Zig),
see [DMA-BUF overlay bank visibility-flip](dmabuf-bank-visibility-flip.md). The notes below
and linked follow-ups retain the individual experiments and build-specific address details.

Implementation direction: [independent IR renderer and event-driven presenter plan](decoupled-render-present-plan.md).
An [opt-in first implementation](independent-renderer-implementation.md) now separates scene
execution from rendering and publication. It is not the default presenter; image ownership,
full-scene validation, and lifecycle gates remain.

Goal: know exactly when and how `vrcompositor` takes in an overlay's texture and its
projection transform, so PetPlay's projection overlays (`docs/PROJECTION_OVERLAYS.md`) can be
presented without mixed-frame judder by design rather than by an empirically tuned window.

Target build: SteamVR in `~/.local/share/Steam/steamapps/common/SteamVR/bin/linux64/`
(`vrclient.so` BuildID see `file`, `vrcompositor` BuildID `f5c560dcaa16d7b2625ece684b02396505e0768f`).
Addresses below are image-relative virtual addresses as printed by `objdump -d` (Ghidra adds
0x100000). For uprobes, `vrcompositor` text file offset = vaddr - 0x1000.

Follow-up findings: [compositor snapshot and indexed traces](compositor-snapshot.md),
[client events, interface boundary, and present deadline](client-events-and-pacing.md),
[compositor semaphores](compositor-semaphores.md), and
[ownership and coherent publication](ownership-and-publication.md), and
[independent bank pins and interrupted publication](bank-publication.md), and
[parent visibility versus independent projection](parent-projection.md), and
[image lifetime and public DMA-BUF transport](image-lifetime.md), and
[GPU-rendered images, reference handoff, and backing-allocation retirement](gpu-publication-handoff.md), and
[public output-capture audit and the next GPU measurement](output-capture.md), and
[working compositor GPU capture, imported pixels and draw constants](gpu-capture.md), and
[clean projection output and GPU identification of mixed generations](clean-gpu-capture.md), and
[consecutive publication, event alignment, and VRChat measurements](natural-publication.md).
The follow-up corrects the original IPC, GL pooling, vtable-length, and late-ring-reader
interpretations below. The bank experiment also corrects the former visibility/input-method
field confusion. The installed vrclient BuildID is
`c3439e6dd64f87cc2b451764611189cd788d037e`.

The user prefers public APIs, with remaining limitations documented. The current 12–17 ms live
setting is a diagnostic comparison (less judder reported), not the intended portable solution.
The source default remains 11–17 ms. Completion, immutable pose/image coherence, retirement,
and stereo publication still need guarantees; none should be inferred from a timing percentile.

## Established (2026-10-13)

### Sync events

- `IVROverlay_029` (newer than public headers; obtain via `VR_GetGenericInterface("IVROverlay_029")`,
  call through the C++ vtable) has slot 47 `WaitFrameSync` (vrclient `0x3b26e0`,
  `vroverlay.cpp:1175`) and slot 48 **`WaitLatchSync`** (`0x3b2470`, `vroverlay.cpp:1206`).
  Both take `(this, uint32 timeoutMs)` and return `EVROverlayError` (34 = timed out).
- `WaitFrameSync` waits on double-buffered events `VR_Compositor_OverlayVSync0/1`;
  `WaitLatchSync` on `VR_Compositor_OverlayLatched0/1`. The buffer index lives in client shared
  state at `+0x40b40`.
- `vrcompositor` creates all four events (`0x1a9c0c..0x1a9d20`, handles at `this+0x25850/58/68/70`)
  but only signals the VSync pair, in `SendOverlayVSyncEvent` (`0x17ce10`), called from
  `CGraphicsDevice::Present` right after GPU work submission. **The Latched pair is never
  signaled**, so `WaitLatchSync` always times out (verified at runtime with `tools/latch.ts`).

### Transform path

- `SetOverlayTransformProjection` native = vrclient `0x3afad0` (FnTable_027 thunk `0x22b430` →
  adapter `0x201b00` → vtable slot 41). It takes the shared-state lock (`0x3f2e60` guard init,
  `0x3f2ed0` get state, `0x3f2e70` unlock) and **writes the matrix directly into shared memory**:
  overlay slot = state + index*0x614; transform type 8 at `+0x55f0`, projection shape 5/6 at
  `+0x55a0`, matrix written twice at
  `+0x560c` and `+0x563c`, tangents after. No IPC message.

### Texture path

- `SetOverlayTexture` native = `0x3b32a0` → `SetOverlayTextureXR` `0x3b2d40` (`vroverlay.cpp:977`).
  Per overlay slot there is a **5-entry texture ring** at `+0x548c`, stride `0x2c`, current index at
  `+0x5570`. Native shared-texture types search by supplied handle; normal OpenGL submission
  instead selects a free subslot using `0x55fe20` and imports/copies through `0x35fd90`.
  The live indexed trace found one constant shared-image handle per eye despite pooled GL sources.
  `+0x5774/+0x5778` are checked against process identity (error 0xc on ownership mismatch).
  The ring entry is written under the shared lock (`0x55fe90`), then a conditional
  `VREvent_OverlaySharedTextureChanged` (`0x201`) notification is enqueued in shared memory
  (`vfunc 0x10` on `this+0x128`); this is not a demonstrated compositor texture-switch command.
- GL textures are blitted (`glBlitFramebuffer`) into Vulkan images imported into GL
  (`CVRSharedGLTexture`, `glImportMemoryFdEXT`/`glTexStorageMem2DEXT`), synced by a GL/Vulkan
  semaphore (falls back to `glFinish`).

### Timeline (tracefs + SteamVR's built-in gpuvis markers)

SteamVR writes gpuvis markers to `/sys/kernel/tracing/trace_marker` whenever it is writable
(tracefs remounted `uid=1000`; resets on reboot). Per HMD vblank (crtc with 13.33 ms period),
one capture, p50 (p5–p95) ms:

| event | phase |
| --- | --- |
| `[Compositor] NewFrame` | 4.8 (3.1–6.7) |
| `[DrawOverlays]` | 5.6 (3.7–7.5) |
| `[LateLatchHmdPose]` | 6.3 (4.1–8.2) |
| `[Present]` begin = `SendOverlayVSyncEvent` | 7.6 (6.3–9.4) |
| `[Compositor] GPU work finished` | 8.3 (6.9–10.3, max 12.8) |

Observed compositor functions that read the texture ring / transform slot run on `RenderThread`
between `NewFrame` and GPU finished, except
`0x1d5160`/`0x252250` (read `+0x55d8/+0x5774/+0x5778` after GPU finished).
`0x416040`, previously classified as a late ring reader, interpolates UV bounds for input work.
PetPlay's empirically safe present window starts at 11 ms, just past GPU-finished p95.

### Separate pose and texture snapshots (follow-up)

`PrepareForFrame` (`0x24f410`) calls `PushUpdatesToScenegraph` (`0x239c10`), which reads the
shared projection matrix at `0x23a06a` under one shared guard. Later,
`ComputeSystemLayerParams` (`0x258950`) takes another guard and calls `0x23f180`, which reads
the current ring's shared-image handle at `0x23f408` and combines it with the scenegraph pose.
Indexed live tracing confirms this ordering for both PetPlay eyes: median gap 0.24–0.26 ms,
maximum 2.13 ms. Producer updates crossed the interval. See the follow-up for exact evidence
and why API publication generations do not prove which pixels the GPU sampled.

## Open questions (in priority order)

1. **Answered:** pose and current texture use separate shared-memory snapshots; see above.
   Exact GPU pixel generation and shared-image ownership remain open.
2. **Corrected:** `0x201` is an overlay event-ring notification, not the texture-switch command
   originally hypothesized. Ultimate notification consumers were not exhaustively traced.
3. Does the compositor wait on the client blit semaphore before sampling, or can it sample a ring
   image whose blit has not finished (old content + new pose)?
   **Follow-up:** the client queues a second Vulkan copy after the GL blit. Its final-image
   completion semaphores were absent from the observed compositor's final Vulkan wait list.
   `AcquireOverlayView` can pin a ring image; its pixel test and re-acquisition limit are in
   `ownership-and-publication.md`. Sampled pixel generation remains unproven.
4. Full ownership/lifetime rules for the ring's per-entry locks, `+0x55d8`, `0x1d5160`,
   and `0x252250`. `+0x5774/+0x5778` are process identities; `0x416040` is UV interpolation.
5. **Answered for added methods:** `_029` has 84 slots vs 82 in `_028`. Only `WaitLatchSync`
   and the handle getter at slot 68 are added; neither batches texture and transform.
   The getter reads `+0x5574`, whose update/consumption meaning remains unresolved.
6. Is there any compositor-side signal at the actual latch that a client can observe (since
   `OverlayLatched` is unsignaled)?
   The mirror lock/unlock methods are no-ops in this build; they do not supply a retirement fence.

## Tools (`tools/`)

- `probe.sh <secs> <out> <vaddr...>`: uprobes on vrcompositor functions + HMD vblank +
  SteamVR markers into a trace file (needs tracefs owned by the user).
- `phase2.py <trace> [regex]`: phase table of every event vs HMD vblank.
- `snapshot-probe.sh <secs> <out.trace> [SteamVR linux64 directory]`: indexed pose/texture
  shared-read and client-publication probes; refuses an active trace and removes only its probes.
- `snapshot-pairs.py <trace> [overlay slot indices...]`: read-to-read gaps, selected handles,
  and API publication-count differences. Counts are not proof of sampled pixel generations.
- `overlay-view.ts`: isolated hidden 2x2 overlay pixel test of public view pinning and
  same-process re-acquisition; does not change PetPlay's running overlays.
- `copy-submit-probe.sh <out.trace> [secs]`: client GL-input semaphore, Vulkan copy and submit.
- `import-map.sh <out.trace> [secs]`: imported overlay semaphores and final compositor wait list.
- `timing-publication.sh <out.trace> [secs]`: timing-ring advancement versus GPU completion.
  These three scripts have build-specific addresses, refuse an active trace, and remove their probes.
- `str.py <elf> <vaddr...>`: print C strings at virtual addresses.
- `latch.ts`, `ft.ts`: runtime vtable dumps / `WaitLatchSync` probe via `libopenvr_api`.
- `Decomp.java`: Ghidra headless post-script; `DECOMP_ADDRS`/`DECOMP_OUT` env. Ghidra marks
  `0x3f2e60` (lock guard) no-return wrongly, which truncates callers; read objdump there.

## Overlay draw order (2026-10-15, live uprobe)

`DrawOverlays` (`0x187370`, once per eye) draws a set ordered by comparator `0x23bbb0` over items
built in `0x23f180`: (1) `+0x13c` category, 0 = scene-process overlays drawn first unless flagged
`SortWithNonSceneOverlays`; (2) `+0x144` sort order ascending; (3) `+0x124` HMD distance
descending, which is `FLT_MAX` for projection overlays (render type `+0x130` = 2); (4) id.
Probed live with PetPlay's projection overlays at sort order 20 and two display quads at 0: all
category 1, projection drawn last in every pass (`0x185420` quad ×2, then `0x183af0` projection).
Display screens showing "on top" of the projection is therefore PetPlay's own image being
transparent there (the depth-only display stand-in in `displayInstance/ui.tsx`), not compositor
order. Note that removing a uprobe event clears the trace buffer: copy the trace first.

## Performance investigation workflow

See [the optimization runbook](optimization-workflow.md) for real-headset controls,
work counters, Deno CPU profiling, interpretation, validation and recovery.
