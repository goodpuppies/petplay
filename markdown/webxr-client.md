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
- **Controllers latch at a steady lag.** Head poses are tagged per frame and warped, so arrival
  jitter never showed on the head; the hands simply took the newest pose, and 13% of display
  frames got no new pose or two. Each uplink frame now carries the browser's XR frame time and
  the hands' velocities. The driver learns the Quest→PC clock offset as a 2 s sliding minimum
  of (arrival − client time) and, at every latch, carries the newest hand pose along its
  velocity to the client time matching that latch (at most 50 ms). Measured on the latched
  right hand while moving: frame-to-frame step change median 0.01 mm.
- **Open: the sender delivers in a sawtooth.** About twice a second, pictures arrive
  progressively later (≈83% of real time for ~0.4 s, up to ~37 ms behind), then catch up in a
  burst; every moving thing in the picture stutters with it, and the head's translation swims.
  It reproduces over loopback from the worker's own server, and Chromium's NetLog shows the
  QUIC data itself arriving that way, while the worker hands frames to moq-net steadily
  (`PETPLAY_FRAME_TRACE`). Not the cause: Wi-Fi, bitrate (50 and 80 Mbps), congestion control
  (`MOQ_QUIC_CONGESTION_CONTROL=loss|delay`), noq pacing (patched off), flow control (≥3 MB
  credit), the pose track, or the Quest's decoder/main thread.
- Viewer pacing: `?xrPacing=steady` shows pictures strictly in order and catches up only after
  being behind for `xrCatchUpFrames`; against the sawtooth it only adds latency, so `queue`
  (with `xrQueue=0`) stays the default.
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
