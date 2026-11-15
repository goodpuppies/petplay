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
- **M2 — remote iroh.** Implemented and tested locally; a two-machine NAT test remains. See below.
- **M3 — a receiver inside PetPlay.** Linux overlay path and Windows GPU reception implemented and tested; Windows
  SteamVR presentation still needs a headset target. See below.
- **M4 — pairing in PetPlay, both directions, more than one stream.**

Input is deliberately out of scope for now. `screen-streamer` already injects through
`/dev/uinput` on Linux, and the viewer already has a pointer channel
([remote-scene-controls.md](remote-scene-controls.md)), so control can be added later without
changing the media path. Audio does not exist anywhere in this stack and is its own track.

## M3 needs no CPU decode and no vendor decoder

The intended path keeps raw frames off the CPU on both platforms:

- **Windows (implemented):** the inbox Media Foundation H.264 MFT uses a D3D11 device manager.
  Output must be NV12 hardware decoder textures; CPU-backed output is rejected. D3D11 video
  processing converts into private BGRA storage, then `CopyResource` updates a persistent shared
  BGRA texture atomically. PetPlay passes its legacy DXGI handle as `TextureType_DXGISharedHandle`.
  No GL interop or raw frame transfer through Deno is involved. The Windows GPU/transport path
  is validated; actual OpenVR submission awaits an HMD or synthetic Windows driver.
- **Linux (implemented):** `moq-vaapi::decode_exported` yields an NV12 DMA-BUF. VA-API VPP
  converts it into a three-slot RGB GBM pool, and a process-owned PetPlay actor imports each
  descriptor with EGL. It blits on GPU into its own GL texture and finishes the read before
  ACKing the reusable slot, then submits `TextureType_OpenGL` to OpenVR. This includes GPU
  color conversion and one presentation copy; it does not download raw pixels.

EGLImages cannot be used in PetPlay's existing GLX context: the first import crashed inside
Mesa. The receiver instead owns an EGL OpenGL pbuffer context in its own actor process,
keeping the main scene's GL context untouched.

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

## M2 as implemented

`--iroh-share` binds an endpoint that can reach a peer across the internet and prints one
pasteable share code. `petplay-media gateway CODE ADDR` consumes it.

No discovery service is involved. iroh's `N0` preset would publish this machine's addresses to
n0's DNS; instead the endpoint uses the `Minimal` preset with only the relay mode added back,
and the viewer seeds the source's addresses into a `MemoryLookup` from the share code. The
consequence is that **a share code is a bearer secret**: it is the only way to find the source
and all that is needed to watch it. It also contains the source's IP addresses. Restricting a
source to specific viewer identities is not implemented and is the obvious M4 addition.

The gateway requires an active direct path within 15 seconds, before starting its browser
WebTransport and HTTP listeners. MoQ track requests are lazy, so while connection setup and
announcements can traverse a relay, there are no downstream consumers to request config/video
frames until the direct gate opens. `GATEWAY_DIRECT` precedes `VIEWER_READY` and `GATEWAY_READY`.
This closes the initial-frame relay window in the first implementation.

The gateway then checks iroh's active route every 100 ms and exits if the direct route is lost.
This is **fail on observed loss**, not a packet-level guarantee against relay traffic: iroh's
path detection and polling can lag a transition, leaving a brief fallback window. A strict
zero-relayed-media guarantee would need enforcement inside the transport's send path.

### Validation

The source and gateway on this machine exercised the real relay-assisted setup path using the
synthetic GBM pattern producer, not real desktop content. The gateway confirmed a direct path
before opening its browser listener. Headless Chromium then decoded 122 frames of the mono
1280×720 stream without decode errors.

After the source was stopped, a second gateway using its share code failed with the direct-path
error. Its browser port remained closed throughout the attempt and it never printed
`GATEWAY_READY`. Unit tests also cover share-code round-tripping, damaged/truncated/versionless
and address-less codes, initial direct-path refusal, and the route-loss guard.

The existing generated `web/dist/viewer.js` was stale (it still required fixed 1920×1080
geometry). Rebuilding the viewer was necessary for the mono browser test; source and gateway
must be started with assets built from the same checkout.

The finite pattern producer can close before its final slot ACK, making the worker report
`slot release failed: Broken pipe` at fixture teardown. This is separate from playback and
remains a producer-drain/shutdown issue; the test does not claim clean source teardown.

