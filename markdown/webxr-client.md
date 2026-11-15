# WebXR client: a headset that only needs a browser

The browser stream viewer can now be a VR client, as an alternative to WiVRn/ALVR that needs
only WebXR, WebCodecs and WebTransport in the headset's browser. First target: Quest Browser.

```
headset browser ── head/controller poses, buttons (WebSocket) ──► xr-client-bridge ──► synthetic driver
      ▲                                                                               (HMD + Touch)
      └── H.264 side-by-side (MoQ/WebTransport) ◄── gateway ◄── iroh ◄── VAAPI ◄── headless SteamVR
```

The video path is the existing headless pipeline from [networked-video.md](networked-video.md).
This adds the return path and a WebXR presenter.

## What exists

1. **Driver** (`submodules/petplay_ovrdriver`)
   - `SETHMDPOSE {position, rotation, velocity?, angularVelocity?}` holds the synthetic head;
     `{clear:true}` returns it to the fixed standing pose. `HEALTH` reports `syntheticHmdHeld`.
   - `fovTanLeft/Right/Up/Down` (left-eye tangents, right eye mirrored) join the display profile.
     The lab accepts `--fov-tangents L,R,U,D` and `--ipd M` on top of any profile, including
     `--headless-display`.
2. **Viewer** (`submodules/petplay_mediatransport/web/src/xr.ts`)
   - "Enter VR" appears for a side-by-side stream when `immersive-vr` is supported.
   - Each eye's half of the picture is drawn on z = −1 of that eye's view space, spanning the
     source frustum. This is geometrically correct whatever the headset's own FOV is; a narrower
     source only leaves black edges. The XR frame loop takes pictures through the same
     timestamp pacing as the 2D canvas.
   - With `?xr=wss://…/xr` it streams, every XR frame: head pose and linear velocity, both grip
     poses, and xr-standard gamepad state (trigger, squeeze, stick, stick click, A/X, B/Y).
     `?xrAngular=1` also sends angular velocity (off by default until its frame is verified
     against SteamVR's prediction). It also sends its views once, for a matching profile.
3. **Bridge** (`deno task xrclient`, `utils/xr-client-bridge.ts`, `classes/xrClientBridge.ts`)
   - Loopback WebSocket with an exact origin check; one headset at a time.
   - Validates every packet; writes `SETHMDPOSE`/`SETCONTROLLERPOSE`/`SETCONTROLLERINPUT` with
     one request in flight and only the newest pending command per device. Inputs are sent
     on change. A failing device does not stall the head. Disconnect releases everything.
   - Prints `XR_VIEWS suggested driver_petplay={fovTan…, ipdMeters, render size}` from the
     headset's actual projections: use those numbers for `--fov-tangents`/`--ipd`.

WebXR `local-floor` and the driver's raw standing space are both right-handed, y-up,
−z-forward metres on the floor, so poses pass through unchanged.

## Running it with a Quest

WebXR and WebTransport both need HTTPS. The Quest must be on the tailnet.
`_scratch/serve-tailnet-xr.py` is the tailnet supervisor variant of the existing controls
session: media worker, gateway on the Tailscale address, headless lab with Touch controllers,
keepalive, bridge, and `tailscale serve` routes 8449 (viewer) and 8451 (bridge). It prints the
URL to open (`https://…:8449/?xr=wss%3A%2F%2F…%3A8451%2Fxr`). It refuses to start while SteamVR
or PetPlay is running. `--with-petplay` also starts PetPlay on the synthetic headset.

1. Start once with defaults, enter VR, and read `XR_VIEWS` from the session's `bridge.log`.
2. Restart with `--fov-tangents L,R,U,D --ipd M` from that line. The headless display stays
   1920×1080 (960×1080 per eye), so pixels are not square for most headsets; geometry is
   still correct because the presenter maps by tangent, not by pixel.

## Validation

- Driver: `zig build test -Doptimize=ReleaseSafe` (held-head unit test, SETHMDPOSE validation,
  mirrored asymmetric projection through the official-header ABI consumer).
- Bridge: `deno test -A classes/xrClientBridge.test.ts` (validation, tangent recovery from
  off-axis matrices, profile union after mirroring, latest-wins writer, release).
- Viewer: `bun run --cwd submodules/petplay_mediatransport/web check` and `build`.
- End to end without SteamVR: `python3 _scratch/xr-client-e2e/run.py`. IWER emulates a Quest 3
  in headless Chromium; the real presenter, real bridge and the real driver library (hosted by
  an ABI fixture with HMD and controllers enabled) run. Result on 2026-11-15: left eye showed
  the left half and right eye the right half, the top band landed at the top; the driver held
  head (0.1, 1.7, −0.2) with exactly the emulated 30° yaw, the right grip pose, and the trigger
  press (click and value 1.0). The presenter ran at the emulated 61 fps.

**On a real Quest 3 (Quest Browser 156, 2026-11-15)** the stream decoded in hardware and the
headset drove SteamVR. Its views gave `--fov-tangents 1.3764,0.8391,0.9657,1.4281 --ipd 0.0713`.
Two bugs surfaced. `session.inputSources` is an array-like `XRInputSourceArray` without `.some()`,
which IWER's plain array had hidden; every XR frame threw before drawing. And OpenVR's raw `top`
is the image's *downward* edge: with Quest's uneven up/down FOV the picture was stretched
vertically. A marker overlay held 1 m ahead of the synthetic head
(`_scratch/quest-cdp/center-marker.ts`) moved from 59.5% to the expected 40.3% down each eye
after the driver swapped them; across, it sat exactly at the predicted 63.7% / 36.2%.

**Not yet tested:** VRChat bindings with streamed Touch input,
and the grip-to-`/pose/raw` offset (the Touch profile's raw pose may not equal WebXR's grip).

## Latency work (2026-11-15, Quest 3, home Wi-Fi over Tailscale)

Pose-to-display latency is measured end to end: each head pose carries the browser's frame
sequence, the driver echoes it into the pose ring, the worker tags the frame rendered from it,
and the viewer times send → draw. It went **83 → 69 → 55 → 41 ms**, steady to within 1 ms.

- **Frames carry their head pose.** The driver latches the held head pose once per display
  frame, `poseLatchLeadUs` (2 ms) before each tick, on the same absolute CLOCK_MONOTONIC grid
  as the headless display, and pushes it to SteamVR at once. It writes each latched pose to
  `hmd-poses` beside the control socket (64-byte seqlocked entries: latch time, client
  sequence, rotation, position, arrival time). The worker (`--pose-ring PATH`) tags each frame
  with the newest pose latched before its capture and publishes it on a `pose` MoQ track with
  the video timestamp. Without latching, network-jittered poses made the tag off by one update
  and the warp jittered while turning.
- **Rotational timewarp** in the presenter rotates each eye quad by q_now⁻¹ · q_rendered.
  `?warp=0` turns it off.
- **Head prediction.** The presenter sends the head pose extrapolated by the measured latency
  with the runtime's velocities (`petplayStream.xr.predictScale`, default 1). The frame is
  tagged with the predicted pose, so the warp only corrects the prediction error.
- **72 Hz end to end.** Quest Browser offers 72/80/90/120 Hz, not 75. The headless display mode
  is now `PP_HEADLESS_MODE=WxH@HZ` (lab: `--headless-size`, `--refresh-hz`), the session asks
  the headset for the stream's rate (`updateTargetFrameRate`, not awaited: Quest resolves it
  only once frames are submitted, and awaiting it first left a black session).
