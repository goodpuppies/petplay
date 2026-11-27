# Scene matrix freshness is recomputed ad hoc across components

Status: open

## What happens

Several components recompute parent/world matrices by hand — the laser edit menu, hand-origin lookup, and wrist facing test each recompose parent matrices manually, while display sync forces `updateWorldMatrix`. A direct matrix write on a node with `matrixAutoUpdate = false` can leave its children with last frame's world matrix.

Separately, `getHeadObject` already exists (`classes/environment/trackedOrigins.ts:51`), yet components like Settings (and PR #11's test cube) repeat ad-hoc `Deno.args.includes("--desktop")` + `(renderer as ...).xr.getCamera()` lookups.

## Expected

Invalidate world matrices at the component that writes an XR matrix, run one coherent pose-update phase per frame before picking and extraction, and standardize on `getHeadObject` for head lookups.

## Notes / evidence

- Noted 2026-11-27 while reviewing PR #11 (`markdown/pr11notes.md`).
- Relevant code: `classes/environment/trackedOrigins.ts:51`, `classes/webxrRaythreeScene.ts:74`.