Artifacts: `_scratch/m2-direct-gate-result.log` and the private directory it names. Share codes
stay inside the private test logs. No screen contents were captured or recorded.

**Not validated:** a genuinely remote peer across two NATs, forced direct-to-relay migration
with an active stream, and Windows runtime behavior. The receive-only Windows GNU target
passed `cargo check --no-default-features --features iroh` using Zig as the cross C compiler
(the host has no MinGW GCC). Linux full and receive-only test suites pass.

### A receive-only build

The worker linked `moq-vaapi` unconditionally, so the gateway that bridges iroh to browser
WebTransport could not build where VA-API does not exist — which is exactly where the Windows
viewer is. The encoder and its DMA-BUF ingestion now live in `src/source.rs` behind a default-on
`encode` feature, and `--no-default-features --features iroh` produces a binary that can only
run the `gateway` subcommand. M3's Windows receiver needs this split too.

### Next optimization, not a blocker

The worker acknowledges a slot only after the encode finishes, so that ~9.5 ms sits directly in
the latency path, and it re-imports a fresh DMA-BUF every frame rather than caching the three
recurring slots. Both are worth revisiting when latency is measured end to end.


## M3 Linux implementation

Build mediatransport with `cargo build --release --features decode`. An encoder-free Linux
receiver can use `--no-default-features --features decode`. Start the source with
`--layout mono`; the native receiver rejects stereo, unsupported codecs and changing geometry.
The current GPU node is `/dev/dri/renderD128`, and EGL and VA-API need compatible device access.

PetPlay exposes these messages on `main`:

- `STARTREMOTEMEDIA`: `{ "code": "SHARE_CODE", "widthMeters": 1.2, "distance": 1.5 }`.
  Local tests can use `{ "url": "iroh://SOURCE_ID/", "address": "SOURCE_ADDRESS" }` instead.
- `REMOTEMEDIASTATUS`: running/starting, last error, presented frame count and dimensions.
- `STOPREMOTEMEDIA`: stop the native worker, destroy the overlay and release GPU resources.

For example, through the existing opt-in agent REPL:

```sh
curl http://127.0.0.1:3987/message -H 'Content-Type: application/json' \
  --data '{"target":"main","type":"STARTREMOTEMEDIA","payload":{"code":"SHARE_CODE"},"reply":true}'
```

The actor places a regular quad in front of the current headset pose. It is a single-stream
prototype; pairing controls, scene manipulation of the quad, audio and remote desktop input
are not implemented. The main actor must load the updated code to expose the new messages;
there is no reason to restart a live VR session just to install them.

The native worker bounds the encoded queue and waits for a keyframe after reference loss.
The output pool never blocks reference decoding: it drops presentation frames while all
slots are awaiting ACK. The actor drains to the newest available frame, imports it, blits,
finishes GPU reads and ACKs before handing its own texture to OpenVR. Socket files are private
and removed on clean teardown; processes have explicit stop paths and no session expiry.

### Validation

On the RX 7900 XTX, a synthetic 640×480 GBM pattern exercised native encode, local Iroh/MoQ,
VA-API decode, NV12-to-RGB VPP, descriptor transfer, EGL import and OpenVR submission. A hidden
OpenVR overlay accepted 60 frames. Diagnostic-only readback checked the expected RGB gradient
and orientation; the runtime receiver contains no raw pixel readback. Holding all three slot
ACKs for 200 ms produced no fourth descriptor, then reception resumed after release. The
receiver exited cleanly when the consumer disconnected.

The process-owned actor separately completed two start/stop cycles against an unavailable
source without showing an overlay or leaving a receiver process/socket behind. These checks
ran alongside the user's live VR session. Artifacts: `_scratch/m3-openvr-result.log`,
`_scratch/m3-actor-result.log`, and the private synthetic test directory named by the first log.

`deno task check`, Linux Rust tests with `decode`, and the Windows GNU browser-gateway
cross-check pass. At this stage Windows native reception was not yet tested; the subsequent
Windows validation is below. Physical display latency, sustained 4K reception and the visible
quad's placement in-headset remain unmeasured.


## M3 Windows implementation and two-machine validation

Build natively on Windows with:

```sh
cargo build --release --no-default-features --features decode-windows
```

The native `receive SHARE_CODE --stdio` command reads `STOP` from stdin (EOF also stops it).
Stdout emits `WINDOWS_MEDIA_FRAME` JSON records containing version, decimal-string legacy DXGI
handle, dimensions, sequence and source timestamp. There is one persistent presentation texture;
its handle stays fixed across reference resets. Pixels stay in native GPU resources. Use a local
pipe for this metadata; a handle is usable only by processes on the same machine/adapter, never
by the remote peer.

