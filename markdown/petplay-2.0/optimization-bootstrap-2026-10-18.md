# Optimization campaign bootstrap, 2026-10-18

Status: concrete infrastructure progress and pilot evidence; no accepted app optimization yet.
The controlling requirements are [`../optimization_goal.md`](../optimization_goal.md), including
the user additions prioritizing worst-case frequency/severity and comparison against WayVR.
The physical BSB stayed out of the synthetic test runs.

## Build variants and checks

Added explicit `deno task build --mode=development|production --output=<path>` configuration.
The default remains production. Development selects development React/npm conditions and a
debug Rust capture helper; production selects production conditions and the release helper.
Both use explicit environment files instead of the private developer `.env`. Raylib and the
synthetic driver remain their separately recorded native configurations; this is not a claim
that every component of the debug configuration is unoptimized.

`utils/compiled-smoke.ts --expect-mode=development|production` now checks the compiled worker's
environment and React element development metadata after removing inherited mode overrides,
then checks bundled rendering and helper execution outside the checkout. Both variants passed.
This prevents calling an ordinary source `dev` process a development baseline merely by name.

Bootstrap executables are preserved locally at:

- `_scratch/perf/bootstrap/petplay-debug`
- `_scratch/perf/bootstrap/petplay-release`

Hashes are in `_scratch/perf/bootstrap/artifacts.sha256`. These are pilot artifacts from a
dirty tree based on app commit `e4f3e65`, not published clean-revision baselines. Final local
parent/driver patches are saved under `_scratch/perf/bootstrap/final-state/`; complete
untracked-file/build-input manifests still need implementation before controlled comparisons.

## Lifecycle investigation and harness corrections

The earlier apparent isolated-runtime shutdown reproductions were confounded: an older
compiled PetPlay server survived cleanup and reattached across runtime launches. It had
rewritten its command line to `ppvr`, so source-path matching did not find it. Its logging
parent/child PIDs and executable links established ownership; it was stopped before the clean
full-session test. Do not use those earlier runs to claim PetPlay was absent or to attribute
a driver/runtime hang conclusively.

Native debugger inspection, launched as the server's parent without relaxing ptrace policy,
observed a shared-image release calling runtime IPC during compositor disconnection. That
suggested testing server-coordinated shutdown before compositor termination. One debugger
capture stopped on SIGPIPE; that stop itself is not evidence of the production hang's cause.

Corrections under validation:

- Process discovery excludes the caller's ancestors, shell `-c` command text and zombies.
  Otherwise a script mentioning VRChat/probe names could match and terminate its own shell.
  A live worker-versus-shell regression test passes.
- Stack cleanup detects compiled servers by executable/explicit server arguments, as well as
  stored PID/start identity. Owned-server exit is awaited; timeout no longer silently deletes
  its ownership record at that step.
- The scoped launcher asks vrserver to coordinate shutdown before considering termination of
  an orphan compositor. A still-live server retains recovery configuration and reports failure.
  Unit tests check that signal ordering and refusal path.

A clean full session using the compiled production executable plus VRChat at `beyond75` passed
`up`, then `down --stop-petplay`: VRChat exited, the owned compiled PetPlay parent exited, the
synthetic lab exited and original settings/registrations were restored. No live vrserver,
vrcompositor, VRChat or owned PetPlay process remained afterward. This is one functional
lifecycle pass, not proof of repeated-cycle/soak reliability or of the original hang's sole cause.

## Pilot evidence

Raw artifacts: `_scratch/perf/bootstrap/`. These are diagnostic/pilot observations, not paired
optimization comparisons and not the required heavy active-use acceptance matrix.

- The platform-corrected compositor sampler ran against VRChat PID 581404 for 10 seconds.
  It observed 750 compositor frame-index advances (~75 Hz), sampled 746 unique timing records,
  and reported zero cumulative dropped/reprojected frames. Scene GPU time p95/p99/max was
  5.520/6.476/7.460 ms. This is a light home-world pilot, not a worst-case baseline; synthetic
  direct-mode counters also have the limitations documented in the goal.
- An observe-only 10-second release run reported 752 PetPlay overlay frames and r3f mean
  ~0.250 ms, maximum ~1.075 ms. The display layer was hidden. This does not establish active
  usability and is explicitly insufficient to accept an optimization.
- With camera calibration/recording never enabled, a temporary, restored prototype counter
  measured 750 camera `status()` calls over 10.001 seconds. This confirms the camera ball's
  per-frame idle path in the compiled release. It does not yet quantify end-to-end performance
  impact or establish that camera work is the most disruptive bottleneck.
- SteamVR's `DrawOverlays` and `WaitForPresent` markers were read from tracefs during the
  synthetic session without changing top-level tracing. A synchronized full GPU/scheduler/
  compositor trace and detector overhead validation are still needed.
- Native driver triggers reached PetPlay (`trigger: 1` in its OpenVR input snapshot), but the
  scripted wrist-menu clicks did not select the intended controls. Menu text remained on home.
  The route is failed/incomplete coverage, not a pass. Resolve grip/aim ray alignment and assert
  visible page changes before extending the driver-driven manipulation route.

The first idle-counter request exceeded the REPL's default 5-second observation timeout; it
continued to its bounded cleanup. The same measurement subsequently ran with an explicit
15-second reply timeout. `evalIn` now accepts an explicit timeout for bounded diagnostics.

## Next evidence and acceptance work

1. Extend the native menu/drag/scale route with typing and the remaining interactions. Include
   first use and sustained/reversed motion, and verify presented output rather than only state.
2. Add complete immutable build/workload manifests, timestamped resource telemetry and joined
   native/GPU/presentation trace evidence, including rare-event/freshness detection.
