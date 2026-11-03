# Release performance campaign: initial survey

2026-10-18. Starting point: v0.0.12 / e4f3e65. Scope: stability, speed and resource use of the
actual release executable, under a reproducible heavy VRChat workload at the real Bigscreen
Beyond configuration. This is a survey and proposed experiment design, not a measured baseline.

## What the agent can already drive

| Existing facility | Useful coverage | Limit to address |
| --- | --- | --- |
| `utils/overlay-perf.ts`, `overlay-perf-harness.ts` | Observe a live session, scripted hover/drag/scroll/trigger/sweep, frame CPU and V8 profile | Launch path uses source and no VR; aggregate means/max are insufficient for tails; harness import must work from a compiled artifact |
| Agent REPL, `classes/cpuProfile.ts`, `denoCpuProfile.ts` | Worker inspection and bounded per-isolate CPU profiles | Profile each busy isolate/process, not just webxr; validate compiled module availability |
| `utils/vrlab/*`, `vrlab-camera-check.ts` | Synthetic SteamVR/controllers, VRChat launch/OSC, camera interaction, eye images, OBS control | Current stack launcher uses source; synthetic headset is a functional lab, not proof of real headset performance |
| `utils/compiled-smoke.ts` | Launch compiled app outside checkout, isolated config, verify bundled renderer/helper | No VR, no sustained capture workload, no performance assertions |
| `tests/openvr_compositor_timing_probe/main.ts` | Scene-app/compositor timings, percentiles, dropped/reprojected counters | Hard-coded DLL path needs platform library resolution; validate against current runtime before relying on results |
| WebXR health and timing rings, desktop view health | Existing render/pacing and packet/decode telemetry | Build one timestamped report; identify absent stages rather than treating unmeasured time as zero |
| Run logs, native crash tracing, repair counters | Lifecycle and crash evidence | Collect entire process tree and last evidence on timeout/native failure |

The agent can launch, wait for readiness, apply isolated layouts/settings, run interactions,
collect data, stop owned children, and compare baseline/candidate. Physical headset wearing,
tracking and a reproducible real VRChat scene still need a real session. Do not substitute
synthetic results for that final validation. Do not send chatbox messages or interact with other
users as part of tests.

At survey time the REPL on 3987 was unreachable and no real SteamVR/VRChat/PetPlay process was
found. No live baseline was collected. Machine: Ryzen 7 5800X3D, AMD Navi 31 family GPU. `perf`
is installed; `perf_event_paranoid=2`, so usable event/call-stack coverage needs a capability
probe. DRM exposes GPU busy and VRAM-used counters. Exact GPU model, clocks, temperature,
per-process attribution and usable native/GPU tracing remain to be verified.

## Define the heavy case before measuring

Record actual headset model, active refresh, panel mode, SteamVR recommended per-eye target,
VRChat per-app target/scaling, PetPlay target sizes, antialiasing and reprojection settings.
“Native BSB” must resolve to verified dimensions and an active mode; panel pixels alone do not
specify the distortion-corrected render target. Never silently lower resolution to claim a win.
Saved SteamVR preferences are not evidence of the active runtime mode.

Use a fixed private VRChat world, avatar, camera/viewpoint and quality configuration, with a
repeatable route and controller sequence. Freeze adaptive resolution for comparison if used,
and record that choice. Use a separate representative busy-world run for ecological validation;
changing players, avatars, mirrors or view direction otherwise confounds before/after results.
Pin capture display dimensions/rate, layout, number of displays and animated source content.

Measure distinct phases rather than one “everything on” average:

1. VRChat alone at the chosen BSB configuration.
2. PetPlay attached but hidden; camera never opened and camera services inactive.
3. Idle visible overlay with the representative heavy capture layout.
4. Continuous capture updates plus scripted menu, typing, scrolling, dragging and resizing.
5. Same workload with calibration active, then recording layer active; OBS separately off/on.
6. Camera stopped after use, and an incoming OSC flood while unused, to catch residual work.
7. Repeated start/stop and reconnect transitions, followed by a multi-hour real VR/capture soak.

An overloaded VRChat run is informative, but FPS may already be capped or reprojecting. Compare
CPU/GPU frame time, deadline misses and available headroom too. Include a near-budget case where
PetPlay can cause the transition into missed frames. Define a bounded, reproducible worst case;
an arbitrarily overloaded scene cannot provide a useful performance target.

## Measurement and evidence contract

Build/download an immutable release artifact for each revision. Record its SHA-256, embedded
commit, production conditions, toolchain, launch args and selected environment/configuration.
Run outside the checkout with isolated settings; verify no developer override substitutes a
native library/helper. A source process and a compiled production process are separate results.
Check whether profiling imports and inspector functions survive compilation before the campaign.

Each run writes under `_scratch/perf/<run>/`: manifest, raw timestamped samples, summaries, logs,
profiles and failure artifacts. Redact tokens, account identifiers and private instance URLs.
Keep only small, reviewed findings/baselines in tracked docs. Never commit recordings or raw
profiles automatically.

Collect:

- Scene-app/compositor frame-time distributions and cumulative presents/drops/reprojection.
  Track frame indices and telemetry gaps. These are system/scene timings, not isolated PetPlay
  GPU cost; attribute changes through controlled runs and stage evidence.
- PetPlay stage p50/p95/p99/max and missed-deadline counts: input/update, React, scene extraction,
  serialization, transport/queue delay, capture import, rendering, submission and waits. Keep
  active CPU/GPU work distinct from blocking/pacing. Align clocks across child processes.
