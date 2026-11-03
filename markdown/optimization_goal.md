# PetPlay optimization goal and working loop

## Objective and authorization

Improve PetPlay's stability, speed, latency and resource use under a reproducible heavy VRChat
workload, primarily in the compiled production release. Use PetPlay's synthetic OpenVR driver
so the physical Bigscreen Beyond can remain off throughout unattended development and testing.
Validate both debug and release behavior. Optimize from measurements and traces, never guesses.

**Primary priority: make the worst cases less frequent and less severe.** PetPlay's ordinary
performance is already reasonably usable; the user's main problem is that bad cases occur
too often and are too disruptive. Prioritize removing interaction stalls, hitches, visible
glitches and recovery failures over shaving small amounts from an already-smooth idle/average
path. Improving typical performance remains useful, but must not displace work on the observed
tail or make it worse.

User authorization, 2026-10-18: when an optimization has demonstrated a reproducible improvement
and passed the non-breaking checks below, commit it and push it. This authorizes the relevant
PetPlay changes and required submodule dependencies. It does not authorize unrelated uploads,
issues, chat messages, release tags or publishing recordings/profiles. Do not wait for approval
again for a change that satisfies this contract. Leave inconclusive experiments uncommitted,
or revert only the agent's experiment while preserving other work.

Work on `main`, follow `AGENTS.md`, use the configured Git identity, and include its required
agent provenance trailer. This document defines a continuing workflow; it does not establish
that a particular candidate has already passed.

## What counts as success

PetPlay is an overlay sharing the machine with a game. Its success metric is reduced cost and
better stability without making the game, interaction, image quality or capture freshness worse.
Higher PetPlay FPS alone is insufficient. A lower-resolution render, slower capture rate,
hidden display, dropped update or longer queue must not masquerade as an optimization.

Stability is a property of the combined VR session. Making PetPlay harder to crash is not an
improvement if it makes VRChat or SteamVR stutter, hang, crash, reproject more, lose input,
present stale images or fail to shut down. PetPlay must not win CPU scheduling, GPU queues or
memory headroom by worsening the game/compositor experience. Treat those regressions as failed
acceptance gates even when PetPlay's own counters improve.

Rare-case frame delivery is equally important as the regular case. The target is **no dropped
frame, hitch or visible glitch attributable to PetPlay**, including isolated events during
interactions, first use, feature transitions and long sessions. A single reproducible attributable
failure blocks acceptance; an improvement in average, p95 or p99 cannot compensate for it.
Retain every observed event for investigation rather than discarding it as an outlier. Classify
unattributed events as unresolved, not harmless. The user reports that WayVR essentially never
glitches or hitches in their use; include it as a comparative reference and measure it rather
than treating that experience as a recorded zero-failure baseline.

Finite tests cannot prove that a rare event will never occur. Report event counts, completed
interaction/transition cycles, session duration and frame exposure, plus the limits of the
observation method. A zero-event run establishes only zero observed events over that exposure.
Do not redefine the zero-failure target downward because a chosen percentile hides a failure.

Each accepted change needs:

1. A recorded baseline, attributable bottleneck and explicit hypothesis.
2. Repeatable improvement larger than run-to-run variation, primarily in the release build.
3. Passing functional, lifecycle and relevant visual/freshness checks in debug and release.
4. No unexplained regression in frame-time tails, interaction latency, game timing, resource
   growth, quality or enabled-feature behavior. A tradeoff needs an explicit decision, not a
   silent exception to the gate.
5. An evidence record that another agent can use to reproduce the comparison.

“Non-breaking” means the exercised regression matrix passed; no finite test proves every
possible use case. State the scope and unresolved limitations honestly.

“It starts and the wrist clock stays smooth” is not an acceptance result. The product must
remain responsive while people use its actual features. Idle measurements are a reference
phase, not a substitute for interaction coverage. A change fails if menus, grabbing, scaling,
typing or capture feel worse under load even when its idle CPU/FPS looks better.

## Synthetic BSB workload

