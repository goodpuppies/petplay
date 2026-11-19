# What screen-relay offers PetPlay's remote streaming

The current goals are world-class remote desktop between PetPlay instances, and streaming from the
driver to a website. `research/screen-relay` (Vercel Labs, Apache-2.0, v0.1.2) is a desktop
streamer built for AI agents to drive VMs. This note records what is worth borrowing from it. The
current media path is described in [remote-desktop-stream.md](remote-desktop-stream.md) and
`submodules/petplay_mediatransport/README.md`.

## Summary

Don't adopt its engine or transport. screen-relay encodes H.264 in software with x264, sends it
over a single WebSocket on TCP, and allows one viewer. PetPlay already has GPU encoding (VA-API on
Linux, NVENC on Windows), MoQ over iroh with peer-to-peer share codes, a WebTransport gateway for
browsers, and native GPU receivers that hand frames to OpenVR.

What is worth taking is its control loop and its input design. In order of value:

1. Adaptive bitrate and flow control driven by the viewer.
2. Encode only when the screen changes, then sharpen the still picture.
3. Keyframes on demand instead of on a fixed interval.
4. Its input protocol, as a template for remote input.
5. The cursor on its own channel.
6. Smaller items: an adaptive jitter hold, and one-time viewer tickets.

All of these fit inside `petplay_mediatransport` and the existing receivers without changing the
architecture.

## 1. Adaptive bitrate and flow control

**Gap.** `petplay_mediatransport/src/source.rs` encodes at a fixed bitrate (`--bitrate`, 12 Mbps by
default) and does not react to the link. Between instances over the internet, this decides
whether the stream stays watchable.

**How screen-relay does it** (`research/screen-relay/CONTRIBUTING.md`, "Flow control";
`src/engine/core/flow.hpp`):

- The viewer acknowledges every frame after drawing or dropping it. Each acknowledgement carries
  how long the frame waited inside the viewer. The engine subtracts that wait, so a slow browser
  is not mistaken for a slow network.
- **Base delay:** the shortest network delay over the last 10 s, plus the longest recent viewer
  wait, up to 100 ms.
- **Standing queue:** the smallest delay above the base over one round trip. A single late burst
  leaves it at zero; real congestion raises it.
- **Bitrate:** multiplied by 0.75 (and at most 90% of measured goodput) when the network part of
  the standing queue reaches half the pause threshold, at most once per 500 ms. Multiplied by
  1.10 after a busy 1 s sample with a clear queue, no sooner than 1 s after the last increase and
  2 s after the last decrease. Clamped between a configured minimum and maximum (1–40 Mbps by
  default).
- **Frames in flight:** limited to roughly one round trip of frames plus two. Before the first
  acknowledgement only one frame is allowed.
- **Capture pause:** capture stops while the standing queue reaches the base delay plus two frame
  intervals, so frames don't pile up in the network.
- On Linux over a direct connection it reads TCP statistics for the round trip instead of
  estimating it from acknowledgements.

**What PetPlay already has.** The pinned `moq-vaapi 0.2.1` encoder has `set_bitrate()`
(`encode.rs:433`), which restarts the driver's rate control on the next frame. NVENC through FFmpeg
on Windows would need a reconfigure path (or a native NVENC session). On QUIC, iroh's path
statistics (round trip, congestion window, lost packets) are the counterpart of screen-relay's TCP
statistics.

**Open questions.**

- Where acknowledgements travel. MoQ is publish/subscribe with no per-frame return channel. They
  could go as a small reverse track or a datagram from the receiver, the gateway, or the browser.
- Who adapts when there are several viewers. For one-to-one remote desktop, the single viewer
  drives the rate. For website broadcast, either use the slowest viewer or encode several bitrates.
- MoQ can drop whole groups instead of queuing them. Decide whether capture pause or group drop is
  the main defence against a standing queue.

## 2. Encode only on change, then refine

**Gap.** PetPlay encodes at a steady frame rate whether or not the desktop changed. A desktop is
mostly still text, so most of that bitrate is wasted, and text stays at whatever quality the
motion bitrate allowed.

**How screen-relay does it** (`src/engine/core/capture.cpp`, `CONTRIBUTING.md` "Quality
recovery"):

- An idle desktop sends no frames; capture waits for the desktop to report a change.
- It captures only the changed region, compares it block by block, and marks unchanged
  macroblocks so x264 skips them (`mb_info`).
- After the picture has been still for 150 ms, it re-encodes the whole picture as P frames with a
  larger VBV buffer, refining until one of these: the effective quality is within 1 of the
  target, a refinement frame is at most 1/8 the size of the first, 8 refinement frames were sent,
  or the screen changes again. Refinement starts only when nothing is in flight.

**For PetPlay.**

- VA-API has no equivalent of x264's `mb_info` skip hint, so per-block skipping does not carry
  over directly. Idle suppression and a refinement pass do.
- Change sources: PipeWire's `SPA_META_VideoDamage` on Linux (the vendored scap does not request
  it yet), Desktop Duplication dirty rectangles on Windows, and the Windows Graphics Capture dirty
  region mode on recent Windows 11.
