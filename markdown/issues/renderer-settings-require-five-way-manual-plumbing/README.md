# Renderer settings require five-way manual plumbing between `webxr` and `overlayRenderOwner`

Status: open

## What happens

Adding a single renderer-facing setting (such as `overlayPresentMode` or `nativeStereoSizing`) requires touching five separate places:
1. `SETTINGS_SCHEMA` in `classes/settings.ts`
2. A mirrored field on `webxr`'s `actorState` (`petplay/webxr.ts:340-346`)
3. Initial forwarding in `STARTOVERLAYRENDERER` (`petplay/webxr.ts:3130-3145`)
4. Manual diffing in `subscribeSettings()` sending bespoke PostMan messages (`SETPRESENTMODE`, `SETNATIVEPANELS`, `SETRENDERERDEBUG`, `petplay/webxr.ts:3160-3195`)
5. Duplicate handling in `petplay/overlayRenderOwner.ts` (both on start and in separate message handlers).

## Expected

Send `overlayRenderOwner` one validated renderer-settings slice (or let it subscribe to settings directly), and have it report the active mode and any fallback reason cleanly in its status.

## Notes / evidence

- Noted 2026-11-27 while reviewing PR #11 (`markdown/pr11notes.md`).
- Relevant code: `classes/settings.ts`, `petplay/webxr.ts:340-346`, `petplay/webxr.ts:3130-3195`, `petplay/overlayRenderOwner.ts`.