- **No viewer queue in XR.** The XR path ignores the 2D jitter buffer and shows the oldest
  decoded picture each display frame, keeping `xrQueue` (default 1, `?xrQueue=0` recommended)
  behind it. A queue that never drained cost three frames.
- **H.264 POC type 2.** Quest's Qualcomm hardware decoder held every picture until the next one
  arrived (18.7 ms receive → decoded) despite `max_num_reorder_frames = 0`. The vendored
  `moq-vaapi` (see its `PETPLAY-PATCH.md`) writes POC type 2: 4.5 ms.

Breakdown at 41 ms: pose arrival → latch 10.3, latch → capture 12.0 (the compositor captures
~10 ms after the tick), capture → published 7.3, receive → decoded 4.5, decoded → drawn 1.5,
network both ways ~5.5. With `xrQueue=0` about 3% of frames are dropped: the PC and Quest
72 Hz clocks are independent, so arrivals sometimes straddle a Quest frame boundary.

## Resolution, LAN media and controller pacing (2026-11-15)

- **3360×1760 at 80 Mbps** (`--size`, `--bitrate` in the supervisor). Through Tailscale this
  dropped ~13% of frames, so media now goes straight over the LAN: the gateway listens on all
  interfaces, ufw allows UDP 4470 from `192.168.1.0/24` only, and the viewer's
  `?media=192.168.1.101` points WebTransport at the PC while the page and bridge stay on the
  tailnet. Quest decodes 3360×1760 in 8–12 ms.