- Refinement needs per-frame QP or bitrate control: a lower QP or a larger budget for still
  frames. Check what `moq-vaapi` exposes beyond `set_bitrate` (it has fixed `MIN_QP`/`MAX_QP`
  constants in `encode.rs`).
- For reading text in a headset, this is probably the most visible quality improvement.

## 3. Keyframes on demand

**Gap.** `source.rs` forces a keyframe every `--keyframe-seconds` (default 1) because each MoQ
group starts at a keyframe and late joiners wait for the next one. At 4K desktop sizes, a
keyframe every second costs bitrate and makes quality pulse on a regular beat.

**How screen-relay does it.** Infinite keyframe interval and no scene-cut detection. An IDR frame
is sent only at session start and on recovery.

**For PetPlay.** `encode_dmabuf(buffer, keyframe)` already takes the keyframe flag, so this is a
policy change in our code. For one-to-one remote desktop, send a keyframe when a subscriber
arrives or reports loss. Website broadcast to several viewers can keep the periodic keyframe, or
use a long interval plus on-demand keyframes. Long groups also need checking against moq-net's
32 MB group limit (`source.rs` already guards this).

## 4. Input protocol template

**Gap.** Remote input is listed as out of scope in
[remote-desktop-stream.md](remote-desktop-stream.md); remote feeds are view-only.

**How screen-relay does it** (`research/screen-relay/PROTOCOL.md`, `src/engine/core/input.hpp`):

- **Fixed 16-byte binary records:** type, code, value, X and Y, button mask, modifier mask.
  - Keys are physical HID usages; the remote desktop's layout decides the character.
  - A separate text event types one Unicode character without disturbing held keys, so layout
    differences don't matter for typed text.
  - Coordinates run from 0 to 65535 across the desktop, independent of resolution.
  - Wheel deltas are multiples of 120.
- **Safety:**
  - a "release all" event;
  - held keys and buttons are released on blur, disconnect, timeout and generation change;
  - Caps Lock is reset when a new input session starts.
- **Ownership:** only one controller sends input at a time, and viewers can attach view-only
  while another controller holds input.
- **Applied confirmation:** each request completes only after the backend has applied it (a fence:
  XSync on X11, a roundtrip on Wayland), which gives clients backpressure.
- **Backend interface:** `InputBackend` holds only platform primitives. Validation, coordinate
  mapping and tracking of held input live in the shared core.

**Backends as references.** XTest on X11, SendInput on Windows, CGEvent on macOS. Its Wayland
backend uses the wlroots virtual keyboard and pointer protocols, which **do not work on KDE**. On
KDE, use the RemoteDesktop portal or libei, or screen-streamer's existing `/dev/uinput` path.

**For PetPlay.** The records can travel on a MoQ track or iroh stream next to the video. The
existing pointer channel ([remote-scene-controls.md](remote-scene-controls.md),
`petplay_mediatransport/web/src/input.ts`) uses JSON over WebSocket; this record format would
replace that for desktop input.

## 5. Cursor on its own channel

screen-relay sends the cursor image and hotspot as a separate message (only when it changes), and
the viewer draws the cursor itself instead of relying on the video. In VR, PetPlay could draw the
remote cursor at the controller ray's hit point immediately, so pointing feels instant even when
the video lags. Its caveat applies here too: a cursor drawn locally does not follow pointer jumps
made by the remote desktop, so the remote position still has to be sent.

## 6. Smaller items

- **Adaptive jitter hold.** The screen-relay viewer holds frames for up to 100 ms when arrivals are
  uneven, near zero on a clean link, and reports the hold in its acknowledgements. The PetPlay
  browser viewer has a fixed 20 ms cushion (`?buffer=`). Native receivers present the newest frame.
- **One-time viewer tickets.** A holder of the session token can mint a ticket that opens one
  connection within 60 s, so a viewer page never sees the long-lived secret. PetPlay's share code is
  currently a bearer secret that also contains IP addresses; per-viewer tickets or identities are
  the same idea and are already noted as an M4 addition in
  [remote-desktop-stream.md](remote-desktop-stream.md).

## Not covered by screen-relay

Neither project has these, and world-class remote desktop will need them:

- **4:4:4 color.** Both convert to 4:2:0 (NV12). Small colored text and subpixel-rendered text lose
  sharpness. Options are H.264 High 4:4:4 or HEVC RExt where hardware supports them, or a separate
  text/chroma layer.
- **Audio.**
- **HDR.**
- **Sending to many viewers, and NAT traversal.** PetPlay already does this through MoQ and iroh;
  screen-relay has none of it.

## Suggested order

1. Adaptive bitrate driven by acknowledgements (and iroh path statistics).
2. Idle suppression, then the refinement pass.
3. Keyframes on demand for one-to-one sessions.
4. Remote input using the record format above.
5. Local cursor drawing in VR.

## Licensing

screen-relay is Apache-2.0, so code may be copied with its notice kept. Its engine links x264, which
is GPL-2.0-or-later. PetPlay does not use x264; borrow designs and the flow-control logic, not the
x264 encoder setup.