The starting `beyond75` profile is derived from the local physical BSB session logs dated
2026-10-18: driver recommendation 3562×3562 per eye, application recommendation 3560×3560,
75 Hz and 68 mm IPD. The native input reported by the lighthouse log is 2544 per eye. The
synthetic profile uses 2544×2544 eye output viewports. Preserve the measured application
rendering workload rather than substituting the panel's advertised pixel count.

Profile: `utils/vrlab/display-presets/beyond75.json`. Its geometry, clock, IPD and bounded
swapchain budget are explicit. `GETDISPLAYPROFILE` reports the native driver's loaded settings.
The guarded lab probe reports actual public render size, display frequency and frame-sync
behavior; reject mismatches rather than continuing under a misleading profile label.

The initial live synthetic validation produced 3560×3560 application eyes and a 75.003 Hz
frame counter over 225 waits, with no errors/invalid samples/repeated counters. VRChat allocated
two 3560×3560 triple-buffered eye swapchains. The compositor system-layer target was 4900²,
compared with 4904² in the saved physical run. These validate workload dimensions and clock,
not equivalent optical distortion, physical scanout or hardware tracking.

Keep symmetric synthetic optics and the driver-direct reprojection differences explicit in
every manifest. Do not claim a physical-headset timing bug fixed solely from this rig. The
default workflow requires no physical headset activation. Real-headset acceptance, if later
wanted, is a separate, explicitly arranged session; controller-only `--real-hmd` support exists.

Pin the driver revision and profile during each app baseline/candidate comparison. Driver
changes need their own functional/load validation before establishing a new baseline. Do not
change the test driver and PetPlay simultaneously and attribute the result solely to PetPlay.

## Build matrix: verify the build, not its label

| Variant | Purpose | Requirements |
| --- | --- | --- |
| Debug/development | Diagnostics, invariants, warnings, functional stress and debug-path regressions | Verify development React/npm resolution and native debug configuration; record instrumentation |
| Compiled production release | Primary performance, resources, startup and deployment behavior | Production React/npm, optimized native components, embedded helpers, exact executable hash |

The launcher command `dev` is not evidence of a debug build. The normal local `.env` currently
selects production conditions too. A genuine debug configuration must be established and
verified, not assumed from running source. Implement explicit debug/release build selection
if existing flags cannot produce both reliably. Record native optimization modes separately;
an optimized driver with a debug app is a legitimate configuration when identified as such.

Compare baseline debug with candidate debug, and baseline release with candidate release.
Never claim a code improvement from a debug-to-release comparison. Report any debug-only
benefit as such. A release-only optimization still needs functional coverage in both variants.

For release tests, launch the compiled executable outside the checkout, with isolated layout
and settings. Verify the binary's embedded commit/build information, hash, production conditions
and actual loaded native library/helper paths. Remove developer override paths from test
environments. Record the dirty-tree diff/hash when evaluating an uncommitted candidate; commit
identity alone cannot describe it. Retain the immutable executable used for each comparison.

The lab launcher accepts `--executable=/absolute/path/to/petplay` and records an artifact hash.
Extend manifests as needed; that initial manifest is not yet the complete configuration record.
Confirm profiling and interaction imports work inside the compiled worker, not merely from source.

## Workload matrix

Use a fixed private VRChat world, avatar, view direction, graphics settings and scripted
interaction route. Record rather than expose account identifiers/private instance URLs.
Keep per-app render scale and any adaptive quality behavior controlled and observable.
Keep desktop content, capture dimensions/rate, display count and layout reproducible.

Run these separately so costs can be attributed:

1. VRChat alone at the BSB-like target: reference game/compositor headroom.
2. PetPlay attached, presentation hidden, camera never enabled.
3. Visible idle PetPlay with the heavy display/layout configuration.
4. Animated desktop capture plus repeated hover, scrolling, typing, dragging, resizing and menus.
5. Camera calibration, then camera-layer recording, then recording with OBS, each distinguished.
6. Camera disabled after use, including continued incoming OSC traffic and repeated on/off cycles.
7. Startup, shutdown, capture reconnect and runtime reconnect stress, measured separately from
   steady-state performance.
