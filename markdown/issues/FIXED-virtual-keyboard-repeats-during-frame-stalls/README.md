# Virtual keyboard repeats letters during frame stalls

Status: fixed 2026-11-08 (user confirmed)
Track: petplay-2.0 UI/UX

After adding real key holds for Unity fly-camera movement, user reports unexpected repeated
letters, suspected during lag spikes. A stalled scene delays physical key-up, leaving the OS
free to auto-repeat the held letter; wall-clock repeat timers also trusted stale pointer state.

Ordinary typing now injects immediate taps. Right-click navigation retains physical key holds,
chosen at key-down and kept until key-up even if the mouse button is released first. Intentional
text repeat runs after pointer processing in the scene's finish phase, skips frames stalled by
more than 100 ms and never catches up missed repeats.

`desktopKeyboardRouting.test.ts` covers typing during stalled frames, intentional repeats,
press-mode stability and navigation holds. The original `keyHold.test.ts` continues covering
key-up, cancellation and Windows/Linux physical transitions.

User confirmed the input fixes work on 2026-11-08.