3. Establish debug/release heavy interaction baselines and matched, separate WayVR sessions.
   WayVR is installed; its version/settings/workload have not yet been validated for comparison.
4. Rank the observed worst cases by frequency, severity, duration and recovery. Measure camera
   streaming-while-unused and off-after-use separately, then enforce its dormancy contract
   without assuming that a reduced idle counter is a user-visible performance win.
5. Repeat lifecycle validation and active soaks. Apply the goal's full acceptance/publication
   gates before committing and pushing accepted changes. No bootstrap or app optimization
   changes from this stage have been committed or pushed.

## Subsequent native-input and startup checks

The user reports that SteamVR sometimes fails to launch. This is now tracked in
[the local startup issue](../issues/steamvr-intermittently-fails-to-start/README.md) and in
the optimization goal's preflight gate. One observed attempt lost vrserver with exit status
9 during VRChat startup; the sender and cause remain unknown. VRChat's desktop fallback
invalidated that attempt. Keep failed attempts in reliability results even after a successful
retry. Evidence is under `_scratch/perf/native-route-startup-failure/`.

Native wrist targeting was subsequently corrected by measuring the synthetic controller's
raw-pose-to-application-ray transform. The reusable `utils/vrlab-interaction-check.ts` route
passed against the compiled production executable in an isolated `beyond75` session: native
trigger presses opened Settings and all four settings pages; native grips dragged a display
0.25 m and returned it, and enlarged it with two hands and returned its scale. The report is
`_scratch/perf/native-release-functional.json`.

This supersedes the earlier failed targeting observation, but is only a functional scene-state
check. It did not verify presented pixels, run alongside VRChat, measure hitches or exercise
the complete interaction matrix. It is not an optimization acceptance or performance baseline.

## Active-route observations and stricter preflight

The production native route subsequently passed twice alongside VRChat in VR at `beyond75`.
One repeat used temporary, restored wrappers around existing frame metric recorders, preserving
raw samples instead of flushing the application's counters. Step wall times permit correlation.
`_scratch/perf/release-observed-route.json`, `release-native-route-metrics.json` and
`release-observed-phase-peaks.json` retain that evidence. This remains a light home-world pilot.

Observed tail candidates included a 29.383 ms host frame interval in the camera-menu phase and
23.501 ms host preparation when first showing the display. Host preparation includes asynchronous
pacer waits, so these are not CPU attribution. Instrumentation overhead has not been quantified;
the observations identify reproduction targets, not an accepted optimization or cause. The first
observer report also labeled non-time counters as milliseconds; later harness reports explicitly
distinguish count and time values. Do not interpret panel/batch counts as costs.

The compositor sampler now reads historical batches, preserves raw frame records on request and
reports missing records, empty polls, application identity changes and terminal progress age.
A 3-second deliberately slow 100 ms polling check recovered all 226 inclusive frame records
(225 advances) without gaps. The prior newest-only sampler could miss intermediate records.
Synthetic counters and complete records still do not prove physical scanout or overlay freshness.

Debug menu/drag/scale passed in isolation. Attempts with VRChat then exposed the
[monitor startup conflict](../issues/steamvr-intermittently-fails-to-start/README.md): a zero-loss
signal trace and monitor log identified `TerminateZombieProcesses()` killing the live direct
runtime. An owned `-nokillprocess` monitor prevents that mechanism in the tested launch; the
scoped launcher now supports it. Separately, one guarded attempt had a failed PetPlay scene
despite an attached supervisor. The lab now requires running scene/native input before and after
VRChat startup; see [the local scene-startup issue](../issues/openvr-attached-without-a-running-scene/README.md).

`utils/vrlab-trace.py` captures bounded scheduler/GPU or signal-only evidence in an owned named
instance. The first 30-second full trace overflowed (8,107,028 lost events), was rejected as
complete evidence, and restored the original top-level tracing controls. The 120-second
signal-only trace had zero lost events and was decoded successfully. Full GPU capture needs
streaming, a shorter window or justified filtering; it is not a completed native/GPU acceptance
gate. SteamVR's global markers are not automatically copied into these instances.

The integrated guarded launcher subsequently passed debug scene/input preflight, VRChat VR
startup and all nine native route steps, with no cleanup errors. Raw evidence:
`_scratch/perf/debug-integrated-{route,route-metrics,compositor,compositor-frames}.json`.
The 30-second debug observation exposed a much larger first-show tail: `frameMetric` 171.899 ms,
host rAF interval 118.581 ms and r3f advance 38.346 ms, around 16:54:40 UTC during `show-display`.
The compositor history remained complete with zero reported dropped/reprojected counters;
that discrepancy reinforces that scene-app/synthetic counters cannot clear PetPlay's hitch gate.
These are development-build diagnostic observations, not a paired debug/release comparison.

A subsequent two-second GPU/scheduler trace had zero lost events, decoded successfully and
contained 357,697 switches, 190,341 wakeups, 4,301 AMD submissions, 4,306 GPU job events and
17,136 fence signals. It began at 16:55:09 UTC, after the observed first-show hitch; it therefore
validates short capture coverage, not the hitch's cause. Its two markers were the capture's own,
not SteamVR markers. The owned instance was removed and top-level controls were unchanged.
The next targeted experiment should preallocate the trace before input, then trigger a short
capture around first display reveal, with repeated cold/warm variants and observer controls.

The integrated debug session then shut down cleanly: VRChat and owned PetPlay exited, the lab
restored SteamVR settings, and the guarded monitor was included in the scoped shutdown.

No application rendering optimization has been accepted or published. Remaining gates include
full interaction/pixel-freshness coverage, reproducible heavy load, observer overhead, joined
native/GPU evidence, matched WayVR comparisons, paired improvements and lifecycle soaks.