8. Multi-hour synthetic VRChat/capture soak, with periodic interaction and resource-floor sampling.

Define a bounded worst case: documented maximum layout/capture/scene load we intend to support.
Include both near-budget load (where PetPlay can cause deadline misses) and an overloaded case.
Already-reprojecting VRChat can hide an optimization in its FPS counter; use timings and missed
deadlines. A busy public-world spot check is supplementary, not a controlled comparison.

## Mandatory active-use scenarios

Maintain a feature-to-scenario coverage inventory as the UI changes. Exercise every supported
menu/page and important interaction path, not just one convenient tile. Each scenario records
its starting state, input sequence, expected visible/state result, timing/quality metrics,
cleanup and coverage status in both debug and release. Unsupported or unautomated coverage is
an explicit gap; skipped, missing or timed-out scenarios do not count as passes.

| Area | Required active behavior | Check beyond “no crash” |
| --- | --- | --- |
| Wrist and navigation | Show/hide and move the wrist UI; open home and every Settings subpage; move between pages, back out, reopen; change wrist hand/scale/opacity | First-open and warm-open latency, hover/press feedback, correct page/state, no missing labels or stale hit targets |
| Menus and window controls | Repeatedly reveal toolbars, enter/leave settings, operate toggles and selectors, move the pointer rapidly between neighboring controls and across window edges | Hover/click latency and spikes, correct target/action, no double activation, stuck toolbar or unintended click-through |
| Drag, grab and release | Start/release direct grabs and laser drags; follow repeatable slow/fast translation and rotation paths; stop suddenly, reverse, and re-grab; test both hands | Acquisition/release latency, continuous following, visible jitter/lag, frame drops during motion, final pose and no stuck grab |
| Scale and resize | Repeatedly scale/resize from supported controls/grips through small/large sizes, including moving while scaling where supported, then release | Continuous size response, stable anchor/pivot, correct bounds/aspect and pointer mapping, no jumps, stale frames or allocation spikes |
| Desktop interaction | Hover, click, double-click, scroll and drag within moving/resized captured displays using an isolated test application | Action reaches the intended pixel/window, input ordering, scroll continuity and capture-to-visible feedback; no lost releases |
| Keyboard | Show/hide, move and resize its parent; type sustained text, modifiers, shortcuts and repeated keys; switch supported layouts | Correct characters/order/target, no stuck modifiers, key feedback latency, legends/hit targets still aligned |
| Layout and display lifecycle | Add/remove displays, select captures, lock/unlock, save/load layouts, recenter, attach/detach and change supported anchors | Visible result matches persisted graph/pose, live captures resume, no orphan nodes/consumers, memory floors recover after repeated cycles |
| Visibility transitions | Rapidly show/hide layers and menus during capture and after interaction, then resume use | Hidden work becomes dormant as intended, reopened controls still respond, current capture returns, input/grab state is released correctly |
| Camera | Traverse the camera page, calibrate with pauses and hand switches, start/stop recording and change resolution, then return to normal desktop interaction | Progress/setup remains usable, ball/recording exclusions correct, output fresh, other interactions responsive, off-after-use contract holds |
| Notifications and combinations | Inject local test notifications during typing/dragging/menu use; combine animated multi-display capture with these interactions, and separately with recording/OBS | No input theft or occlusion failure, burst-related stalls, stale output, growing queues or VRChat/compositor deadline regression |

Cover supported boundary/failure behavior as well: locked objects, capture loss/recovery,
interaction cancellation when a menu/object disappears, and quick successive input. Test
supported interaction modes rather than inventing a nonexistent gesture and calling it broken.
Protect the user's actual desktop: use isolated layout/settings, disposable test text/windows
and local event fixtures. Do not type into unrelated applications or send messages externally.

Run focused scenarios to attribute costs, then a repeatable mixed-use route under the heavy
synthetic VRChat workload. A representative route opens several menus, selects/scrolls a
display, drags and scales it, opens/types on the keyboard, changes a window setting, saves/loads
a layout, exercises visibility, and returns to the initial state. Also test cold first use;
pre-opening every menu during warmup can hide the exact stalls users encounter.

