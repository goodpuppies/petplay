# Networked video: headset-free display experiment

## Next milestone: native video to a browser

The headless proof is committed as driver `0b7bf97` and parent `6913330`. The next target is
OpenVR stereo → native GPU encoder → MoQ → browser WebCodecs, with native iroh connections
available for peer-to-peer legs. The final browser connection uses WebTransport. Deno 2.9.8 on
this machine **does** expose `WebTransport`; keeping encoded frames and transport native is an
ownership/latency choice, not a missing-Deno-API workaround. Deno remains the actor/control plane.

### GPU encoder gate passed

An independent Vulkan producer on the RX 7900 XTX cleared a 1920×1080 BGRA image on the GPU,
released queue ownership, exported a DMA-BUF, and handed its FD to a separate Rust process.
The consumer used published `moq-vaapi = 0.2.1`'s strict `encode_dmabuf` API. The VAAPI video
processor converted the packed RGB image into the encoder surface on the GPU, producing H.264
Main, 4:2:0, BT.709 limited range. Neither producer nor consumer maps raw pixel memory.

The first attempt using Vulkan `LINEAR` tiling with DMA-BUF export was unsupported. Explicit
`VK_IMAGE_TILING_DRM_FORMAT_MODIFIER_EXT` with linear modifier zero succeeded; pitch 7680,
offset zero, allocation size 8,294,400 bytes. The copy/export path must use queried support and
the actual layout, not assume that Vulkan linear tiling is the same negotiation.

Twelve repeated encodes of the same GPU image succeeded. FFmpeg decoded the stream to RGB:
the mean was `[24, 202, 50]` versus Vulkan's approximately `[26, 204, 51]`, within the expected
lossy/color-conversion tolerance. This is a color/layout/interop gate, not an end-to-end stream
or moving-frame performance result. The probe synchronously waits the producer's GPU fence
before starting the consumer; the real source needs a reusable bounded slot pool and release
acknowledgments instead. Only compressed output is read back by the encoder.

Scratch sources/results: `_scratch/gpu-encode-producer.cpp`, `_scratch/gpu-encode-probe/`,
`_scratch/gpu-encode-result.log`, `_scratch/gpu-encode-probe.h264`. The raw Annex-B stream's
`ffprobe` rate guess was 150 fps despite a 75 fps encoder setting (`num_units_in_tick=1`,
`time_scale=150`, `fixed_frame_rate_flag=0`). Timestamp each live frame explicitly; reconcile
catalog/SPS timing before claiming correct browser playback cadence.

### Transport dependency needs an explicit pin

The MoQ reference checkout at `6aa4f9c1cad482aa86adcf3cf26bd7779697a01a` (2026-11-13) removes
iroh in `rs/moq-tokio/MIGRATE.md` / PR 7345, although the public transport docs still describe it.
The downloaded **published** `moq-tokio 0.19.23` retains the `iroh` feature and backend (alongside
native QUIC/WebTransport). It is a verified candidate for retaining the requested iroh path;
do not build against unpinned main and silently lose it. A publisher/player integration against
one compatible Rust/TypeScript version set remains to be tested.

Next implementation boundary: semaphore-ordered GPU copy from the presented image into reusable
exportable slots; native worker imports those DMA-BUFs, encodes without a CPU fallback, and
returns each slot only after encoding finishes. Then publish timestamped H.264 groups and codec
configuration to a local browser before adding remote connectivity and WebXR tracking feedback.

## Update: userspace headless output works

The subsequent userspace Vulkan display experiment succeeded without another privileged change.
SteamVR selects a layer-owned 1920×1080@75 display, whose surface maps to the installed Mesa
driver's real headless swapchain. The 35-second lab window reached 2,250 logged presents.
A bounded moving red-overlay control showed changing positions in both eyes across image reuse,
then disappearance after the overlay was destroyed. Capture waits on the compositor's actual
render semaphore; the synthetic display clock is a separate pacing mechanism.

Implementation, reproduction, validation and limitations:
[`submodules/petplay_ovrdriver/HEADLESS-DISPLAY.md`](../submodules/petplay_ovrdriver/HEADLESS-DISPLAY.md).
The lab option is `--headless-display`; the marker control is
`utils/petplay-ovrdriver-headless-marker.ts`. Encoding and transport are still unimplemented.
The prior DRM experiment's HDMI-A-1 remains forced off, with its EDID removed; this experiment
does not change that kernel state.

