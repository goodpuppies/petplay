# VRC camera layer for recording

PetPlay renders a second, transparent view of its scene from VRChat's user camera, so OBS can
stack it over VRChat's own camera output. VR keeps rendering as usual; the layer is a second
`desktopView` instance (`camera: "vrc"`) that draws the same scene IR from another pose.

## Pieces

- `cameraOrigin` (`petplay/VRCOriginCamera.ts`) receives `/usercamera/Pose` and `/usercamera/Zoom`
  over OSCQuery and forwards both to `webxr`. The connection is `classes/oscQuery/vrchatLink.ts`,
  modelled on OscGoesPurrr and VRCFaceTracking: it waits for VRChat's `_oscjson._tcp` record on
  mDNS, then binds its UDP listener and HTTP server on 127.0.0.1 with OS-picked ports and
  advertises both under a per-launch name (`PetPlay-AB12CD`). It answers mDNS queries, says
  goodbye on stop, health-checks VRChat's OSCQuery server, ignores a crashed VRChat's leftover
  record, and re-advertises under a fresh name when VRChat stops sending. Never 0.0.0.0 or a fixed
  port: on Windows a 0.0.0.0 socket can share a port with another program's 127.0.0.1 socket
  without an error, and that program then receives every datagram.
- `webxr` holds a `VrcCameraTracker` (`classes/vrcCameraCalibration.ts`): the latest world pose and
  the world→tracking calibration. Views registered with `camera: "vrc"` get the calibrated pose
  (`vrcCamera`) and a transparent background with every frame.
- `desktopView` in VRC mode opens a `FLAG_WINDOW_TRANSPARENT` window, builds its view/projection
  from that pose, draws no FPS counter, and stays empty until a calibration exists.

## Calibration

The OSC pose is in VRChat world space; the scene is in OpenVR tracking space. Grab-to-calibrate
fits `p_track = s·R(yaw)·p_world + t` plus the camera's grip offset in the holding hand, using
positions only (VRChat's smoothing and auto-level change the reported rotation, not where the
camera is). Samples are taken only while the hand is nearly still, because OSC lags the controller.
RANSAC plus worst-sample trimming drop samples from a camera that was let go mid-capture.

The fit is fixed in world→tracking space. The normal camera mode is expected to follow the
playspace; the menu does not invalidate calibration on movement. Alignment through joystick
moves, snap turns and teleports still needs a real-session check.

## Use

In VR, open Settings → CAMERA. Hold VRChat's camera, turn Calibrate ON, then slowly move and
turn it. Watch the live error and green predicted-position ball; switch OFF when aligned, then
let go. START opens the recording layer; choose the matching resolution while stopped. CLEAR
removes a fit. The ball is excluded from recording captures. See [the menu notes](vrc-camera-menu.md).

The desktop CLI retains its timed calibration flow:

```bash
deno task client camera --width=1920 --height=1080   # match VRChat's stream resolution
deno task client camera calibrate                    # hold the VRChat camera, turn it slowly (10 s)
deno task client camera status
deno task client camera --stop
```

`/usercamera/Mode` does not open a closed camera (it only stores the mode); open it from the
Action Menu (Tools → Camera), then OSC can switch it to Stream. `/usercamera/Pose` is read-only
and only sent while the camera moves.

In OBS (Linux): add a PipeWire window capture of VRChat for the camera feed, then a PipeWire window
capture of "PetPlay VRC Camera" above it. KDE keeps the window's alpha.

## Known gaps

- OBS Xcomposite can hold a stale image even while the recording window continues drawing.
  Confirm with the window diagnostics counter. Hiding the OBS layer source, reapplying its
  window-capture settings, then showing it again recovered the capture in the live session;
  no PetPlay restart or recalibration was needed.

- VRChat's `Zoom` (default 45, range 20–150) is taken as the vertical FOV; `--fov=<deg>` is the
  fallback until VRChat reports it. The end-to-end check below aligned at 45.
- Semi-transparent panels come out more transparent than in VR: raylib's `BLEND_ALPHA` blends
  the alpha channel the same way it blends colour, so translucent alpha ends up squared.
- Spout (Windows) output isn't implemented; on Windows the same transparent window can be captured.

## End-to-end check (2026-10-18)

Synthetic lab (`petplay-ovrdriver-lab.py run --direct-server --x11-compositor --touch-controllers`),
live PetPlay attached, VRChat in VR, OBS 32.2 under `QT_QPA_PLATFORM=xcb` with two Xcomposite
window sources (VRChat, then "PetPlay VRC Camera"). The synthetic right hand grabbed the VRChat
camera (grip via `SETCONTROLLERINPUT`) and swept it smoothly for 14 s: 55 samples, rms 0.1 cm,
scale 1.422 (avatar-scaled world), yaw −139.6°. Aiming the held camera at a requested tracking
pose landed within 2 mm. A marker drawn by PetPlay at its left-controller pose sat on the
avatar's left hand in the OBS composite from two camera angles. OBS's Xcomposite capture keeps
the layer's alpha. Scripts used: `_scratch/{driver,inputs,grab,calib-move,aim,obs}.ts` (local).

Not yet explained: the first camera-view instance of that session received the scene without
the window layer's content (1 instance) after the layer was shown; a restarted view drew it.

## Recording-window delivery

The recording window requests the same compact scene transport as the independent overlay
renderer. UI glyph geometry is cached across frames instead of being expanded into JSON every
frame. An `OverlaySceneInbox` retains scene assets before returning delivery credit, so the
sender can continue while the window renders or skips an older snapshot. Drawing is paced
with an asynchronous deadline; raylib's blocking `SetTargetFPS` wait is disabled. Window FPS
is counted from actual draws, and health reports packet/decode/render/swap timing separately.
