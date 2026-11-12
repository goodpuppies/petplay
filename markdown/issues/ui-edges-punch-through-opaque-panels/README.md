# Keyboard and wrist element edges become transparent over opaque panels

Status: in progress — blend correction validated offscreen 2026-11-12; headset confirmation pending
Track: Basic UI/UX

## What happens

Antialiased edges of keyboard and wrist elements let the scene behind the overlay show
through, even where an opaque UI panel should cover it.

## Cause and correction

The UI pass inherited Raylib's `BLEND_ALPHA`, which uses `SRC_ALPHA` for the source
alpha channel as well as RGB. Its resulting alpha is `As * As + Ad * (1 - As)`.
At a half-covered edge over an opaque destination this gives 0.75 instead of 1.

`classes/uiAlphaBlend.ts` selects separate RGB/alpha source-over factors for the UI
pass in `classes/webxrRaythreeRaylibRenderer.ts`. Color blending is unchanged; alpha
now uses `As + Ad * (1 - As)`. The pass restores Raylib's default mode afterward.
This applies to panels, image fills and MSDF text; native vector text already uses
separate source-over alpha factors and restores the surrounding GL state.

## Validation

`tests/pathfinder_text/ui-alpha.ts` renders overlapping production UI panels through
the stereo eye renderer and panorama combine without SteamVR. The initial baseline
reproduced 262 non-opaque pixels over an opaque background. After correction, opaque
backgrounds remain opaque in both eyes and the panorama for linear and Catmull-Rom
filtering. With a transparent background, edges of the smaller panel preserve the
opaque backplate and the exterior remains transparent. Batched and forced-unbatched
panel runs pass. `deno task check` passes.

The active instance's watcher loaded the corrected renderer. In-headset confirmation
is still required. This correction does not address separate outer-silhouette
resampling or premultiplied-color behavior in the panorama/compositor.
