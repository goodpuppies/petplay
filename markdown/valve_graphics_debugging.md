# Valve graphics debugging preflight

Reviewed 2026-10-18, before the optimization campaign. This complements
[`optimization_goal.md`](optimization_goal.md). Preserve VRChat and SteamVR frame delivery,
responsiveness and stability throughout; improvements to PetPlay's V8 load alone are insufficient.

## Primary guidance

- [Valve: collecting SteamVR Linux performance data](https://github.com/ValveSoftware/SteamVR-for-Linux/blob/master/CapturingPerfData.md)
  describes enabling GPU profiling, restarting SteamVR, taking a GPUVis capture during the
  problem, and native CPU sampling with `perf`. Its rolling capture contains only a short
  interval, so capture while the failure occurs. The document's sharing steps are not part of
  this local workflow; keep captures under `_scratch/perf/`.
- [Valve gamescope: tracing](https://github.com/ValveSoftware/gamescope/wiki/Tracing) shows
  ftrace/trace-cmd capture with scheduler, DRM, GPU job and fence events, viewed in GPUVis.
  Discover which events exist on the installed kernel/GPU instead of copying an obsolete
  Intel/AMD event list and treating missing events as zero activity.
- [Valve's OpenVR header](https://github.com/ValveSoftware/openvr/blob/master/headers/openvr.h)
  defines `Compositor_FrameTiming` and timing APIs. Inspect the field comments in the pinned
  local header when interpreting timings. Separate rendering, submission, blocking and
  compositor costs; scene-app statistics are not per-overlay GPU attribution.
- [Linux ftrace documentation](https://docs.kernel.org/trace/ftrace.html) explains trace buffers,
  events, clocks and controls. Turning `tracing_on` off alone does not necessarily remove all
  tracing overhead; disable the events/tracers configured by the experiment as well.
- [Linux perf permissions](https://docs.kernel.org/admin-guide/perf-security.html) describes
  per-process/system-wide restrictions and `CAP_PERFMON`. Prefer scoped profiling access over
  granting a tool broad administrative capabilities or relaxing the host's global perf policy.
- [GPUVis](https://github.com/mikesart/gpuvis) is the trace viewer used here.

The installed SteamVR `bin/linux64/gpu-trace` script is another concrete reference for its
event list, buffering and capture behavior. It currently attempts to make its bundled tools
setuid root. Do not run that setup unreviewed; the user-owned tracefs/system perf route below
is separate. Do not assume the script's historical bundled trace-cmd requirement is irrelevant:
validate marker decoding and scheduler/GPU/fence event coverage with the installed versions.

## Machine inventory and access

Initial checks found GPUVis `0.2-1`, trace-cmd `3.4-1.1` and perf `7.2.8-2` installed. ftrace is
provided by the running kernel. `/sys/kernel/tracing` was mounted but root-only; the old
temporary permission change had not survived boot. `perf_event_paranoid=2` and
`kptr_restrict=2`. A user-space own-process `perf stat` worked; system-wide `perf stat` was denied.

Requested persistent setup, limited to Ellie (UID/GID 1000):

- A systemd tracefs mount drop-in sets `uid=1000,gid=1000,mode=0700`, retaining
  `nosuid,nodev,noexec`. It also applies to the current mount through a remount. This grants
  Ellie's account control of system tracing, not an always-running profiler. General debugfs
  permissions remain unchanged.
- A separate root-owned `/usr/local/libexec/petplay-perf`, group `ellie`, mode `0750`, carries
  only `cap_perfmon=ep` for system-wide native sampling. The distribution `/usr/bin/perf` is
  unchanged. A root-owned pacman post-transaction hook refreshes this copy after perf upgrades.
  `/home/ellie/.local/bin/perf-petplay` selects this copy for `record`/`stat`/`top`, and ordinary
  `/usr/bin/perf` for offline report/script analysis.
- No global perf/kptr sysctl reduction, setuid tool, passwordless sudo rule, or new login group.
  Kernel symbol names may remain restricted; report that limitation rather than claiming full
  kernel stack attribution.

This is meaningful profiling access: Ellie's processes can inspect system-wide activity and
control tracefs. The one-time installation uses the machine's reviewed `sudo-gui` mechanism,
documented in `/home/ellie/docs/sudo.md`. Record the actual validation result below before
calling the permission preflight complete. Verify effective access again after reboot; no
reboot is required merely to apply the current-mount change.

## Capture procedure and interpretation

1. Record kernel, Mesa/DRM, SteamVR, Proton/VRChat, GPUVis, trace-cmd and perf versions, the
   exact synthetic driver/profile and application binaries. Record the selected tracing clock.
2. Confirm no other capture owns tracing. Use a bounded named trace instance when supported;
   coordinate top-level trace-marker requirements explicitly. Do not reset another active
   profiler's buffers or leave recording enabled after the run.
3. Discover scheduler, AMD GPU submission/execution, fence and DRM/vblank events. Include
   wakeups/context switches so runnable-but-starved threads are distinguishable from CPU work,
   waits and deliberately paced sleep. Verify SteamVR markers actually arrive after launch.
4. Reproduce the fixed synthetic VRChat workload and record a short problematic interval.
   Correlate PetPlay/VRChat/vrcompositor thread identities, application frame indices and
   monotonic markers. Preserve the raw trace and record lost/overwritten events.
5. Inspect the CPU/GPU timeline in GPUVis: submission gaps, queue contention, waits/fence
   completion, compositor deadlines and game-frame delivery. Cross-check with OpenVR timing
   counters. Use targeted native `perf record`/`report` and per-isolate V8 profiles to explain
   expensive intervals rather than treating all wall time as active computation.
6. Add targeted GPU/frame capture only when pipeline/shader/texture questions remain. Keep
   RenderDoc/readback and detailed diagnostics out of clean baseline runs and measure their
   observer cost. Never infer a GPU improvement solely from a shorter JavaScript stack.
7. Disable only the events/tracers this run enabled, remove its instance, and verify the
   remaining tracing state. Compare uninstrumented matched runs before accepting a change.

A synthetic display need not produce physical display vblank events. Mark that distinction
explicitly and verify native synthetic clock/compositor delivery instead of inventing missing
hardware measurements. A useful diagnostic trace must contain real events and a consistent
timeline; an empty trace or successful file creation alone is not a passed preflight.

## Status

Persistent permission installation completed through reviewed elevation. The systemd mount
drop-in is loaded, tracefs is owned by Ellie with mode 0700, the restricted perf copy has only
`CAP_PERFMON`, and its hash matches the packaged binary. Global perf/kptr policies remain at 2.
The package hook is installed; an actual package upgrade and reboot have not been exercised.

Non-root validation completed:

- `perf-petplay stat -a` works. A one-second system-wide cycles profile recorded 833 samples,
  with zero lost samples, and the ordinary `perf report` decoded it. Kernel symbol names are
  unresolved under the retained kptr policy; native user-space and timeline evidence remain useful.
- Direct configuration of a temporary named tracefs instance plus `trace-cmd extract` produced
  a readable trace: 85,874 scheduler switches, 42,793 wakeups, 1,196 AMD submissions, 1,211 AMD
  scheduled jobs, 5,015 fence signals and both begin/end test markers. All CPU buffer overrun,
  commit-overrun and dropped-event counters were zero with 8192 KiB per-CPU buffers.
- The temporary instance was removed. Top-level `tracing_on`, tracer, event-enable summary and
  clock stayed unchanged, including the pre-existing BPF print event. No global tracing reset
  was performed. GPUVis opened the trace in a bounded launch without reporting a load error;
  detailed visual/timeline interpretation is still part of the actual experiment.

The installed `trace-cmd record` attempts a root-only write to `kernel.ftrace_enabled`, even
though it is already 1. Use direct named-instance event configuration followed by extraction
instead of granting broader privileges. A repeatable one-second access check is saved at
`/home/ellie/.local/share/petplay-profiling/trace-smoke.py`; raw evidence is under
`_scratch/profiling-access/`. The first 1024 KiB-buffer trial overflowed and was rejected; do not
reuse it as lossless evidence.

This proves local native/GPU tracing access without activating the physical headset. It does
not yet prove SteamVR marker visibility or a complete VRChat/compositor trace: global SteamVR
markers are not automatically copied into a named instance. Establish coordinated top-level
capture ownership or a verified marker-routing method in the next synthetic session, then
check the full timeline before accepting optimizations. Machine setup and rollback are in
`/home/ellie/docs/PROFILING_ACCESS.md`.
