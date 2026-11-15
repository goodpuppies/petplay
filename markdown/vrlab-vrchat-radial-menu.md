# VRChat radial menu from the synthetic lab: the working workflow

## Saved recovery command (2026-11-07)

Run `deno task vrlab:camera-recover` to reopen Stream mode without restarting VRChat.
It defaults to the **right hand**, waits 3.5 seconds after menu actions, checks camera
mode after each selection, restores the depth layout and requires fresh live GPU decodes.
An already-open camera is preserved, so retrying does not toggle it shut.
After fresh decoding the recovery command returns the camera one metre ahead of the
avatar; `--keep-camera` preserves its position instead. In the desktop debug window,
**Home** performs the same return. **R** only reasserts the existing fly-camera pose.

Close any Quick Menu first. For an already-open radial on Tools use
`deno task vrlab:camera-recover --menu-open --page=tools --hand=right`.
Use `--hand=left` when the radial is on the left, and `--settle-ms=5000` for longer delays.
The command does not infer menu pages from images; its options explicitly describe that state.
If camera opening succeeds but depth calibration fails, it reports that separately and exits 2.
Do not keep toggling menus to fix a decoder failure. The shared `pickActionMenu` helper now
accepts a hand argument; existing callers retain their left-hand default.

CyberLove's colour processing merged the previous 4-bit calibration levels (margin 0).
`deno task vrlab:camera-recover --bits=2 --inset=48` uses the verified alternative:
an exact window capture decoded 512² depth successfully with calibration margin 28.
This increases the block height/payload area; it does not reduce depth-grid resolution.

Reconstructed from the first, working session (2026-10-18, 11:07–11:09 UTC, VRChat log
`output_log_2026-10-18_13-56-13.txt`). Every pose, timing and observation below is from that run.
Nothing here is inferred. Positions are driver (raw tracking) space. The lab's synthetic head is
fixed at (0, 1.6, 0) looking down −Z.

## Tools

- Driver: `SETCONTROLLERPOSE {hand, position, rotation}` and `SETCONTROLLERINPUT {hand, ...}` over
  the lab socket. Today that's `deno task vrlab hand|press|stick` or `SyntheticDriver` in
  `utils/vrlab/driver.ts`. In the original run it was `_scratch/driver.ts`, `_scratch/tap.ts` and
  `_scratch/inputs.ts`.
  - Each `SETCONTROLLERINPUT` is a complete state: controls it leaves out are released.
  - Left `b` is the Touch Y button, VRChat's menu button.
- Eyes: in the original run, an OBS screenshot of the VRChat window source
  (`deno task vrlab obs shot VRChat <path>`). The screenshot is the only check that a menu step
  worked; VRChat logs nothing for menu use.
  - After any VRChat restart, run `deno task vrlab obs setup` first: the window id changes, and a
    stale source returns an all-black image.
  - That window is the wrong long-term source. It shows no SteamVR overlays (so no PetPlay), and
    once the camera is in **Stream** mode it shows the camera feed instead of the eye view.
  - The replacement is what the synthetic headset is actually shown, read back by the driver:
    `deno task vrlab eye [path.png] [--layers]`. It writes both eyes side by side: VRChat's scene
    layer with the compositor's overlay layer (PetPlay, SteamVR UI) merged on top. `--layers`
    also writes each layer on its own. It needs the lab on `--driver-direct`, which `vrlab up`
    starts by default. How it works: `submodules/petplay_ovrdriver/DIRECT-MODE.md`, "Lab
    reader".
  - Right after VRChat starts, frames can still be SteamVR's "Connecting…" loading scene (one
    layer). Wait for the scene layer (640×640 here) before trusting a capture.

## Button semantics (left B / Y)

- **Short tap** (150 ms): toggles the regular Quick Menu on the left hand. Tap again to close it.
- **Long press**: hold ~900 ms, then **release**. The radial (Action) Menu opens **on release**,
  not while the button is held, so a screenshot taken mid-press never shows it.
- The radial menu attaches to a hand. In the first run it had been opened on the **right** hand,
  out of view, before anyone noticed. If nothing shows, check both hands before pressing again,
  since another press toggles.

## The sequence that worked

1. **Close stray menus.** Left B short tap (150 ms) closed the regular menu left open by an
   earlier tap.
2. **Hands.** Right hand out of the way at (0.3, 1.2, −0.3), identity rotation. Left hand at
   (−0.02, 1.58, −0.35), identity rotation.
3. **Open the radial.** Left B held 900 ms, then released. Screenshot ~1 s later: the radial was
   visible, but it was seen from below because of the hand's angle.
4. **Tilt the hand so the menu faces the eye.** Rotation `[0.3827, 0, 0, 0.9239]` (+45° about X,
   `euler(π/4, 0, 0)`) at (−0.02, 1.5, −0.35). The −45° tilt was wrong.
   - Root page: Options, Expressions, Looks, emoji, Items, **Tools** (upper left).