- **Keyframes** every `--keyframe-seconds` (default 1). Each keyframe starts a MoQ group and
  moq-net aborts a group past 32 MB ("group too large"), so the worker refuses intervals whose
  group would exceed 24 MB: at 80 Mbps that is at most 2 s.
- **Controllers latch between real samples.** Head poses are tagged per frame and warped, so
  arrival jitter never showed on the head; hands simply took the newest pose, and 13% of
  display frames got no new pose or two. Each uplink frame now carries the browser's XR frame
  time and the hands' velocities. The driver maps the client clock onto its own (2 s sliding
  minimum of arrival − client time) and keeps 16 samples per hand. Each latch interpolates
  between the two real samples around a client time `margin` behind the mapping and carries
  the result forward by that margin. The margin is one sample interval plus the 98th
  percentile of lateness, slew-limited. A first version carried the newest sample by its age
  instead; that horizon varied 0–30 ms, and the Quest's smoothed velocity turned it into
  jitter (driver output 3–4× rougher than its input). Now the horizon is constant, so velocity
  error is a small steady offset: on a capture at 0.8 m/s the latched hand's roughness (p95 of
  the second difference) was 2.18 mm against 2.12 mm going in.
- **Root cause of the "looping" stutter: the GPU's video clock.** About twice a second,
  pictures left the worker progressively later, then caught up in a burst. The worker's
  per-frame trace (`PETPLAY_FRAME_TRACE`) showed the VAAPI encode time itself cycling
  5 → 16 ms on a ~0.6 s period while the 7900 XTX's VCLK swung 513 ↔ ~1430 MHz: with an
  otherwise idle GPU (headless SteamVR renders almost nothing) power management downclocks
  the video engine until encoding is continuously busy, then clocks back up.
  `power_dpm_force_performance_level=high` does not hold VCLK on this card. Pinning it
  (`manual`, `pp_dpm_vclk`/`pp_dpm_dclk` = top level) made encode 4.0–4.8 ms (was 4–19 ms, 30%
  over the frame budget) and loopback arrival p95 1.1 ms above minimum (was ~35 ms). The
  setting is not yet persistent. On the way there, the transport was ruled out: a server qlog
  (`--features qlog`, `MOQ_QUIC_QLOG=DIR`) showed noq sending each picture the moment it was
  handed over, and Wi-Fi, bitrate, congestion control, pacing and flow control made no
  difference.
- **Viewer pacing: `steady` (default).** With pictures arriving evenly, the next picture's
  decode (~13 ms at 3360×1760 on Quest) often finished right at the display deadline, so
  "show the newest" skipped and repeated in 42% of frames. Steady pacing shows the next
  picture in order and catches up only after being behind for `xrCatchUpFrames` (36):
  0.2% repeats/skips, 55 ms median pose-to-display. `?xrPacing=queue` restores the old policy.
