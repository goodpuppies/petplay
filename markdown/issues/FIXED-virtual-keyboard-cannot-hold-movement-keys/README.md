# Virtual keyboard cannot hold movement keys

Status: fixed 2026-11-08 (user confirmed)
Track: petplay-2.0 UI/UX

Holding a virtual WASD key while holding right-click in Unity's Scene view did not move the
fly camera. Keyboard sinks emitted an immediate down/up pair for every activation, including
repeats, so Unity never received a sustained key hold.

User confirmed on 2026-11-08 that Unity fly-camera movement works after the fix.

Keycaps now emit separate down, repeat-down and up transitions. Pointer release, pointer exit,
cancellation and unmount release the key; multiple pointers on one cap share one hold. Linux
uinput and Windows SendInput preserve these transitions. Older activation-only callers (including
keyboard gaps) retain tap behavior. One-shot modifiers release after the held key is released.

`classes/environment/keyboard/keyHold.test.ts` covers held and simultaneous movement keys,
multiple pointers, cleanup, Linux command routing and Windows scan flags. The isolated `keyboard` playtest also passed all 15 steps (shortcuts, sticky modifiers,
Finnish typing and layout interactions). A subsequent repeated-letter regression is recorded in
`../FIXED-virtual-keyboard-repeats-during-frame-stalls/README.md`: ordinary typing uses taps,
while right-click navigation preserves real key holds.
