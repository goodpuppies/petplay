# Display placement is an out-of-band protocol built inside a React component

Status: open

## What happens

`DisplayInstance` (`classes/environment/displayInstance/ui.tsx`) sends OpenVR overlay rows, width, alpha, crop, curvature, and device attachment out of band directly from React, finds its grab state by walking parents, and registers a global callback for release. Meanwhile the eye renderer and browser preview each consume different markers (`desktopSurface`, etc.), with nothing unifying them — for example, auto-hide fades the OpenVR overlay alpha without fading the eye feed.

## Expected

Unify display placement and visibility state in one scene/renderer protocol so OpenVR quads, the eye renderer, and the browser/scene-stream view stay consistent (and display-attached UI toolbars can coordinate cleanly with the display quad).

## Notes / evidence

- Noted 2026-11-27 while reviewing PR #11 (`markdown/pr11notes.md`).
- Relevant code: `classes/environment/displayInstance/ui.tsx`.