- Pacing tools: `petplayStream.xr.handTrace = []` records per-frame picture, arrival, decode
  and grip data on the Quest; the driver writes latched hands to `hand-poses` beside
  `hmd-poses`; `_scratch/pacing-analyze.py` and `_scratch/media-browser-test/transit.mjs`
  (loopback, decoder stubbed) summarize them.

## Hot reload

`presenter.ts` (upload, timewarp, prediction, uplink) is built separately to
`dist/presenter.js`. The shell (`xr.ts`) owns the session, GL context, texture, bridge socket and
pose sequence, polls `/build` each second while immersive and swaps in a new presenter without
ending the session. A presenter that throws within 30 frames is replaced by the previous one.
The gateway reads viewer files per request. A changed shell or connection still needs a page
reload; `navigator.xr.offerSession` then shows the browser's own entry prompt.
The harness `_scratch/xr-client-e2e/run.py` checks a live swap and the broken-build fallback.

## Known limits and next steps

- **Clock lock.** Steer the headless display's tick to the Quest's frame phase so poses arrive
  just before the latch (saves ~9 ms) and pictures arrive mid-interval (no drops).
- **Latch → capture 12 ms**: latch closer to when the compositor samples the pose.
- **Resolution and codec**: the headless mode now takes any size; Quest decodes H.264 High,
  HEVC and AV1 in hardware at 3840×1920; bitrate is still 12 Mbps.
- Head translation is predicted but not warped.
- **Uplink is a separate WebSocket.** Moving poses onto the media path (gateway → iroh → source)
  would make a remote headset need only the viewer URL.
- The Quest menu button is not exposed to web pages. Pressing both sticks together is the left
  menu button (`system`) instead, held as long as the chord is; neither stick clicks meanwhile.

## Passthrough key-camera experiment (2026-11-15)

**Status: browser AR keying works; camera passthrough is not working end to end.** The
legacy camera reaches an unimplemented renderer operation. The newer Frame API accepts
DMA-BUF registration on desktop SteamVR, but no camera reader has attached. The current
stream was verified healthy with the experimental Frame profile. Camera work is parked.

The proposed route is a synthetic HMD camera filled with `ff00ff`: SteamVR paints the key
where Room View would display the room; the remote headset removes that colour over its
own native passthrough. No real camera images need to leave the headset.

- `--passthrough-key ff00ff` in `utils/petplay-ovrdriver-lab.py` sets the opt-in
  `driver_petplay.passthroughKeyRgb` and `framePassthrough=true`. Frame mode advertises
  `Prop_Hmd_SupportsRoomViewDirect_Bool`, excludes the legacy camera component and queue,
  and selects `roomView=2`, `roomViewStyle=4`. It requires a separate DMA-BUF producer; the
  profile alone does not create passthrough. Camera settings are included in exact lab
  backup/restore. The legacy implementation remains available through explicit driver
  settings with `framePassthrough=false`; activating it crashes this compositor build.
- `camera.zig` implements `IVRCameraComponent_003`; `camera_queue.zig` isolates the private,
  versioned `IVRBlockQueue_005` / `IVRPaths_002` bindings. The compositor connects directly to
  `/lighthouse/camera/raw_frames`; the public camera component alone is insufficient. Queue
  dimensions and format live on the queue handle; frame sequence (uint64), byte size,
  monotonic time, server ticks, delivery interval and elapsed time live on each acquired
  block. Frames are RGBX at 640×480, 30 Hz. Missing private interfaces leave the optional
  public implementation available. The queue owner is destroyed after its producer joins.
- The camera firmware must exceed `0x200040048`. A value of two billion is too low.
  Distortion coefficients contain doubles but use the float property tag. Private-queue
  startup must not mark the public stream active: SteamVR needs to initialize that stream
  itself. In queue mode the public frame getter returns null and no sink callback is issued,
  avoiding a loop polling rejected public frames.
