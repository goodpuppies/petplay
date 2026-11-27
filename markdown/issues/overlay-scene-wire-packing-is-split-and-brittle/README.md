# Overlay scene wire packing is split and silently falls back to plain objects

Status: open

## What happens

In `classes/overlaySceneWire.ts`, `panels` and `texts` use hand-rolled typed-array packing (`packedPanels`, `packedTexts`) to avoid `structuredClone` overhead, with a silent fallback to unpacked JS object arrays if any item's matrix doesn't match and an `extraAnchors` side-table for two-handed grabs (`ra.pair`). Meanwhile `images` (and new UI fields like `nativePanels`) bypass packing altogether and travel as plain JS object arrays.

## Expected

Use one consistent, clean wire serialization strategy across all UI payload collections without silent fallbacks or special-case side tables.

## Notes / evidence

- Noted 2026-11-27 while reviewing PR #11 (`markdown/pr11notes.md`).
- Relevant code: `classes/overlaySceneWire.ts:73-295`.
