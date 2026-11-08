# Unity editor ignores overlay wheel

Status: fixed 2026-11-08 (user confirmed)
Track: petplay-2.0 UI/UX

2026-11-08: User reports that PetPlay thumbstick scrolling works generally but fails in Unity's
Project window, Inspector and Hierarchy. The uinput mouse advertises both REL_WHEEL and
REL_WHEEL_HI_RES. Its Xwayland pointer exposes XI2 scroll valuators; this does not by itself prove
which events Unity rejects.

`classes/environment/displayInstance/linuxX11Scroll.ts` adds an optional XTest discrete-wheel
route for X11/Xwayland windows. Native Wayland targets, missing X11 libraries and a desktop
cursor that has not reached the ray target retain uinput scrolling. The route never falls back
to synthetic key presses or changes the focused window. Per-frame scroll accumulation is capped
to 50 ms to avoid catch-up bursts after stalls. Diagnostics count discrete versus uinput scrolls.

Unit tests cover wheel direction, complete clicks and fallback routing. User confirmed on 2026-11-08 that the compatibility path fixes Unity scrolling.
The exact high-resolution event incompatibility remains a hypothesis.