The PetPlay actor now selects a Windows helper, using the same `STARTREMOTEMEDIA`, status and
stop messages. Set `PETPLAY_MEDIA_BINARY` to the receiver executable if it is not at
`submodules/petplay_mediatransport/target/release/petplay-media.exe`. It asks SteamVR for the DXGI
adapter index and passes `PETPLAY_DXGI_ADAPTER` to the native worker, which matters on hybrid
laptops. The native default is the default hardware adapter. The overlay is cleared and destroyed
before the native process is asked to stop and release its texture.

Valve's [shared-handle contract](https://github.com/ValveSoftware/openvr/blob/master/headers/openvr.h)
says the renderer reads this texture directly and updates must use an atomic copy or resolve.
Therefore VPP never writes directly into the shared presentation texture. After the copy, an
event query confirms GPU completion before publishing frame metadata. This is GPU conversion
plus a GPU presentation copy, not a copy-free pipeline. No keyed mutex or timed reuse guess is
used. The native process retains ownership throughout the session.

On the Windows machine `ahtij@100.99.6.30`, a local synthetic H.264 fixture decoded **120/120**
frames into D3D11 decoder surfaces. A second process opened the legacy shared handle and its
1,228,800-byte diagnostic BGRA image exactly matched the owner's snapshot. The image was also
inspected for orientation and color. The DXGI adapters available to the SSH session both
reported AMD Radeon Graphics; both passed 120-frame decode and exact cross-process image checks.
The NVIDIA adapter listed by Windows has not been separately validated. A flush/restart test
also decoded 240 frames across two passes while asserting that the shared handle never changed. These explicit test commands (`decode-test` and `shared-test`)
can read back a diagnostic image; the live receive command never does.

A second test sent a synthetic 640×480 feed from Linux through the real share-code Iroh/MoQ
path to Windows. `RECEIVER_DIRECT` preceded the first video frame. Windows decoded **63 frames**,
a second Windows process opened the live shared texture, and `STOP` shut the receiver down
cleanly. No real desktop was captured. This verifies two machines over their reachable routes;
it does not establish traversal through two unrelated NATs, sustained 4K, or end-to-end latency.

The executable was cross-compiled on Linux for `x86_64-pc-windows-gnu`, using Zig for C/linking
and LLVM dlltool for Rust's raw imports, then copied by SSH. The executable imports only Windows
system DLLs. Zig's linker shim maps winapi import aliases, uses libc/libunwind in place of the
GCC runtime libraries, and handles Rust's module-definition arguments. The exact tested shim
and build logs are retained in `_scratch/windows-link.py` and `_scratch/windows-mf-final-build.log`.
A normal Windows MSVC build does not need these cross-linker adaptations.

Artifacts: `_scratch/windows-mf-runtime.log`, `_scratch/windows-adapter-results.log`,
`_scratch/windows-reset-result.log`, `_scratch/windows-live-result.log`, the private
fixture directory named in that log, and `_scratch/windows-live-shared.png`. Windows test files
live at `C:\Users\jaask\source\petplay-media-test`; no full PetPlay checkout was copied and
SteamVR was not launched. The SSH process is in Windows session 0, while the logged-in desktop
is session 1. Actual PetPlay/OpenVR testing will need the interactive session plus a headset or
Windows synthetic driver. The existing Linux live VR session was left running.

The subscription and bounded encoded-input queue are now shared between both native receivers.
The Linux 60-frame hidden OpenVR test, pool ACK protection, and disconnect check passed again
after that extraction. Windows decoder recovery flushes references while retaining the same
D3D device and shared texture, rather than invalidating the handle held by the overlay.


## Windows desktop sender: normal-session Rust capture

The active sender prototype now uses PetPlay's normal Rust `screen-streamer` (scap / Windows
Graphics Capture), with `--single-monitor` to avoid stitching the whole Windows workspace.
The native media worker accepts its existing BGRA chunked TCP protocol on localhost port
12346. It starts one FFmpeg 8.0.1 NVENC encoder, reads encoded Annex-B access units from that
child, and publishes them on the same mono Iroh/MoQ tracks. The output is 1280×720 with aspect
ratio preserved and black bars as needed, nominally 30 fps at 8 Mbps. Raw frames stay on the
Windows machine, but this capture path does use CPU BGRA, CPU scaling and an encoder upload.
It is the ordinary capture path, not the planned all-GPU Windows sender.