5. **Pick Tools.** Left hand at (−0.06, 1.55, −0.35) with the same tilt, then a timed input
   sequence (each step a complete left-hand state):

   | state                                  | hold   |
   | -------------------------------------- | ------ |
   | `joystick: [-0.8, 0.6]`                | 400 ms |
   | `joystick: [-0.8, 0.6], trigger: 1`    | 200 ms |
   | `joystick: [-0.8, 0.6]`                | 200 ms |
   | `{}` (centred)                         | 800 ms |

   Screenshot (`radial1.png`): the Tools page. It shows Back (top), **Camera** (upper left, struck
   through because it was off), Personal Mirror, Chatbox and Face Mirror.
6. **Pick Camera.** Same pattern, with the stick held through the trigger release:

   | state                                  | hold    |
   | -------------------------------------- | ------- |
   | `joystick: [-0.85, 0.5]`               | 400 ms  |
   | `joystick: [-0.85, 0.5], trigger: 1`   | 200 ms  |
   | `joystick: [-0.85, 0.5]`               | 200 ms  |
   | `{}` (centred)                         | 1200 ms |

   Screenshot (`radial2.png`): the camera screen appeared. OSCQuery `/usercamera/Mode` read 1
   (Photo).
7. **Mode and first pose.** OSC `/usercamera/Mode i 2` (Stream). Then the left hand was nudged to
   (−0.1, 1.5, −0.35), same tilt, and PetPlay's `cameraOrigin` `GETCAMERAPOSE` returned a fresh
   pose. `/usercamera/Pose` is only sent when the camera moves.
8. **Grab.** The right hand worked through the grid z ∈ {−0.35, −0.45, −0.25},
   y ∈ {1.35, 1.25, 1.45} and x ∈ {0.05, −0.05, 0.15}. At each point it gripped, moved +8 cm in x,
   and counted a grab when the OSC pose moved more than 4 cm. The first point grabbed: (0.05, 1.35,
   −0.35) moved the camera 5.6 cm, which leaves the hand at (0.13, 1.35, −0.35).

## The menu is stateful

- The radial reopens on the **page it was last on**, not the root. Seen 2026-10-18 ~14:5x: after a
  failed `camera open`, the next open showed the Tools page.
- The entries at the Tools and Camera stick directions are almost the same direction (upper left).
  So the same pick sequence, started on the wrong page, selects something else. On the Tools page,
  "pick Tools" lands on Camera and toggles it.
- The regular menu, the radial and the camera all toggle, so any extra press inverts the result.
- The left stick is also locomotion. A tilt still held after the menu closes walks the avatar
  away from where the camera spawned. Centre the stick right after the trigger release.
- A VRChat restart (`deno task vrlab vrchat restart`) resets all of this: menus closed, camera
  closed, avatar at spawn. A sequence is only reproducible from a known page, so either restart
  first or confirm the page by screenshot before each pick.

## Where `utils/vrlab/camera.ts` differs from this reference

`openCamera` / `pickActionMenu` (as of this note) depart from the working run in ways that were
never verified:

- Pick timing is 300 / 150 / 60 ms and an 800 ms wait after Camera. The reference is
  400 / 200 / 200 ms, then 800 ms after Tools and 1200 ms after Camera.
- It sends `/usercamera/Close` first. The working run did not.
- It goes straight from the long press into the picks, with the hand at the pick pose
  (−0.06, 1.55, −0.35). It never checks that the radial opened, or on which page.
- It treats any new `/usercamera/Pose` as proof the camera opened. A stale pose from an earlier
  session has satisfied that. The reliable check is the screenshot, or Mode plus a pose that
  follows a hand nudge.

## Open question (2026-10-18 afternoon)

After `vrlab vrchat restart`, the 900 ms long press repeatedly showed no radial on the left hand
in view. One press of B (300 ms) together with grip, made with the hand at the step-7 nudge pose,
did show it, on the Tools page. Not yet explained. Candidates: the radial was opened earlier on
the other hand or off-screen and later presses toggled it, or the hand pose had the menu outside
the view. Check by screenshot, one press at a time, starting from a fresh restart.

## SteamVR dashboard

The SteamVR dashboard sometimes opens by itself mid-run; the cause is not known yet. While it is
open it has the controllers: VRChat stops following the hands, so a held camera stays put (one
check run missed its aim by 979 mm). It shows in `vrlab eye` as the VRChat card with "Resume
Game".

- `deno task vrlab dashboard [status|open|close|toggle]` reads `IVROverlay::IsDashboardVisible`
  through a background OpenVR client, and toggles with the **left** controller's `system`
  button. The right one does nothing. A 150 ms press is enough, and the state flips 0.1–0.3 s
  after the release, so a capture taken right after a press can still show the old state.
- `vrlab:camera-check` closes it before the Action Menu, the grab, the calibration sweep and the
  aim, and logs `closed an unexpected SteamVR dashboard before …` when it had to. Those lines
  and the per-step captures in the run directory are the evidence for finding the trigger.