- Viewer `?xrMode=ar` selects `immersive-ar` for support checks, browser offers and entry;
  default remains VR. `?xrKey=RRGGBB` overrides magenta. The XR framebuffer carries alpha,
  clears transparently, and the presenter uses soft chroma keying and premultiplied output
  with key-colour removal at mixed edges. This is a prototype: similarly coloured content
  can disappear and compressed edges still need real-headset evaluation.

### Evidence and remaining blocker

SteamVR 2.18.4, Linux x86-64 `vrcompositor`, ELF Build ID
`9043766964b1831d8df849a867c1df0418413cd4`:

1. Initially logged `Error connecting to camera block queue`.
2. After queue creation, logged `Created static resources for tracked camera complete`.
3. After correcting the firmware version, logged `Finished creating camera roomview. (Success)`.
4. An independent queue client read magenta pixels and the typed metadata through SteamVR.
5. Correcting the sequence from int32 to uint64 let frame processing proceed and immediately
   hit `ASSERT: "NOIMPL" ... facetrenderer.cpp:3572`, then `Aborting due to fatal assertion failure`.

The assertion is at ELF virtual address `0x3e9770`, referenced by renderer vtable slot `0x1d0`
(address point `0x4de638`). Camera frame processing calls that slot at `0x2a9df6`, after issuing
its conversion work. The adjacent event creation/query calls use `0x1c8` / `0x1d8`: this
identifies GPU event/fence handling as the likely missing operation, rather than camera
configuration or the encoder. This is scoped to this binary/path, not a claim about all
SteamVR passthrough. A supported camera path or a native workaround is required before the
fake-camera idea can work end to end here; changing Room View settings does not implement
that renderer operation. No SteamVR binary was patched.

Validation: native build and ABI tests, a queue mock covering typed sequence metadata,
publication/release, failed acquire and unavailable-interface fallback; lab backup/restore
tests; viewer TypeScript/build. A headless Chromium + IWER test read actual WebGL pixels:
magenta `[255,0,255,255]` in VR became `[0,0,0,0]` in AR, while `[34,68,102,255]` stayed opaque
in both modes. This is not an on-Quest passthrough validation.

Research references (read-only checkouts under `_scratch/`):

