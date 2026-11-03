# SteamVR intermittently fails to start or survive application startup

Status: open
Track: stability-performance

## What happens

The user reports stochastic SteamVR launch failures. A synthetic optimization run on
2026-10-18 also lost vrserver after PetPlay had attached, during VRChat startup. VRChat then
entered a world in desktop mode. The launcher incorrectly treated that fallback as success.

## Expected

Record an incomplete startup as a failed attempt, preserve its logs, restore the scoped lab,
and exclude the attempt from valid VR benchmarks. A successful retry must not erase the
failure or make the startup failure rate appear zero. Do not lower render settings or activate
the physical BSB as a fallback.

## Notes / evidence

Local evidence: `_scratch/perf/native-route-startup-failure/`. The failed server's `/proc` stat
record had exit status 9 (SIGKILL). This does not establish a SteamVR exception/segfault or
identify who sent the signal. There was no memory-pressure/OOM evidence in the checks performed.
Keep the user's broader observation distinct from this specific unexplained process death.

Launch-attempt IDs must record runtime/app PIDs and start identities, log offsets, configuration,
readiness, elapsed time and terminal outcome. Detect failure even after initial readiness:
before accepting a phase, require the same live runtime, an attached PetPlay client and VRChat
in VR. A desktop fallback, stale log, dead keepalive or replaced runtime invalidates that phase.

Use bounded retries only after verifying the failed attempt's processes are terminal or have
been cleaned up and scoped settings restored. A polling timeout alone is not evidence of
process death. Preserve all failed attempts and report startup failure frequency separately
from steady-state performance.

## Identified lab failure mechanism (2026-10-18)

Two subsequent compiled-debug + VRChat attempts also lost the runtime. A controlled test
then passed the native menu/drag/scale route with debug PetPlay alone, and lost SteamVR when
launching VRChat through Steam. A zero-loss signal trace caught `pkill` sending SIGKILL to
vrcompositor PID 607188 and vrserver PID 607093. The matching `vrmonitor.txt` shows monitor
PID 609396 starting as `vrmonitor://driverinstalled`, then `TerminateZombieProcesses()`
terminating vrwebhelper, vrcompositor and vrserver at the matching timestamps.

Evidence: `_scratch/perf/debug-startup-signals/`, including the raw trace, process/log snapshots
and clock correlation. Top-level tracing settings were preserved and the owned instance removed.
This identifies a monitor startup conflict in this lab reproduction; it does not establish that
every intermittent failure reported by the user has the same cause.

An explicit monitor launched with `-nokillprocess` (as in the existing local SteamVR launcher)
prevented that termination in a controlled test: the same vrserver/compositor survived VRChat's
VR startup. The scoped launcher now exposes `--guard-monitor`, enabled by `vrlab up`; the
integrated launcher subsequently passed debug scene/input preflight and VRChat VR startup.
Repeated-cycle/soak validation remains incomplete. The failed attempts remain failures regardless
of the workaround's outcome. A separate [scene startup failure](../openvr-attached-without-a-running-scene/README.md)
was found in the first guarded run and must not be hidden by runtime liveness.