Use real input delivery for acceptance: synthetic driver poses/buttons/axes through OpenVR,
PetPlay hit-testing and handlers, capture/input transport where applicable, then rendering and
presentation. Direct scene/store mutation can arrange fixtures or help isolate a problem; it
does not prove that the equivalent user interaction works. Run the same route against the
compiled executable. Source-only `--novr` playtests are complementary regression coverage,
not a replacement for the VR input/presentation path.

Existing scenarios provide starting points under `tests/playtest/`: `wrist`, `window-settings`,
`hovertoolbar`, `smoke`, `layouts`, `keyboard`, `lifecycle`, `showhide`, `grablatency`, `grabdrops`,
`laserlag`, `toasts` and `camera`. Audit what each actually exercises before claiming coverage;
some use injected state or bypass native input. Extend the driver-driven scenarios where that
leaves a gap instead of assuming a similarly named test proves the complete path.

### Interaction evidence and acceptance

Tag traces with scenario/step and input sequence identifiers. Measure input arrival to first
correct visible response, grab/scale acquisition and release, continuity during sustained
motion/scroll/typing, and cold/warm menu transitions. Report p50/p95/p99/max and failed/missed/
duplicate actions per scenario, alongside VRChat/compositor timings during the same interval.
An average across idle and active phases must not conceal bad interaction tails.

Check following error, jitter, target/anchor stability, final pose/scale and text correctness
against each scripted action's expected behavior. A scene-graph update alone does not establish
that the correct pixels were presented: use frame identities, bounded visual checks or another
verified presentation observation. Keep costly visual/readback diagnostics separate from clean
timing runs and account for prediction/sample timing when interpreting motion error.

Define per-scenario regression guardrails before evaluating the candidate, using the established
baseline and measurement noise. Faster idle behavior cannot buy a slower menu or worse drag/
scale response. Preserve the complete required route and test counts between versions; do not
improve the score by simplifying the layout, reducing input rate, removing notifications,
skipping difficult pages or running active tests without VRChat competing for the GPU.

Soaks must repeat this active-use route periodically, checking visible/state results and
resource cleanup after each cycle. Record completed/failed cycles and which features were
exercised. Hours spent rendering only a wrist watch do not establish stability of the desktop,
menus, manipulation, keyboard, camera or capture lifecycle.

## Rare-event and WayVR comparison gate

Run matched, separate sessions for VRChat alone, VRChat with WayVR, and VRChat with PetPlay,
using the same synthetic BSB profile, world/view, animated capture content, comparable visible
display count/resolution/rate, and interaction sequences supported by both overlays. Never
run both overlays together and attribute the combined result to either one. Record WayVR's
exact version/settings, warmup, quality and resource use. Do not silently lower PetPlay quality
or omit a problematic interaction to make the comparison favorable. PetPlay-only features get
their own zero-failure tests; lack of a WayVR equivalent does not exempt them.

Record every deadline miss, unexpected frame gap, repeated/stale presented frame, pose/size
jump, flicker, corrupt image, lost input and recovery event. Separate intentionally unchanged
content or demand-paced idle frames from failures to deliver a required visual update. Observe
presentation generations and motion continuity as well as runtime drop counters: a visible
glitch need not increment SteamVR's dropped-frame count. Include cold shader/asset paths,
first menu open, rapid manipulation, concurrent capture/notifications, reconnects and long-tail
resource pressure. Repeat the exact triggering sequence when an event appears.

For an isolated failure, save a bounded rolling interval before and after the event, correlated
input/scene/present identifiers, native/GPU timeline, workload state and resource pressure.
Use continuous lightweight detection and retain a short diagnostic window; frequent readback
or always-on heavy profiling can itself cause hitches. Establish detector coverage and overhead
before trusting a zero-event result. Explicitly label glitches the synthetic observer cannot
detect instead of implying physical visual comfort has been measured.

