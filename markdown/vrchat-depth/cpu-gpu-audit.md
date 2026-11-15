# VR depth: CPU work that could move to the GPU, and data juggling (2026-11-08)

Measured in the lab, VR-only (no desktop view), PartyBox, VRChat presenting its window at
~23–26 fps. CPU percentages are of one core. Sources: V8 profiles of the webxr worker and the
capture helper (`_scratch/perf/prof/`), `perf-petplay` per thread, `top`.

## Where a depth frame goes today

| step | where | cost |
| --- | --- | --- |
| bind VRChat's window pixmap as a texture | helper, GL | ~1 ms/frame |
| `readRect`: block rectangle (~0.75 MB) to CPU, synchronous | helper | ~8 ms/frame blocked on the GPU queue |
| `decodeImage`: locate, header, 128² grid (3D LUT classify) | helper, JS | ~6 % |
| structured clone to the capture worker | helper | small |
| log16 + base64 + JSON + HTTP POST to the agent REPL | capture worker | ~4.5 % |
| HTTP parse, actor message (JSON over websocket) to the intake | main process | part of main's ~6 % |
| JSON decode, re-encode, relay to webxr | intake | ~3 % |
| base64 → log16 → float32 | webxr | ~1 % |
| unproject 128², rotate into tracking, fresh `Float32Array` | webxr | ~1.5 % |
| occluder: bias, cut discontinuities, 16-bit index | webxr | ~1 % |
| raythree extraction, then a **new** raylib mesh (VAO + 7 VBOs) per frame | webxr | ~0.7 % + driver churn |
| V8 GC and compilation in the main process | background threads | ~10 % (not all depth) |

Total for depth: about 46 % of a core across three processes (measured below), plus ~10–15 ms of added
latency from the hops. The block is decoded once on the CPU only for the GPU to get it back as
triangles.

## Baseline before the move (2026-11-08)

`deno run -A utils/vrchat-depth-perf.ts --label=<name> --seconds=30` (records in
`_scratch/perf/baselines/`, compare two with `--compare=a.json,b.json`). Three 30 s runs, VR-only,
head camera on, occlusion on, debug mesh and scan off, 3D calibration; then depth stopped.

| | depth on (3 runs) | depth off |
| --- | --- | --- |
| PetPlay main process CPU | 48.3 / 48.7 / 50.4 % | 23.7 % |
| — webxr worker thread | 29.7–30.2 % | 20.7 % |
| — V8 background threads (GC, compile) | 4 × 3.2–3.7 % ≈ 14 % | < 0.5 % each |
| — main thread (agent REPL relay) | 2.7–2.9 % | |
| GPU capture helper | 17.9–18.2 % CPU, 0.4 % GPU | |
| intake | 3.3–3.7 % | |
| PetPlay main GPU | 8.4 % | 8.1 % |
| VRChat | 187–190 % CPU, 68–71 % GPU | 179 % CPU, 68 % GPU |
| depth frames/s | 24.1–25.1 | |
| headset overlay | 75 fps, 0 dropped presents | 75 fps, 0 dropped |
| webxr render (`raylibOvrRender`) | 0.59 ms/frame | 0.37 ms/frame |
| webxr GL sync (`raylibOvrSync`) | 0.12 ms/frame | 0.00 ms/frame |

Depth costs PetPlay ~46 % of a core in total; garbage collection from the per-frame
allocations is the largest single part (~14 %). The headset frame itself has room: depth adds
0.2 ms of render and 0.1 ms of sync at 75 fps. The move must keep the overlay at 75 fps with no
dropped presents, and `raylibOvrRender` + `raylibOvrSync` within a millisecond or so of today.

## After the move (2026-11-08, `3bb55e3`)

Same tool and state, three 30 s runs (`after-gpu-path-*`):

| | before | after |
| --- | --- | --- |
| PetPlay main process CPU | 48.3–50.4 % | 32.2–35.6 % |
| — V8 background threads | 3.2–3.7 % each | 0.5–0.8 % each |
| GPU capture helper | 18 % | not running |
| intake | 3.3–3.7 % | 0.1–0.2 % |
| depth CPU for PetPlay in total (vs depth off, main 23.7 %) | ~46 % | ~10 % |
| PetPlay GPU (main + helper) | 8.4 + 0.4 % | 8.9 % |
| depth frames/s | 24–25 | 40–41 |
| headset overlay | 75 fps, 0 dropped | 75 fps, 0 dropped |
| `raylibOvrRender` / `raylibOvrSync` | 0.60 / 0.12 ms | 0.49 / 0.00 ms |

Every VRChat present is now decoded (25 → 40 frames/s: the helper's synchronous readback had
been the limit). The remaining ~9 % in the webxr worker is the per-frame header decode (~0.8 ms
× 40), the pixmap binds, and the alignment/lighting work in `handleDepthFrame`.

## The move: decode depth where it's drawn

The webxr worker's render thread has a current GLX context on Xwayland `:0` (checked 2026-11-08),
the same display as VRChat. `gpuWindowCapture.ts` needs nothing more, so the headset renderer
can bind VRChat's window itself:

1. **Occluder from the texture.** A static 128² grid mesh, uploaded once. Its vertex shader
   decodes each sample straight from the window texture (`fetchDepth` from `foreground.ts`, with
   the 3D colour table where calibrated), unprojects with the block's projection and moves into
   tracking with one mat4 uniform. Discontinuities: each vertex compares its neighbours and a
   flag varying discards fragments of torn triangles (the same 6 % rule). Per frame: no CPU
   geometry, no upload, no allocation.
2. **Header only on the CPU.** Camera pose, projection, lighting record and time tag are a few
   rows of cells. Read them with an **async** PBO + fence (one frame later, never blocking the
   headset frame), decode in JS (tiny).
3. **No frame transport.** The helper process, the capture worker, the agent REPL hop, the
   intake relay and the wire format drop out of the VR path. The intake keeps lease, layout
   calibration and scale, fed a small status from webxr instead of frames. The debug view keeps
   its own capture.

Expected: ~25 % of a core and the per-frame allocation churn gone, lower latency (no IPC), the
occluder per frame becomes a texture bind. Cost: ~1 ms of bind on the VR render thread per
VRChat present, and the header readback must stay asynchronous there.

Risks: GL work on the render thread affects headset pacing if anything synchronous slips in
(measure `renderRaythreeFrame` and frame pacing before and after); a dead or resized VRChat
window must not take down webxr (`gpuWindowCapture.ts` already traps X errors); the CPU scan and
debug mesh need positions, so they would read back the 128² grid asynchronously and only while on.

## Smaller, independent items

- **Helper, if the move waits:** decode the 128² grid on the GPU into a small texture and read back
  ~32 KB plus header rows asynchronously, instead of 0.75 MB synchronously and decoding in JS.
- **Allocation churn:** `onVrcDepthFrame` allocates `positions` and decode buffers per frame;
  reuse them. The new raylib mesh per frame could update its VBOs in place
  (`rlUpdateVertexBuffer`) while the CPU occluder exists.
- **Lighting:** `environmentFromRecord` builds arrays per frame (~0.3 %); skip when the record is
  unchanged.

## Not depth, but the same kind of cost

- `buildPayload` (scene extraction, matrix updates) runs every headset frame: ~4.6 %.
- `waitWhileVsyncLate` spins on `GetTimeSinceLastVsync` for the last moments before vsync:
  ~3.4 %, deliberate for pacing accuracy.
- GPU: the overlay renders two 3560² eyes and copies them into a 7120² stacked panorama every
  frame. Most of PetPlay's ~8 % GPU is there, independent of depth.