The longer run also clarifies the earlier crash interpretation: this compositor presented for
over 30 seconds, then dumped during the lab's requested shutdown. The master monitor disconnect
and vrserver's quit sequence precede the dump. Shutdown and the startup `bad event=1` warning
remain unresolved, so this is a working rendering proof rather than a production-stability result.

## Earlier DRM connector investigation

Continues the 2026-11-13 work in `submodules/petplay_ovrdriver/PRESENT-BOUNDARY.md`.

## Intended paths

- No physical headset: OpenVR scene → PetPlay native video → moq → browser WebXR or desktop
  controls. The virtual HMD is a production source, with remote tracking eventually driving it.
- Physical headset: normal VR gameplay → PetPlay native video → moq → another PetPlay instance.

Deno orchestrates the pipeline; GPU images, synchronization, encoding and transport should stay
native. Encoding and moq transport are not implemented by this experiment.

## Current evidence

The physical-headset present-boundary proof is committed in driver revision `e1b48b6`. It uses
the compositor's real render wait semaphore and replaces the present wait with its own completion.
It has not yet demonstrated temporal freshness with moving scene content or a sustained encoder.

The driver-direct semaphore experiment proves that a newly allocated, unregistered resource-manager
timeline semaphore does not advance spontaneously. It does **not** prove that every possible
producer-side synchronization or interception mechanism is unavailable. There is still no validated
completion contract for the current driver-direct reader.

The inherited virtual-display patch disabled the debug property but still reported a fictional
desktop display through `IVRDisplayComponent` and registered the old DisplayRedirect sink. The
continuation fixes those contradictions and disables the compositor plugin for DRM-panel mode.
The launcher uses a scoped `redirectsDisplay=false` manifest, leaving the built driver manifest
intact. Default sessions explicitly clear `virtualDisplay` in their scoped settings.

Two unprivileged baseline sessions (12:54 and 12:56 local time) reached:

```
Looking for direct display through RandR
Looking for direct display through Vulkan WSI
CHmdWindowSDL: Failed to create direct mode surface
```

The first searched for the old 1280×720 default. The second correctly searched for 1920×1080
using the new `virtual1080` preset. Neither baseline had a matching connected display; both
restored the original settings and registrations. These runs are not a test of the forced connector.
Logs: `logs/ovrdriver-lab/20261113-125429` and `20261113-125704`.

## Temporary connector experiment

Target only the disconnected, disabled HDMI-A-1 connector on AMD GPU `0000:09:00.0`, currently
`card1`. Do not touch the desktop monitor or the physical headset connector.

The original 128-byte prototype EDID described an ordinary monitor. The revised scratch EDID
adds a DisplayID 2.0 extension with primary use case 7 (head-mounted VR), allowing the kernel to
identify a non-desktop output without pretending to be a known headset vendor. `edid-decode`
reports PPL/product 20560, 1920×1080 at 75 Hz, and correct base, extension and DisplayID checksums.
Whether KDE offers that forced connector for a DRM lease remains untested.

Scratch artifacts:

- `_scratch/petplay-virtual-hmd.edid`: 256-byte prototype; SHA-256
  `5df981fb906a6f84714316cba8f1ce6848a47de878c2b359bd1ae5c7789c1178`.
- `_scratch/virtual-display-window.py`: fixed-target elevated helper. Refuses an active connector,
  existing force/override, wrong GPU, or changed EDID. Applies the override and forces connection
  for 90 seconds; `finally` resets the override and attempts automatic detection. If the kernel
  retains a stale connected state, it leaves this unused connector forced off and warns. SIGKILL or a
  hardware/kernel failure can prevent cleanup. No firmware installation or boot change.

During that window, with SteamVR initially off:

```sh
python3 utils/petplay-ovrdriver-lab.py run \
  --virtual-display 16908:20560 --display-profile virtual1080 \
  --present-audit --present-proof 3 \
  --direct-server --x11-compositor --guard-monitor --seconds 30
```