The installed FFmpeg 8.1.2 requires NVENC API 13.1 while this machine's driver provides 13.0.
A portable FFmpeg 8.0.1 was placed inside the experiment directory solely as the hardware
encoder. The installed FFmpeg and GPU drivers were not changed. Earlier FFmpeg capture and
multi-process capture experiments were stopped; their scheduled task was removed.

On Windows, from the interactive desktop session, run:

```powershell
& "$env:USERPROFILE\source\petplay-media-test\Run-RustDesktopStream.cmd"
```

`Start-RustDesktopStream.ps1` starts the native publisher first, waits for its listener, then
starts the normal capturer. It prints the share code and keeps running until Ctrl+C or either
process exits. Cleanup terminates both owned process trees, including the encoder. Logs are
`rust-publisher.log`, `rust-encoder-errors.log`, `rust-capture.log`, and
`rust-capture-errors.log` in the same folder. The publisher log contains the bearer share code;
no raw or encoded desktop frames are recorded.

Local PetPlay was cleanly restarted through the SteamVR launcher on 2026-11-13; SteamVR itself
was left running. `_scratch/watch-windows-rust-stream.py` is detached and waits for a new share
code in the Windows publisher log, then starts the local remote-media overlay at 1.6 m width
and 1.6 m distance. It has no expiry. Its PID is `_scratch/windows-rust-watch.pid`, and its log
is `_scratch/windows-rust-watch.log`. To stop this experiment, stop the watcher, send
`STOPREMOTEMEDIA` to local `main`, and close the Windows launcher with Ctrl+C.

The user is to start capture in the regular Windows session. No successful live desktop
presentation is claimed yet. The normal-session launcher was syntax-checked; the Rust
capturer executable passed `--version`; and a finite 30-frame synthetic test of the exact
chunked frame protocol, NVENC encoding and Iroh publication passed over SSH. Artifacts:
`_scratch/windows-rust-launcher-check.log`, `_scratch/windows-rust-pipeline-result.log`.


## Remote media as a display-instance feed

Connected native receivers now appear as **Remote desktop** in the display's **Feed** selector,
alongside local monitor outputs. The normal workspace/spatial graph assigns the feed to one
display instance. Its move, resize, hinge/anchor placement, opacity, curvature and auto-hide
updates are sent directly to the receiver's overlay using `SYNCVIRTUALDISPLAY`. The existing
standalone quad is reused when assigned, not duplicated. Once managed, unassigning or deleting
the display hides the remote overlay; incoming video does not make an unassigned quad reappear.

Discovery uses Stageforge's local actor control plane (`INSPECT` and receiver health), not the
agent REPL HTTP server. The graph persists `remote:<feedId>` and its friendly name. Provider
actor IDs are runtime metadata only, so restarting the receiver does not invalidate the saved
feed assignment. A stopped/disconnected receiver disappears from available feeds, while its
saved assignment remains disconnected rather than turning into a local desktop. The current
main API still owns one stream; `STARTREMOTEMEDIA` can optionally supply `feedId` and `name`.

Remote feeds are view-only. The scene does not forward their pointer clicks to the local
workspace and does not offer the local mouse-input settings for them. Remote keyboard/input
transport remains a separate feature.

`classes/remoteDisplayBinding.ts` implements the display host pose/style contract on both Linux
and Windows receivers. It supports standing/raw tracking and controller-relative carry. A
250-ms unmount grace matches the existing desktop host's React cleanup behavior, and a new
assignment cancels stale removal. Display instances invalidate their cached pose when switching
providers, ensuring that an unchanged window still sends its pose to the new feed.

The existing live PetPlay scene hot-reloaded safely, and only the remote receiver was reconnected
to load its new handlers. The live layout catalog confirms the remote feed assigned to a normal
display instance (`display-41`). Seven feed/workspace/binding tests passed, including stable feed
identity across provider restarts, input suppression (including the catalog/graph reconciliation gap), raw/controller pose dispatch and stale
cleanup protection. A hidden OpenVR overlay accepted the real binding's pose, width, opacity,
curvature and crop calls without becoming visible. `deno task check` passes.
Artifacts: `_scratch/remote-feed-live-catalog.json`, `_scratch/remote-feed-tests.log`,
`_scratch/remote-feed-openvr.log` and `_scratch/remote-feed-check.log`.