Compare maximum stalls, event counts/rates and time/cycles to failure over equivalent exposure,
in addition to distributions. If PetPlay exhibits a rare failure absent in matched WayVR runs,
investigate and resolve it before accepting the candidate; do not dismiss it because most
frames are faster. A failure also present in VRChat-only/WayVR runs still needs attribution:
shared system pressure is not automatic proof that PetPlay makes no contribution. Numerical
budgets must not authorize even one known reproducible PetPlay-attributable failure.

Track severity explicitly: longest frame/update gap, consecutive missed updates, longest
visible freeze, time spent unresponsive and recovery latency, alongside events per minute and
per interaction/transition. Maintain a trigger-based worst-case corpus and replay it against
every candidate. Do not let a shorter but more frequent hitch, a rarer but much longer freeze,
or a faster recovery that loses user state disappear inside one aggregate score. Zero failures
remains the target; partial reductions can guide the next experiment without being presented
as having solved the defect.

## Evidence collection

Before optimization begins, follow the [Valve graphics debugging preflight](valve_graphics_debugging.md).
Review Valve's Linux GPUVis/native profiling instructions, verify local tracing permissions,
and prove a useful capture can be collected and read. V8 profiles alone do not satisfy the
baseline or acceptance requirements: include native scheduling, GPU submission/completion,
fence waits and compositor/VRChat timing evidence appropriate to the suspected bottleneck.
Neither a prettier JavaScript profile nor fewer PetPlay crashes compensates for a worse
VRChat/SteamVR experience. Keep trace-enabled diagnostic runs separate from clean comparisons.

Every experiment lives under `_scratch/perf/<experiment>/<variant>/<run>/`. Never use PetPlay's
runtime `tmp/` for agent artifacts. Save a machine-readable manifest and raw samples before
creating summaries. Record timestamps/clock alignment, revision/diff, binary hashes, toolchain,
driver profile, hardware/driver versions, launch arguments, selected environment, workload and
instrumentation settings. Missing data is missing, not zero.

Collect enough to separate CPU work, GPU work, transport delay and deliberate waits:

- PetPlay stage p50/p95/p99/max, deadline misses and frame indices: input/update, React, scene
  extraction, serialization, transport/queueing, capture import, rendering, submission and pacing.
- VRChat scene-app and compositor frame times, presents, dropped/mispresented frames and
  reprojection. Scene-app/compositor timings are not isolated PetPlay GPU attribution; use
  controlled comparisons and targeted traces to establish responsibility.
- Process-tree/per-thread CPU, wakeups/context switches, RSS and PSS, heap/GC, VRAM,
  descriptors, workers/threads, message counts/bytes and retained assets/caches. Avoid counting
  shared mappings repeatedly as unique memory. Examine warmed-up floors and growth slopes.
- Input-to-visible-update and capture freshness. A render loop repeatedly drawing an old frame
  can report healthy FPS. Verify scene/overlay/OBS delivery with frame identities or equivalent
  observations when testing those paths.
- Time to first useful presented frame, feature start/stop latency, reconnect/repair counts,
  shutdown completion, crashes and last native trace.

Use low-overhead counters first. Capture short V8 profiles in the relevant isolates/processes;
use native sampling/GPU traces when the unexplained cost is outside JavaScript. Probe tool
capabilities and permissions before relying on them. Do not interpret a missing native stack or
GPU timestamp as proof of no native/GPU work.

Image readback, screenshots, frequent logging and CPU profiling are separate diagnostic modes.
Keep them off during clean timing baselines. Measure observer overhead by repeating the same
case with and without instrumentation. Use bounded buffers; profiling disabled must not leave
an ongoing timer, log stream or allocation-heavy hook in the production hot path.

## Optimization loop

1. **Inventory and freeze.** Read current docs/issues, inspect dirty work, select the baseline
   artifacts, pin the driver/workload, and verify scoped settings/recovery. Do not overwrite
   unrelated user work or commandeer an existing real-headset session.
2. **Preflight both variants.** Confirm startup, correct profile/targets, capture/input readiness,
   compiled helper loading and profiling availability. Fail early on mismatched configuration.
   SteamVR sometimes fails to launch or dies during application startup; this is a known
   intermittent condition, not a valid zero-work benchmark. Preserve each failed attempt,
   detect VRChat desktop fallback, verify runtime identity/liveness after world entry, and
   retry only after bounded cleanup. Keep startup failures in reliability results even when
   a later retry succeeds. See [the local issue](issues/steamvr-intermittently-fails-to-start/README.md).
