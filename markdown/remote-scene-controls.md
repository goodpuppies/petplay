# Remote scene controls through the SteamVR stream

The browser displays the existing encoded SteamVR stream. PetPlay renders its controls inside
SteamVR. The browser only sends raw pointer information; all scene geometry, raycasting,
selection, capture, constraints, and pmndrs gizmos run in the Deno PetPlay WebXR worker.
There is no second desktop camera or diagnostic image feed.

## Current slice

- The media viewer can forward pointer and wheel input from its existing video canvas.
- PetPlay accepts one input session through an opt-in loopback WebSocket listener.
- Input identifies the `steamvr-stereo` viewport and gives coordinates normalized over the
  complete side-by-side stream. Deno maps each half to its actual rendered eye camera.
- A drag remains attached to its starting eye when it crosses the seam.
- Two selectable controller proxies expose pmndrs `PivotHandles` translation and rotation.
  Scaling is disabled. The right controller is selected initially.
- The driver socket is explicit. Gizmo transforms become `SETCONTROLLERPOSE` messages through
  the existing Stageforge native proxy. Controller poses stay held at their final position;
  cancelling input ends the drag, rather than returning the device to its analytic trajectory.
- Driver requests are serialized and intermediate motion coalesces to the latest pending pose
  per hand. Blur, pointer-capture loss, disconnect, and scene teardown cancel active pointers.
- Normal local desktop mouse input keeps using the same extracted synthetic pointer surface.

The gizmos are mounted at the live scene root in raw tracking coordinates, matching the current
OpenVR pose pipeline. `controllerTrackingPose` supports an explicit rigid tracking-to-world
matrix for other placements. It rejects non-rigid controller transforms.

## Enable locally

Set these on PetPlay before launching the XR scene:

```sh
export PETPLAY_REMOTE_INPUT_PORT=3991
export PETPLAY_REMOTE_INPUT_ORIGIN=http://127.0.0.1:4471
export PETPLAY_REMOTE_DRIVER_SOCKET=/run/user/$(id -u)/petplay_ovrdriver/control.sock
```

Use the active synthetic driver's actual socket path; a scoped lab has its own private
`socketDirectory`. The controller device(s) must already be active. This code attaches to the
existing driver and does not start or own SteamVR. Omit `PETPLAY_REMOTE_DRIVER_SOCKET` to
forward input to existing scene UI without mounting controller pose controls.

Run the existing native media source and gateway as documented in
`submodules/petplay_mediatransport/README.md`. For a gateway whose viewer is on port 4471, open:

```
http://127.0.0.1:4471/?input=ws%3A%2F%2F127.0.0.1%3A3991%2Finput
```

The input origin must exactly match the viewer page's origin, including scheme and port.
The input server remains loopback-only. For a remote browser, expose it through an explicitly
configured HTTPS/WebSocket proxy on the tailnet, set `PETPLAY_REMOTE_INPUT_ORIGIN` to the actual
HTTPS viewer origin, and give the viewer a `wss:` input URL. No new proxy configuration is
installed automatically by this implementation. Media still uses the existing Iroh/MoQ and
WebTransport path; the prototype input channel is a separate ordered WebSocket.

## Implementation

- `classes/desktopPointerSurface.ts`: Deno synthetic DOM event surface extracted from the
  existing native desktop viewer.
- `classes/desktopRemotePointer.ts`: validated raw events, session pointer IDs, cancellation.
- `classes/steamVrRemotePointer.ts`: stereo viewport routing and pmndrs event forwarding using
  `WebXRHost.getSteamVrInputContext()` cameras and live scene.
- `classes/desktopRemoteServer.ts`: one input session, origin validation, bounded messages.
- `classes/environment/steamVrRemoteControls.tsx`: input lifecycle in the live XR scene.
- `classes/environment/controllerPoseGizmos.tsx`: selectable pmndrs controller manipulators.
- `classes/openVrControllerControl.ts`: pose conversion, coalescing, native driver adapter.
- `submodules/petplay_mediatransport/web/src/input.ts`: browser input sender; no pmndrs/Three.js.

## Validation and limits

`deno task check` passes. Focused pointer and cancellation tests run with:

```sh
deno test -A --no-check classes/desktopRemotePointer.test.ts \
  classes/environment/grabboxHandleCancellation.test.ts
```

