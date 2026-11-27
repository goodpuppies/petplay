# WebXRRaythreeRenderPayload duplicates identical `leftEye` and `rightEye` extractions

Status: open

## What happens

Raythree scene extraction is completely eye-invariant (`classes/webxrRaythreeScene.ts:91-95` literally sets `const rightEye = leftEye;`), and per-eye view/projection matrices are passed separately to the renderer.

Despite that, `WebXRRaythreeRenderPayload` still exposes both `leftEye` and `rightEye`, forcing every downstream consumer (`classes/overlaySceneWire.ts`, `classes/overlaySceneFingerprint.ts`, `classes/webxrOverlayRaylib.ts`, and PR #11's `planNativeContent`) to branch on both fields and carefully preserve reference aliasing.

## Expected

Collapse `leftEye` and `rightEye` on `WebXRRaythreeRenderPayload` into a single `scene: ExtractionResult` (or `extraction`) field.

## Notes / evidence

- Noted 2026-11-27 while reviewing PR #11 (`markdown/pr11notes.md`).
- Relevant code: `classes/webxrRaythreeScene.ts:47-48`, `classes/webxrRaythreeScene.ts:91-95`.