3. **Warm up and measure.** Separate cold start from steady state. Use repeated, paired runs
   with alternating baseline/candidate order; at least three pairs for screening and five for
   acceptance, expanding when results remain noisy. Pick phase durations before seeing results;
   collect enough frames for tail estimates and report variability/sample counts.
4. **Locate the cost.** Use counters and traces to name the responsible stage/function/resource.
   Rank observed failures by frequency, severity, duration and impact on real interactions/
   VRChat/SteamVR, including low-frequency catastrophic cases. Start with the most disruptive
   evidenced case rather than automatically choosing the largest average CPU hotspot. Record
   the triggering sequence, evidence, expected mechanism, primary metric and guardrails before editing.
5. **Make one bounded change.** Preserve behavior and quality. Avoid mixing refactors, feature
   changes and multiple performance hypotheses. Use a focused regression test when a meaningful
   invariant or failure mode needs coverage; do not add tests that merely restate the implementation.
6. **Re-run the identical matrix.** Compare matching build variants, raw distributions, workload
   verification and resource/freshness results. Include start/stop and off-after-use checks for
   anything introducing a worker, consumer, timer, subscription or cache. Run the mandatory
   active-use scenarios and mixed-use route in both variants; inspect each scenario's tails and
   correctness rather than relying on whole-run FPS or an idle-only smoke test.
7. **Accept or reject.** Accept only reproducible gains exceeding observed measurement noise,
   with passing regression gates and no unexplained adverse change. If inconclusive, extend the
   experiment or reject it. Keep negative findings so the same hypothesis is not rediscovered.
8. **Commit and push accepted work.** Follow the publication procedure below. Record exact
   pushed commits and CI results, then use the accepted version as the next baseline.
9. **Repeat from evidence.** Select the next most disruptive demonstrated worst case or stability
   failure, considering frequency and severity together. Use ordinary cost reductions when
   evidence connects them to the tail, the inactive-feature contract, or a meaningful resource
   constraint; do not optimize an easy idle metric merely because the active-case defect is harder.
   Periodically rerun the full heavy matrix and soak so local wins do not conceal system regressions.

Do not repeatedly tune code to one favorable run or pick a different baseline after seeing
results. Define numeric guardrails from the established baseline, measurement noise and active
refresh budget before evaluating candidates. At 75 Hz the display interval is about 13.33 ms;
PetPlay shares that budget with the game and compositor. Earlier claims that the GPU path is
already fine are hypotheses to recheck, not constraints on what the traces may reveal.

## Camera inactive contract: first priority

Measure three distinct inactive states: never used, off after calibration/recording, and unused
while camera OSC continues arriving. Add demand/call counters so inactivity is directly testable.

With no camera page, calibration, recording or explicit diagnostic consumer active, require:

- No camera solves, look-at-target fitting, controller sampling or camera scene extraction.
- No camera per-frame callback or status-publication loop.
- No camera recording process/scene consumer, retained recording assets or resident solver worker.
- No discovery/receiver activity if full dormancy is selected. If minimal discovery remains a
  product requirement, document and measure that explicit exception instead of claiming zero work.

Demand can begin when the camera page is opened or a calibration/recording command is issued.
Handle async cancellation, late solver results, listener cleanup, reopening, hand changes,
saved calibration, port contention and VRChat rediscovery without regressing setup usability.
Preserve the visible ball during capture and its exclusion from recorded output.

Current paths to measure are documented in
[`petplay-2.0/release-performance-survey.md`](petplay-2.0/release-performance-survey.md).
Their existence is established; their relative cost is not yet a benchmark result.

## Regression, stability and publication gates

Run `deno task check` and the relevant unit/integration/playtests. For an accepted app change,
run the full existing `deno test -A --no-check classes utils` suite before publication. Use
debug and compiled-release interaction coverage for touched behavior. Driver changes also run
the Zig official-header ABI/protocol tests, scoped launcher/restoration tests and live profile
probe. Vendor-filtered type checking is the supported project check.

