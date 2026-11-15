# Quest 3 sleep can leave WebXR rendering looking inverted

Status: open

## What happens

On 2026-11-13 the user reported that after the Quest 3 sleeps, PetPlay's WebXR/shader rendering
can become inverted. PetPlay was still running in that state when diagnostics were captured.
The exact visual inversion (orientation, depth, colors or other shader behavior) has not been
isolated, and no screen capture was taken.

## Expected

Headset sleep/wake should preserve the scene's render and presentation conventions.

## Repro

User-observed trigger: let the Quest 3 sleep, then resume VR. Reproduction frequency and the
precise sleep/wake sequence are unknown. Do not change SteamVR or force the user's headset to
sleep while they are using it.

## Notes / evidence

Before the requested restart, the runtime supervisor remained `attached` (attach count 1,
detach count 0), WebXR continued rendering, and its health reported no error. The presentation
watch reported no repairs or restarts. Raylib's GL health self-heal count was zero, with its
expected context still recorded and render targets/shader allocated. This does not establish
that GL state, projection state or the shader output was correct; current health checks mainly
cover object validity, framebuffers and context resets.

The user reported that it had recovered while the requested PetPlay restart was being performed.
PetPlay was in fact stopped and relaunched at 19:36 UTC (21:36 Europe/Helsinki); that may explain
the observed recovery. This is not evidence of an automatic fix or a confirmed root cause.
SteamVR stayed running with the same vrserver PID. The Windows source stayed running, and the
local remote feed was reattached after restart.

Attached health/renderer snapshots were captured before restart, with a healthy post-restart
health snapshot for comparison. Full temporary diagnostics remain in `_scratch/quest-sleep-*`.
Logs: `logs/petplay-2026-11-13T17-10-21-784Z.log` (before) and
`logs/petplay-2026-11-13T19-36-05-676Z.log` (after). No speculative recovery/reset change was made.
