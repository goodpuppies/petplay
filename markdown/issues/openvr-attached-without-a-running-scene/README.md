# PetPlay can report OpenVR attached after its scene fails to start

Status: open
Track: stability-performance

## What happens

During a compiled-debug `beyond75` run on 2026-10-18, the supervisor reported `attached`
while the WebXR host was stopped, `frameCount` was zero and `rootStore` was null. The log
reported `DirectOpenVrInputSource: failed to set action manifest path`. Native menu targeting
then failed because there was no scene. The fallback overlay pump still produced frame metrics,
so frame counts alone would also have concealed the failed application startup.

This attempt used a guarded monitor; vrserver PID 612539 and vrcompositor PID 612602 remained
alive while VRChat entered VR. It is distinct from the monitor killing the runtime.

## Expected

Scene/input startup failures must be visible as an unhealthy application, with the underlying
OpenVR error code retained. Functional/performance preflight must require the running scene,
native input and advancing host frames, as well as an attached supervisor. Do not accept a
fallback/debug frame as proof that PetPlay's UI works.

## Evidence and current limits

`_scratch/perf/debug-vrchat-guarded-route.json` retains the scene-query failure and cleanup errors.
`debug-vrchat-guarded-metrics.json` has fallback frame metrics but no extraction or host-preparation
samples; `debug-vrchat-guarded-compositor*.json` records the scene app separately.

A later diagnostic `SetActionManifestPath` call with another staged copy of the same actions
returned `VRInputError_None`. The original failure's error code was not logged. That later
success does not explain the original failure, establish a manifest mismatch or prove a retry
policy is sufficient. Root cause and recovery behavior remain unverified.

The lab preflight now checks scene/input readiness. This prevents false benchmark acceptance;
it does not fix the application's startup failure.