Before automatic commit/push, the required active-use route must pass in both variants, with
the coverage inventory and per-scenario results attached to the experiment record. A focused
optimization's quick local loop may use a subset, but publication requires the complete route.
Unexplained regressions in any required menu/manipulation/input scenario block acceptance even
when startup, the wrist clock and aggregate performance remain healthy.

Use short repeated lifecycle stress as a pre-commit gate for lifecycle/resource changes. Add
longer soaks for retained resources, capture, native lifetime or repair changes; a clean short
run does not establish long-term stability. Track crash-free time and exercised transitions.
Preserve failure traces and fix the reproduced cause before declaring the change stable.

Before committing, inspect the complete staged diff for scope, secrets and accidental artifacts.
Commit the implementation, relevant regression coverage and concise evidence summary together.
Include baseline/candidate metrics, build variants, run count, limitations and reproduction
instructions in tracked documentation; keep large raw profiles, logs and videos local.

If a submodule changed, commit and push its verified change to its configured repository first,
then commit/push the parent's exact gitlink. Verify every referenced submodule revision is
remotely fetchable. The v0.0.12 release initially failed because its driver revision existed
only locally; do not repeat that failure. Do not publish unverified experiments just to make
a parent checkout clean.

Push accepted work to `main` without force-pushing or rewriting published history. Check CI on
the exact pushed revision. Investigate failures; do not call a change accepted/published-and-good
while required CI fails. If the hypothesis fails after publication, make a normal corrective or
revert commit based on evidence. Creating a new version tag/release requires a separate request.

## Experiment record and handoff

For each candidate, record: question; hypothesis; evidence pointing to the cost; baseline and
candidate artifact/configuration identities; workload; instrumentation overhead; raw run paths;
debug/release results and variation; functional/lifecycle results; decision; known limits;
commit(s), remote verification and CI link/result. Explicitly distinguish infrastructure work
from an optimization and a functional pass from a measured speed/resource improvement.

At a handoff, state the current baseline, active experiment, live processes owned by the run,
pending recovery, outstanding failures and next evidence needed. Restore scoped SteamVR settings
and stop owned test processes after bounded runs. Keep the physical BSB out of unattended loops.

## Initial checkpoint, 2026-10-18

The configurable driver/preset and exact-release launcher are implemented locally. Driver ABI/
protocol tests and scoped settings/restoration tests passed. A freshly compiled production
PetPlay executable at app commit `e4f3e65` ran with VRChat on the BSB-sized synthetic rig.
Compiled-worker CPU profiling worked. Driver telemetry showed four live swapchain sets,
880,406,400 bytes and zero allocation failures at the sampled point. This is a functional
infrastructure check, not a before/after performance result or an accepted optimization.

The bounded live run exposed a shutdown failure: vrserver and vrcompositor remained alive after
graceful termination. Their thread wait-state snapshot is saved locally. The owned processes
were forcibly stopped and the original SteamVR settings/driver registrations restored; the
physical headset was not activated. Do not count this as a passed unattended lifecycle/soak
gate. Reproduce and trace the shutdown hang before depending on unattended long runs.

Still needed: genuine debug-build configuration and comparison, complete reproducible manifests
and joined telemetry, heavy-case baselines, camera inactivity measurements, and the first
evidence-backed optimization. The new profile/harness work remains uncommitted pending its own
review and lifecycle validation. No new optimization has yet qualified for automatic publication.

Graphics preflight follow-up: Valve's guidance has been reviewed and persistent user-accessible
tracefs/native perf access installed. A bounded non-root scheduler/AMD GPU/fence trace and
system-wide native profile decoded successfully, with zero loss in the accepted capture.
See [`valve_graphics_debugging.md`](valve_graphics_debugging.md) for evidence, the rejected
small-buffer trial and remaining limits. SteamVR marker coverage in the actual synthetic
workload, kernel symbol availability where needed, and post-reboot permission checks remain
explicit preflight items; the V8-only route is not sufficient to start accepting optimizations.
