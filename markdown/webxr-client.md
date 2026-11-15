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

## Known limits and next steps

- **No reprojection.** The picture is shown as if rendered at the current head pose, so all
  motion-to-photon latency is visible as the world swimming with head rotation. Next: stamp
  each encoded frame with the head pose it rendered (the compositor's capture runs in a
  different process from the driver), then counter-rotate the eye quads in `xr.ts` by the
  rotation since. The vertex shader already takes a full `clipFromEye` matrix for this.
- **Uplink is a separate WebSocket.** Moving poses onto the media path (gateway → iroh → source)
  would make a remote headset need only the viewer URL.
- The Quest menu button is not exposed to web pages. Pressing both sticks together is the left
  menu button (`system`) instead, held as long as the chord is; neither stick clicks meanwhile.
- The XR frame loop runs at the headset rate (72–120 Hz) against a 75 fps stream; frames are
  repeated or skipped according to timestamps, not interpolated.