Success requires a display-surface swapchain with the expected extent, actual presents carrying
render waits, and usable stereo pixels. A connected sysfs node alone is insufficient. If the
display cannot be leased or produces no vblank, record that failure rather than treating EDID
recognition as a working headless compositor.

## Validation

- `zig build test -Doptimize=ReleaseSafe` and `zig build -Doptimize=ReleaseSafe` pass.
- ABI fixture checks DRM-mode display flags, EDID properties, absent DisplayRedirect device,
  and refusal of the legacy compositor plugin. Existing default/direct-mode tests still pass.
- Isolated launcher fixtures verify virtual/default settings, scoped manifest, output geometry,
  and byte-exact settings/registration restoration without launching SteamVR.
- Plain `zig build test` currently fails in the debug executable linker on system CRT `.sframe`
  relocations (`R_X86_64_PC64`); the documented ReleaseSafe configuration succeeds.

The first graphical authorization expired without approval. The user requested a retry and
approved it. At 13:05 local time, the helper successfully forced HDMI-A-1 connected and sysfs
exposed the expected 1920×1080 mode and complete VR EDID. However, `kscreen-doctor -o` still
listed only the existing desktop outputs, and SteamVR's RandR search saw only 3440×1440 and
5088×2544. Both RandR and Vulkan WSI searches failed to find the synthetic panel. SteamVR fell
back to a 1920×1080 platform-window swapchain (`mode=1`, `waits=1`), not a display surface; the
proof directory `logs/ovrdriver-lab/present-audit-lzy3t8lp/frames` remained empty. The lab stopped
and restored its settings and driver registrations normally.

This confirms EDID injection and forced kernel connection, **not** discovery or leasing. The
helper currently reprobes through sysfs but sends no explicit DRM hotplug notification. Missing
notification is a candidate explanation for the desktop compositor not discovering the output;
it has not been tested. Do not rule out the virtual-display approach from this result.

Cleanup caveat: the first helper's `reset`/`detect` completed but left sysfs reporting connected
with the synthetic EDID. Its success exit therefore did not establish full restoration. A follow-up
cleanup request resets the override, cycles off/detect, and leaves the unused connector forced off
if automatic detection still reports the stale connection. The scratch helper now checks this too.
The user approved this cleanup; final verification was `force=off status=disconnected
overrideBytes=0 edidBytes=0`. HDMI-A-1 is left forced off rather than in automatic-detection mode.
Writing `detect` restores automatic detection, but immediately doing so reproduced the stale
connection in this experiment. A fresh hardware hotplug or reboot may be needed to clear the
driver's cached sink; that has not been tested.

The virtual-panel and headless-display work is committed in driver revision `0b7bf97`.
The pre-existing `raythree` change is unrelated and was left outside these commits.

### Native media path and initial browser pacing (2026-11-13)

The current uncommitted prototype copies the headless swapchain into a three-slot Vulkan
DMA-BUF pool and hands the DMA-BUF plus SYNC_FD to `submodules/petplay_mediatransport` over a Unix seqpacket
socket. Exact sequence ACK plus GPU completion gate reuse. Saturation drops captures rather
than blocking presentation. Rust imports directly into VAAPI, does GPU RGB-to-NV12 conversion,
and encodes H.264. No CPU raw-frame fallback is enabled. The source publishes custom `config`
and timestamped Annex-B `video` MoQ tracks over loopback-only Iroh; a native gateway relays
these tracks over WebTransport to the browser. This is not yet a generic Hang catalog or a
remote-Iroh connectivity test. Source is fixed at 1920×1080, side-by-side, 75 fps, 12 Mbps.

A tailnet-only HTTPS Serve route on port 8449 exposes the viewer; WebTransport uses UDP4470
on the Tailscale interface with a pinned ephemeral certificate. The temporary supervisor in
`_scratch/serve-tailnet-media.py` runs a bounded ten-minute lab, restores SteamVR configuration,
and removes only its own Serve route on exit. It writes no encoded recording. SteamVR lab
shutdown still aborts the compositor and can reset the worker socket; clean teardown remains
unfinished.

