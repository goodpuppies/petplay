# uikit `backgroundOpacity` and `borderOpacity` props do nothing

Status: open

## What happens

The vendored uikit is 1.x, which removed `backgroundOpacity` and `borderOpacity` (alpha now goes in the colour value). However, `submodules/threewebxrwebgpudeno/webgpu-uikit.tsx` still declares those props and passes them through, where uikit silently drops them. Because the wrapper declares them, type-checking never catches the ~110 uses across 28 files.

As a result, `backgroundOpacity={0}` next to a colour renders that colour opaque. `ToggleControl` already works around this by swapping colours (`classes/environment/ui/settingsWindow.tsx`), and PR #11 had to copy the same workaround into `SegmentedControl`.

## Expected

Remove the dead legacy `backgroundOpacity` and `borderOpacity` props from `submodules/threewebxrwebgpudeno/webgpu-uikit.tsx` (do not vendor back removed uikit 0.x API), update/codemod all call sites to put alpha in the colour, and remove the colour-swap workarounds in `ToggleControl` and `SegmentedControl`.

## Notes / evidence

- Discovered 2026-11-27 while reviewing PR #11 (`markdown/pr11notes.md`).
- Affected wrapper: `submodules/threewebxrwebgpudeno/webgpu-uikit.tsx`.
- Example workaround: `classes/environment/ui/settingsWindow.tsx:258-264`.
