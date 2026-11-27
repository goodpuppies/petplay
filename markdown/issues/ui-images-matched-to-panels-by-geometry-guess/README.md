# UI images are matched back to their panels by size and position heuristics

Status: open

## What happens

`UiImage` renders as an invisible mesh measured by uikit. Both `classes/webxrRaythreeRaylibRenderer.ts` (around line 2176) and `classes/sceneStoreWriter.ts` separately guess which UI panel an image fills by comparing sizes and nearby world positions.

- A heuristic miss draws the image on top of everything.
- The image pass sets no clip, so rounded images can escape their scroll containers.
- Image textures have to be registered in two separate tables (`UI_TEXTURE_PATHS` and `classes/sceneStoreWriter.ts`).

## Expected

Make an image fill a real property of its panel (inheriting that panel's identity, clip, border radii, and draw order), keep a separate item type only for free-standing artwork, and use one shared image asset table.

## Notes / evidence

- Noted 2026-11-27 while reviewing PR #11 (`markdown/pr11notes.md`).
- Relevant code: `classes/webxrRaythreeRaylibRenderer.ts:2176`, `classes/sceneStoreWriter.ts`, `classes/environment/ui/image.tsx`.