- Process-tree and per-thread CPU, context switches/wakeups, RSS/PSS, isolate heap/GC, VRAM,
  descriptors, threads, worker count, actor message/byte rates and asset/cache sizes.
- Capture-to-display freshness and recording output freshness, not only draw FPS; repeated
  stale frames and frozen OBS sources can report healthy rendering rates.
- Startup-to-first-useful-frame, stop/restart latency, repair/reconnect counters and native exits.
  For soaks, compare warmed-up resource floors and growth slopes; a peak RSS is not a leak.

Use low-overhead counters first, short targeted CPU/native/GPU traces second. Measure instrumented
versus minimally instrumented runs to quantify observer cost. Bounded rings/counters should have
no production timer/logging cost when disabled. Missing tracing support is an explicit gap.

Warm up JIT, shaders and capture before steady-state comparisons; report cold startup separately.
Alternate baseline/candidate order across repeated runs, and report sample count, variance and
tail changes. Re-run an apparent win; reject changes smaller than observed noise. For each fix:
evidence → specific hypothesis → smallest change → same workload → regression checks. No claim
of improvement from cleaner code, theoretical allocation savings or synthetic FPS alone.

## Camera idle audit: concrete code paths to measure

The current implementation is not dormant whenever calibration and recording are off:

- `petplay/main.ts` creates the camera actor in the regular control-plane path and starts the
  OSC driver when desktop control is enabled. The no-VR path also starts it in that mode.
- `petplay/VRCOriginCamera.ts` handles incoming poses, allocates samples and runs the older
  look-at-target estimate before its 8 ms forwarding throttle. It forwards camera/debug updates
  regardless of calibration/recording demand. mDNS rebroadcast wakes every five seconds.
- `petplay/webxr.ts:trackVrcCameraPose` obtains both controllers and allocates pose tuples even
  when no calibrator is active. It converts/stores world poses and publishes status up to 4 Hz
  on arrivals while unused.
- `VrcCameraCalibrationBall` stays mounted with geometry/material and a per-frame callback.
  Its predictor calls `status()` (allocating a status object) to test whether the camera is live,
  even when it returns no visible ball.
- `createVrcCameraWorkerSolver` correctly starts the solver lazily. After first use the worker
  remains resident until disposal during scene teardown; ending calibration does not dispose it.
- The recording window is demand-started. Verify that stopping also removes its scene consumer,
  asset retention, process/GPU resources and delivery work; do not infer this from a hidden UI.

These establish that work exists, not its magnitude or which change will matter most. Measure
camera closed, camera streaming while unused, and off-after-use separately. Add counters for
packet handling, fits, forwarded messages, status publication, solves and recording extraction.

Proposed inactive contract: no camera solves, target fitting, controller sampling, scene
extraction, frame callbacks or status-publication loop; no recording process/consumer; no
resident solver worker after outstanding work is safely cancelled. Enabling the CAMERA page,
calibration or recording supplies explicit demand. If automatic discovery must remain available,
document and measure its minimal receive/discovery cost instead of calling it zero. Prefer
starting discovery on page open if complete dormancy is required. Verify disable/re-enable,
stale async completion, retained calibration and OSC rediscovery as functional regressions.

## Implementation order for the campaign

Driver follow-up: use PetPlay's ovrdriver as the primary automation backend. A full synthetic
HMD run can cover release CPU/resource profiling, repeated interactions, camera inactivity,
lifecycle stress and soaks without anyone wearing a headset. Before treating it as a BSB-sized
load test, parameterize the currently fixed display/render geometry and 75 Hz clocks, verify
actual VRChat/compositor allocations, and account for direct-mode's 4096-pixel dimension guard.
Image diagnostics also contain 960×960 assumptions. Keep GPU readback disabled during timing
baselines and enable it only for targeted freshness/correctness experiments.

For hardware acceptance, the existing controller-only `--real-hmd` mode retains the physical
headset's optics, refresh and Linux async reprojection while driving scripted synthetic hands.
See `submodules/petplay_ovrdriver/CONTROLLER-LAB.md`. This preserves agent-driven interactions
on the real BSB. Full synthetic runs cannot establish physical display timing, tracking behavior,
or visual comfort; use the hybrid mode for a smaller final acceptance matrix.

1. Extend the existing launcher to accept an exact compiled executable; add manifest, verified
   configuration, timeout/cleanup and raw telemetry collection. Make the compositor sampler
   platform-correct and check profiling inside the compiled app.
2. Establish the actual BSB/VRChat baseline and a short repeatable synthetic counterpart.
   Calibrate instrumentation overhead and variability. Set numeric budgets from these results
   and the active refresh frame budget; do not adopt the older document's “GPU path is fine”
   assumption or an arbitrary memory-growth threshold as a finding.
3. Measure and remove unused camera work, checking the inactive contract and user setup flow.
4. Optimize the largest evidenced bottleneck, one hypothesis at a time. Maintain an experiment
   ledger with artifact hashes, traces, effect sizes and any quality/latency tradeoff.
5. Add bounded resource/lifecycle stress tests and long real-headset soaks. Validate crashes,
   disconnects, capture re-selection and shutdown as separate scenarios, not during a frame-time
   baseline. Archive final evidence and run the release artifact acceptance suite.

Survey changed documentation only. No performance implementation, runtime settings, commits or
uploads were made.