User feedback identified uneven pacing. The original viewer drew immediately on decoder
output and reset the decoder whenever its input queue exceeded six chunks. It now maps capture
timestamps onto the browser clock, queues decoded VideoFrames for requestAnimationFrame,
selects the latest due frame each display tick, and starts with a 20 ms jitter cushion. Query
`?buffer=0` through `?buffer=100` adjusts that cushion. Presentation queue is bounded to twelve
frames. Decode submission yields above six queued chunks and resets only if the queue remains
blocked for a second, rather than discarding a GOP immediately on a delivery burst. Stalls over 150 ms re-anchor
instead of replaying old frames. `window.petplayStream` retains bounded timing samples for
source intervals, delivery intervals, presentation intervals, and scheduled lateness. These
are browser submission timings, not physical scanout or end-to-end latency measurements.

Headless Chromium on the tailnet URL: 507 received/decoded, 401 presented, zero decode skips
or errors. Source interval p50/p95 13.344/13.740 ms; arrival p50/p95 13.4/17.1 ms;
presentation p50/p95 16.7/16.7 ms, maximum 33.3 ms. 101 decoded frames were superseded at
presentation, expected when displaying a 75 fps source on a 60 Hz browser clock. This verifies
the local pipeline and timestamp scheduling; subjective remote smoothness still needs feedback.
The headless decoder selected `no-preference`; browser hardware decode was not established.

Viewer checks: `bun run --cwd submodules/petplay_mediatransport/web check` and `bun run --cwd submodules/petplay_mediatransport/web build`.
Native build/test: `cargo test --manifest-path submodules/petplay_mediatransport/Cargo.toml --release --features iroh`.

Follow-up: user reported a freeze after roughly one second in the paced viewer. This has not
been reproduced locally: a late-join 30-second headless run received 2296 / decoded 2221 /
presented 1774 frames, with no errors; initial backlog triggered one decode reset. Do not treat
this local result as resolving the remote freeze. The viewer now displays live receive/decode/
presentation counters once per second, catches presentation exceptions, and resets a configured
decoder that has produced no output for two seconds while data continues arriving (then waits
for a keyframe). `?immediate=1` bypasses presentation buffering for comparison; `?software=1`
requests software decoding. Both flags can be combined. Remote browser/device and counters
at the freeze are needed to distinguish transport, decode, and presentation failures.

The earlier immediate-reset policy also affected late join: cached groups could enqueue faster
than decoder tasks run and cause avoidable GOP loss. The receive loop now awaits dequeue
events (with a bounded timeout) before submitting more chunks. This fix addresses that local
mechanism; the remote one-second freeze still requires confirmation after refresh.

A subsequent late-join run did reproduce a presentation freeze: receive/decode continued,
while shown stayed at one and the bounded presentation queue continually evicted frames.
An old cached GOP anchored the clock behind the live edge, leaving queued frames perpetually
scheduled in the future. The presentation clock now takes the minimum offset observed from
decoded arrivals, bringing cached-GOP deadlines forward while preserving source intervals and
the requested cushion. This is separate from decode backpressure. User reported playback
recovered during investigation; the additional late-join correction still merits verification.

Final served-build check after the clock correction: 30 seconds, 2281 received and decoded,
1802 presented, zero decode skips and no errors. Presentation counters advanced throughout.
User also confirmed playback recovered. Current bounded tailnet session expires at 14:29:58
Helsinki time; the route is temporary.

### Media repository extraction

The media worker, transport gateway, and browser receiver now live in the public repository
https://github.com/goodpuppies/petplay_mediatransport, registered as the PetPlay submodule
`submodules/petplay_mediatransport` on `main`. Initial revision is
`11868b1d827f42faba1b9566c3b975ab00e557da`. Cargo package name is
`petplay-mediatransport`; the executable remains `petplay-media`.

The user specified that PetPlay submodules inherit the root `AGENTS.md` and need no separate
copy. The new repository has build/run instructions and prototype protocol documentation;
OpenVR capture stays in the driver. The intended scope is broader media source, destination,
and forwarding adapters, while current implementation remains a Linux VAAPI video prototype.

Validation after relocation: native release build and two tests passed, browser type-check and
bundle passed, parent `deno task check` passed. A gateway built from the extracted checkout
relayed the existing Iroh feed to a headless browser: 529 received, 528 decoded, 401 presented,
zero decode skips or errors. Parent integration changes remain uncommitted.
