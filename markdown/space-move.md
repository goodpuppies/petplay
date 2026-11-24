# Space move (playspace drag) — plan

Status: working on Touch in the headset (2026-11-12) and on Index (2026-11-24). Code:
`classes/playspaceFrame.ts`, `classes/playspaceMover.ts` (tests in `classes/playspaceFrame.test.ts`,
`classes/actionBindings.test.ts`). Reference implementation: WayVR's OpenVR mover,
`~/git/wayvr/wayvr/src/backend/openvr/playspace.rs`.

## Decisions (from the user)

- Binding: **left thumbstick click/hold** (unbound in PetPlay today); on Index (`knuckles`), the
  chord **left grip + left trackpad touch**. Don't run WayVR's space drag
  alongside it: both would rewrite the same standing zero pose.
- Overlays **travel with you**: only the game world moves; PetPlay's displays and menus stay put
  relative to your body.
- Scope v1: **drag on all axes + reset** (wrist-menu button). Rotate comes later.

## Approach: give PetPlay its own frame

PetPlay frame = raw tracking space anchored at attach: `P_pp = Z0⁻¹ · P_raw`, where `Z0` is the
standing zero pose (`GetWorkingStandingZeroPoseToRawTrackingPose`, after `RevertWorkingCopy`)
captured once when webxr attaches. Before any drag this equals standing space exactly. Since PetPlay
no longer reads or writes in Standing, changing the live zero pose moves the game world while
PetPlay content stays physically with the user. Nothing needs compensating each frame, and the
compositor sees no one-frame lag.

Changes:

1. `classes/openVrRuntime.ts`: acquire `IVRChaperoneSetup_Version` (optional) into
   `OpenVrRuntimePointers`; pass it through `STARTWEBXR` (`petplay/main.ts:737`, `webxr.ts:202`).
2. `classes/openVrOverlayFramePacing.ts:559,619`: read `TrackingUniverseRawAndUncalibrated` and
   premultiply an optional `rawToPetplay` matrix (`Z0⁻¹`) in `readHmdPoseAtIndex` / device poses.
   The display host's release pacer (`displayOverlayHost.ts:freezeCarried`) reads Raw without an
   anchor and writes Raw.
3. `classes/openVrProjectionOverlays.ts:161`: submit `Z0 · eyePose` with the Raw universe.
4. `classes/openvrTransform.ts`: `setOverlayTransform(..., universe = Standing)`. Absolute
   `SYNCDISPLAYPOSE`/`SYNCVIRTUALDISPLAY` poses (`displayInstance/logic.tsx:290`) are premultiplied
   by `Z0` in webxr and flagged `universe: "raw"`. Device-relative (carried) poses need no change.
5. `webxrhost.ts:2614` fallback HMD read: same Raw + anchor.
6. VRChat-aligned input stays in Standing on purpose (it follows the world): `ORIGINUPDATE`
   (`webxr.ts:745`) and VRC camera calibration need `Z0⁻¹ · Z_current` applied once a drag has
   happened. Calibration already restarts when "the playspace moved"
   (`vrcCameraCalibration.ts:496`), so v1 can accept that.
   Legacy standing users (`laser.ts`, `genericoverlay.ts`, `hmd.ts`, `controllers.ts`) are dormant.

## Mover (new `classes/playspaceMover.ts`, ticked from webxrhost after `updateActionState`)

- Actions: add `/actions/main/in/SpaceDrag` (boolean) to `resources/actions.json`; bind
  `/user/hand/left/input/joystick` `click` in all three `bindings_*.json`; read it in
  `DirectOpenVrInputSource`. Update `classes/actionBindings.test.ts`.
- Drag start: `Zs = live zero pose`, `bounds0 = GetLiveCollisionBoundsInfo`, `h0 = left hand raw
  position` (`Z0 · P_pp`).
- Each frame: `Z = Zs` with `translation += (h_raw − h0)`; skip deltas over ~30 m like WayVR.
  Set the working zero pose, and set bounds to `Z⁻¹ · Zs · c` per corner (x/z only) so the guardian
  stays on the real walls. Then `CommitWorkingCopy(Live)`. Using raw hand positions avoids WayVR's
  dependence on commit latency.
- Release: stop. Reset: zero pose ← `Z0`, bounds ← `Z0⁻¹ · Z_current · c`, commit. Reset returns to
  where PetPlay attached, not to a saved centre.
- Wrist-menu "Reset playspace" button → reset. Haptic tick on start/end.

## As built (differences from the plan above)

- The reset is a **RESET SPACE** pill in the wrist Settings header; the main panel's tile row is full.
- The VRChat origin (`ORIGINUPDATE`) is kept in Standing and re-applied through
  `playspaceFrame.standingToPetplay` on every drag/reset, since it is only sent when it changes.
- Off with the opt-in decoupled renderer (`--webxr-decoupled-renderer`): its process and the
  native presenter (`native/overlayPresenter/presenter.cpp`) still read and write Standing.
- Not tracked: zero-pose changes made by other apps (WayVR, OVR Advanced Settings, room setup).
  PetPlay content still travels with you through them, but the VRChat origin conversion does not
  learn of them.
- Index got its first PetPlay default binding (`resources/bindings_knuckles.json`); SteamVR was
  remapping another controller's. Left grab is masked while space drag is held, since a chord
  still fires its grip. Not yet tried on Index hardware.
- Run-directory binding copies are now refreshed when they differ (`classes/utils.ts`): a reboot
  keeps the process's `tmp/run-<pid>`, and the stale copies left `SpaceDrag` unbound.
- Live-verified on Touch (Steam Link), 2026-11-12: drag works and RESET SPACE appears.
- Index, 2026-11-24: the chord was fine, but SteamVR autostarted PetPlay before the chaperone
  had a standing zero pose, so no mover was created and nothing retried. The host now retries
  `PlayspaceMover.tryCreate` every 2 s until it anchors (seamless: until a drag, the frame equals
  Standing).
- Needs a full server restart to take effect: `main`, the `openvr` actor and `displayOverlayHost`
  changed, not only the webxr graph.

## Verify

- Unit: matrix helpers (anchor/inverse, bounds transform) in a `.test.ts`.
- Live: drag in VRChat; displays and wrist menu stay with you, world moves, guardian stays on the
  walls, reset restores. Check `deno task check`.