They exercise real pmndrs raycasting/handles, distinct rendered eye origins, stereo seam
capture, cancellation and reuse, coordinate conversion, invalid/replayed packets, and pose
coalescing. The viewer also passes its independent TypeScript check and bundle build.

A headless Chromium test used the actual browser sender, WebSocket server, stereo input bridge,
pmndrs axis gizmo, Stageforge proxy, and real native driver library hosted by the offline ABI
fixture. The browser drag produced x=0.2825401400670883 in both the scene and the driver's held
controller pose; blur released the grab. No page errors occurred. Scratch artifacts are in
`_scratch/steamvr-input-e2e.log` and `_scratch/stream-browser-native.log`.

The subsequent tailnet session also verified the live SteamVR path: the actual stream viewer
decoded over 200 frames and connected its input WebSocket over HTTPS/Tailscale. A browser
drag of the streamed right-hand gizmo changed its live PetPlay scene x position from 0.2 to
0.29771312404815603 m. The captured video canvas visibly contained both controller proxies
and the pmndrs gizmo inside SteamVR. Artifacts: `_scratch/live-controls-browser.log`,
`_scratch/live-controls-canvas.png`. The bounded session uses HTTPS8449 for the existing viewer
and HTTPS8450 for the input proxy, preserving other tailnet Serve routes.

The earlier isolated desktop-child test
used a separate diagnostic preview; that implementation was removed following clarification.
It revealed an existing delayed renderer teardown failure in that child, which was not changed
as part of the corrected live-scene implementation.

Input currently uses the latest rendered eye matrices, rather than retaining camera poses for
the exact frame displayed remotely. Head motion plus stream latency can therefore affect
picking accuracy. Frame-associated camera history, keyboard/gamepad controls, ownership between
multiple remote operators, and transport integration are follow-up work. The current mapping
assumes the unwarped equal-width side-by-side stream used by the headless pipeline; cropped,
letterboxed, or lens-distorted streams need explicit viewport/projection metadata.

User testing confirmed input was connected and operational, but stereo made targets difficult
to hit. The stream viewer now defaults to a single right-eye crop with a left/right/stereo
selector. Input remaps that displayed eye into the source stereo coordinates, leaving Deno eye
selection unchanged. Headless Chromium verified mono playback, all view switches, and aspect
ratio preservation at desktop and narrow viewport sizes. The live tailnet session serves the
updated bundle through a temporary `/viewer.js` HTTP proxy, removed with the owned session's
HTTPS8449 route. Native encoding is still stereo; no second camera or render path was added.

The user requested that experiments have no automatic time limits. `AGENTS.md` now states
this explicitly. The lab defaults to running until stopped (`--seconds 0`); an explicit positive
`--seconds` still supports intentionally timed checks. The tailnet supervisor and keepalive
have no experiment deadline. The current session's metadata records `expires: null`. To stop
this owned session and restore the scoped SteamVR settings, create `stop` inside the directory
named by `_scratch/latest-tailnet-controls.txt`; the supervisor performs cleanup and removes
only its own Serve routes. Startup readiness and shutdown operation timeouts remain bounded.


### Picking correction: overlay render lens versus compositor display lens

User testing exposed a consistent visible/clickable offset. PetPlay's overlay render cameras
use IWER's 112-degree FOV (projection scale 0.71511185), while the headless SteamVR display
uses a 90-degree FOV (projection scale 1). Reprojecting the overlay into the final compositor
image changes the pixels that contain its objects. The earlier input bridge incorrectly used
the overlay's render projection to unproject those final image coordinates.

`WebXRHost.getSteamVrInputContext()` now combines the current eye poses with OpenVR's
`GetProjectionMatrix` for the final display. It leaves the overlay render cameras unchanged.
`classes/compositorInputCamera.test.ts` tests a visible point rendered with the 90-degree lens
against an overlay whose source lens is 112 degrees; the old ray misses by several centimetres.

The running XR worker was reloaded with the fix. Live single-eye browser verification checked
that the projected interaction point actually overlaps red handle pixels in the decoded video
(at source pixel 610,660), then dragged from that point. The right controller scene position
changed from x=0.2 to x=0.2731265140 m. Artifacts: `_scratch/aligned-controls-browser.log` and
`_scratch/aligned-controls-canvas.png`. Parent type-check and seven camera/pointer tests passed.
The session remains running without automatic expiry. Reloading the worker closes old input
connections, so browsers need a page refresh to reconnect.
