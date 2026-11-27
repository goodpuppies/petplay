# Playtests lack semantic UI query handles in the scene graph

Status: open

## What happens

Because UI roots and controls do not expose semantic test/query handles in the scene graph, playtests have to locate UI elements via ad-hoc `userData` tags (`userData.settingsWindowOverlay`, `userData.raythreeUiText?.text`) and geometric heuristics — for example, `tests/playtest/native-overlays.ts` matches a segmented-control button to its setting row title by comparing world Y coordinates within 2 cm.

## Expected

Expose lightweight semantic identifiers/handles on UI roots and interactive controls so playtests can query and click controls reliably without relying on world-space proximity heuristics.

## Notes / evidence

- Noted 2026-11-27 while reviewing PR #11 (`markdown/pr11notes.md`).
- Relevant code: `tests/playtest/native-overlays.ts:15-45`.
