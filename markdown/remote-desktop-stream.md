# Sharing a desktop overlay with another PetPlay instance

The goal is two people in VRChat, each running PetPlay, where one opens their desktop overlay
and the other sees the same content in their own headset. It reuses the video path built for
the headset-free experiment in [networked-video.md](networked-video.md): capture, GPU encode,
MoQ over iroh, and a receiver.

## What already existed

- Encode, MoQ publication, the iroh endpoint and the browser WebCodecs receiver, in
  `submodules/petplay_mediatransport`.
- A desktop capture helper and the OpenVR overlay it feeds:
  `submodules/screen-streamer` → `classes/ScreenCapturer/` → `petplay/displayOverlayHost.ts`.
- An H.264 **decoder**, in the already-pinned `moq-vaapi 0.2.1`: a stateless VA-API decoder
  whose `decode_exported` returns frames backed by a DMA-BUF.

## What was missing

1. The encoder refused anything but 1920×1080 side-by-side at 75 fps, so no desktop-shaped
   feed could pass through it.
2. Capture could not reach the encoder at all. The PipeWire backend produces CPU pixels over a
   TCP frame socket; the encoder takes only a DMA-BUF and has no software fallback by design.
3. Iroh is loopback-tested only (`--iroh-local`); there is no share code or remote discovery.
4. PetPlay cannot display a decoded frame: nothing turns an encoded stream into an overlay
   texture on any platform.

## Milestones

- **M1 — a desktop feed reaches the encoder.** Done, including real capture; see below.
- **M2 — remote iroh.** A real endpoint with relay and discovery, plus a share code. Ends with
  the other person watching in a browser over the internet, which validates transport before
  any receiver code exists.
- **M3 — a receiver inside PetPlay.** Ends with the actual goal.
- **M4 — pairing in PetPlay, both directions, more than one stream.**

Input is deliberately out of scope for now. `screen-streamer` already injects through
`/dev/uinput` on Linux, and the viewer already has a pointer channel
([remote-scene-controls.md](remote-scene-controls.md)), so control can be added later without
changing the media path. Audio does not exist anywhere in this stack and is its own track.

## M3 needs no CPU decode and no vendor decoder

The receiver is zero-copy on both platforms, and neither side needs NVDEC/NVENC:

- **Windows:** decode with Media Foundation's hardware H.264 MFT in D3D11 mode — vendor-neutral
  across NVIDIA, AMD and Intel, with bindings in the `windows` crate and no ffmpeg DLLs to ship
  — into a texture created `MISC_SHARED`. OpenVR accepts that handle directly as
  `TextureType_DXGISharedHandle` (`openvr_bindings.ts:559`), so a legacy shared handle crosses
  the process boundary as a plain number and Deno submits it unchanged. No GL, no D3D interop
  in Deno, and no copies.
- **Linux:** `moq-vaapi`'s `decode_exported` already yields a DMA-BUF. Import it with
  `EGL_EXT_image_dma_buf_import` into PetPlay's existing GL context and submit today's
  `TextureType_OpenGL`. `classes/openglManager.ts` is already Deno FFI against GL, so this is
  `Deno.dlopen` on libEGL rather than a new native library.

The decision not to decode on the CPU is deliberate: the overlay's existing CPU upload is
affordable at one desktop, but couch gaming wants headroom at higher resolutions.

## M1 as implemented

The encoder is now geometry-driven. The producer's first descriptor fixes width and height
(even, 16–8192); `--fps`, `--bitrate` and `--layout mono|side-by-side` set the rest and feed
the published catalog, which previously hardcoded 1920×1080/75/side-by-side. The browser viewer
reads its geometry from that catalog and, for a single-view source, drops the eye selector and
shows the whole picture.

`screen-streamer --media-socket=<path>` publishes captured frames to the worker. Because the
capture backend is CPU-only, each frame is copied once into a linear **GBM** buffer, which is
both CPU-writable and DMA-BUF exportable, and sent through the existing strict DMA-BUF contract
unchanged. The encoder never reads back. `PETPLAY_DESKTOP_MEDIA_SOCKET` turns this on for
PetPlay's live desktop overlay, which keeps using the frame socket as well.

Mesa rejects `GBM_BO_USE_LINEAR` alongside an explicit modifier list with `EINVAL`; the
explicit linear modifier alone is what the encoder's modifier-zero import needs.

### Deferred: zero-copy capture

The vendored scap negotiates `SPA_DATA_MemFd | SPA_DATA_MemPtr` and rejects DMA-BUF on purpose
(`vendor/scap/src/capturer/engine/linux/mod.rs:107,272`). Real DMA-BUF capture needs modifier
negotiation with the portal, a new frame type through scap's API, and either holding PipeWire
buffers past requeue or a GPU blit into the exportable slot pool. Deferring it costs nothing
architecturally: the protocol, the encoder and the receiver never learn where the pixels came
from, so it changes `screen-streamer` internals only. The interim cost is one memcpy into
GPU-visible memory, against a readback the overlay already performs.

### Validation

`screen-streamer`'s `examples/media_pattern.rs` publishes a moving synthetic pattern through
the real producer, so allocation, export, the descriptor, acknowledgements and the GPU encode
are all exercised without a capture portal and without encoding real screen content.

300 frames at 2560×1440, `--layout mono --fps 60`, RX 7900 XTX: 300 published, 0 dropped, and
`ffprobe` reads the output back as H.264 Main 2560×1440. From the worker's frame journal,
`encode_ms` averaged 9.46 with a p95 of 11.55.

Real capture then ran against the same worker. The KDE ScreenCast portal restored from
PetPlay's existing token with no picker dialog and handed over a single 3840×1080 node covering
both monitors. The session sustained **60.0 fps at 3840×1080 with 540 frames published and 1
dropped**, so the GPU encoder keeps up with the whole desktop at full capture rate. Four
capture sessions in total reached 360–540 frames each.

Nothing was recorded: the worker ran with recording disabled, so no desktop content was written
to disk.

**Open item.** The first capture session failed immediately with a bare `EINVAL` and has not
recurred in four sessions since. It predates the error context now carried by the producer's
map, send and acknowledgement paths, so it cannot be attributed retroactively — it was one of
those three. A recurrence will name its call site.

### Next optimization, not a blocker

The worker acknowledges a slot only after the encode finishes, so that ~9.5 ms sits directly in
the latency path, and it re-imports a fresh DMA-BUF every frame rather than caching the three
recurring slots. Both are worth revisiting when latency is measured end to end.