- [Rectus/openvr_camera_sim](https://github.com/Rectus/openvr_camera_sim), revision
  `4415906bfa4a97a3ae97acaa6b6025560dd140f8`: camera queue contract, firmware floor,
  coefficient tagging, and rejected public-frame behavior. Its example uses Windows D3D11;
  it does not supply the missing Linux renderer implementation.
- [Rectus/openxr-steamvr-passthrough](https://github.com/Rectus/openxr-steamvr-passthrough),
  revision `603c4c8e8d707ba2130c6a472ce5e539e3841a72`: useful application-layer composition,
  alpha/mask handling and camera calibration reference; a different boundary from the
  legacy SteamVR Room View path used by this experiment.

Local harnesses: `_scratch/passthrough-queue-probe.ts`,
`_scratch/media-browser-test/passthrough-shader.mjs`, and `_scratch/re/compositor.asm`.
`_scratch/latest-tailnet-xr.txt` identifies the currently running experimental stream; create its
`stop` file to stop and restore the lab. Experimental sessions have no automatic expiry.


### Frame DMA-BUF path: desktop registration proof

The reference Frame producer is `drivers/cv/bin/linuxarm64/XRService`, not the legacy
`IVRCameraComponent_003` implementation. The private client interface is
`IVRCameraPassthroughInternal_001`; it exists in both Frame and desktop `vrclient.so`.
The two Rectus references use the legacy camera boundary, not this Frame producer API.

Recovered ABI evidence lives under `_scratch/re/`: `passthrough-vtables.json`,
`frame-passthrough-client.json`, `frame-passthrough-metadata.txt`, and
`frame-xrservice-camera-correct.txt`. Decompiler output is inference; runtime observations
below are separate. The XRService executable has an ELF image base of `0x200000`, so
module offsets passed to the Ghidra exporter must subtract that base from ELF addresses.

The real producer initializes camera type **1** for colour passthrough (type 0 is the other
camera set). Its configuration is 56 bytes: count, width, height, nine colour-matrix floats,
then spline width and height. Its buffer set is two eyes × sixteen packed, 104-byte OpenVR
`DmabufAttributes_t` entries. Metadata is 248 bytes per eye/frame. `SetPassthroughActive`
returns void, while `IsPassthroughActive` returns a status and writes a boolean.

The native scratch probe `_scratch/re/frame-key-probe.cpp`:

- Initializes an OpenVR overlay client and explicitly obtains `IVRCompositor_029` before
  importing DMA-BUFs. Without that compositor connection, import fails.
- Creates a Vulkan device and six GBM 640×480 ARGB8888 magenta images; supplies three
  buffers per eye, an identity colour matrix and 2×2 spline allocation.
- Successfully calls `SetGraphicsDevice` and `InitializeCamera(1, ...)`, both returning 0.
- Advertises camera availability, requests activation, and reads reader/slot state.
  Activation reads true immediately, then false; `CameraHasReader(1)` stays false and
  all three slot statuses remain 0. No picture has been submitted or displayed.
- Repeated with `Prop_HasCamera_Bool=true` in the isolated lab and an explicit Room View
  request: still no reader. A stream capture decoded/presented frames with no errors.

The desktop compositor only has three direct references to its private-interface getter:
activation and two floor-geometry calls. Its activation condition still depends on the
legacy tracked-camera object's readiness. The Frame compositor contains the
`VR_CameraPassthroughState`/mutex names and `PassthroughQualityManager` initialization;
these are absent from the desktop compositor. Together with the runtime reader result,
this suggests the Frame image consumer is missing from this desktop build. This is not
proof that every desktop SteamVR version lacks it, nor a validated Frame headset result.
Do not interpret successful buffer registration as successful passthrough.

Pinned SHA-256:

- Desktop compositor: `ebdffa9a8309d9596201cb385ceded35b71a1f16fb8f123fc0196c245cb8186c`.
- Desktop client: `83d08c3800875e0384983fed826ef50fc8d46c3cbbdc379f61acbe9f92c58cff`.
- Frame compositor: `9b1bd5fe4463592cbc71b2517b9ceb0a0fcd66cd6885a19dca4be0784bf6c265`.
- Symbolized Frame Android client: `857d2179871f23446932e6b08c8eec02b3825d25c52a28d71fb3b725544b305e`.

Build the probe with `c++ -std=c++20 -O2 -I submodules/petplay_ovrdriver/vendor/openvr
-I /usr/include/libdrm _scratch/re/frame-key-probe.cpp -o _scratch/re/frame-key-probe
-lvulkan -lgbm -ldl -pthread` (one shell command). Run with `PETPLAY_OPENVR_LIBRARY`
pointing to SteamVR's `libopenvr_api.so` and argument `--activate`. It refuses a non-synthetic
lab. It remains running until SIGTERM/SIGINT, then restores camera availability, clears
activation and releases its shared resources. The optional `--camera-presence` probe assumes
HasCamera was initially absent, as it is in this Frame synthetic profile, and erases that
property on exit. Do not use it against physical hardware.


### Simpler alternative: render the key in PetPlay

Park the SteamVR camera integration for now. PetPlay can render the key colour itself,
then use the existing WebXR AR presenter to remove it over the headset's native
passthrough. This avoids needing a SteamVR camera reader. The user identified the existing
VRChat depth shader system as a way to control key regions dynamically in that application.
This alternative is recorded for the next implementation; it has not been implemented or
validated by this camera experiment. Key-colour collisions and compression edges still apply.
