# Panorama and projection overlay modes can mispredict display time and add avoidable pose latency

Status: open

## What happens

In `panorama` (default) and `projection` overlay modes, UI panels and hand-anchored elements (wrist menu, lasers, grabbed windows) can exhibit visible translation bounce/lag during head movement and extra hand latency, even when the decoupled Raythree renderer (`petplay/overlayRenderOwner.ts`) is keeping up at display rate and late-sampling hardware poses (`resolveRenderAnchors` at `petplay/overlayRenderOwner.ts:1049`).

Two likely contributors in the current pacing/prediction path:

1. **Prediction horizon mismatch (`classes/openVrOverlayFramePacing.ts:594`, `petplay/overlayRenderOwner.ts:968-970`):**
   `predictedSecondsFromNow` is computed as `frameDuration * (1 + extraPredictionFrames) - phaseInFrame + vsyncToPhotons`, with `extraPredictionFrames` set to `0` (non-pipelined) or `1` (pipelined).
   - If a non-pipelined frame finishes after the compositor's mid-frame latch, it actually displays on the *following* vsync (`2 * frameDuration`), making the sampled pose off by a full display frame (~11–14 ms). Even a 1-frame error produces a first-order velocity error ($v \cdot \Delta t$) that looks like pronounced swim/bounce on head translation and rotation.
   - On streaming/wireless runtimes (Steam Link, Oculus Link / Quest Pro), `Prop_SecondsFromVsyncToPhotons_Float` and actual compositor latch timing can diverge from direct DisplayPort HMDs.
2. **Avoidable sample-to-photons latency:**
   Because the decoupled Raythree renderer already late-samples HMD and controller poses right before drawing (`petplay/overlayRenderOwner.ts:979-1055`), starting pose sampling + rendering earlier in the frame than necessary (or pipelining 1 frame ahead when Raythree render time is only a few ms) increases both the prediction horizon `T` (which increases $\frac{1}{2} a T^2$ translation error during head acceleration) and hand/laser latency.

## Expected

- The predicted pose timestamp in `panorama` and `projection` modes matches the actual photons-out time of the vsync on which the submitted frame is displayed (verified across direct HMD, Steam Link, and Oculus/Windows drivers).
- When Raythree frame time fits comfortably before the compositor latch, pose sampling and rendering start as late as safely possible before the latch (minimizing `T` for both head translation and late-sampled hands/lasers).

## Notes / evidence

- Noted 2026-11-27 while reviewing PR #11 (`feat/native-steamvr-overlays`).
- Relevant code:
  - `classes/openVrOverlayFramePacing.ts:579-605` (prediction formula and `GetDeviceToAbsoluteTrackingPose`)
  - `petplay/overlayRenderOwner.ts:957-1055` (`usePipelinedPanorama`, `usePipelinedProjection`, `extraPredictionFrames`, `waitVsyncLocked`, `resolveRenderAnchors`)
  - `docs/PROJECTION_OVERLAYS.md` (measured compositor latch window on Linux RADV, 75 Hz)
