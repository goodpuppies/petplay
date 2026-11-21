# A remote desktop's stream freezes in Firefox on Linux until the screen changes again

Status: open (low priority)
Track: rdp

## What happens

In the rdp page (`rdp/`), cachyos's GNOME desktop (offered by the household agent,
`rdp/agent.ts`) sometimes stops updating in Firefox on Linux: the view holds an old picture
until something else changes on that screen, typically a mouse move. The local KDE desktop in
the same page does not do it.

## Expected

Each change on the remote screen shows within a frame or two, whether or not more follow.

## Notes / evidence

- GNOME's screencast sends frames only on change; KWin here sends a steady 30 fps. A decoder
  that holds back its newest picture or two until more input arrives is invisible on a steady
  stream and shows exactly this on a damage-only one.
- Ruled out, 2026-11-20: the encoder (`petplay-media`, VA-API iHD on Broadwell) returns each
  frame synchronously, and frames reach a subscriber at once (a MoQ probe from this PC). The
  SPS says `max_num_reorder_frames=0`, `max_dec_frame_buffering=1` (parsed from the live
  stream), so a conforming decoder should not hold frames.
- Mitigation in place: `screen-streamer` repeats the last frame up to 4 times, a frame
  interval apart, once the screen goes still (`submodules/screen-streamer/src/main.rs`,
  `IDLE_REPEATS`). That made it "decent enough"; Firefox still freezes at times.
- Not yet tried: the same stream in Chromium; Firefox with `?software` (software decode);
  whether the browser receiver's stats show `received` ahead of `decoded` during a freeze
  (`submodules/petplay_mediatransport/web/src/receiver.ts`); more or slower repeats.
