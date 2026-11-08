# Keyboard input waits for capture before reaching the OS

Status: fixed 2026-11-08 (user confirmed)
Track: petplay-2.0 UI/UX

2026-11-08: User notices a delay between the virtual key animation and the typed letter.
The Linux screen-streamer reader queued stdin controls for its main capture loop, which only
forwarded them to uinput before the next captured frame. The live helper is configured for
30 fps; capture waits and socket backpressure could delay input independently of key feedback.

The stdin reader now forwards directly to the dedicated uinput thread. Native tests verify
ordered control delivery while the input stream remains open without any capture consumer.
Typing tap down/up commands share one actor message and pipe write. Keyboard dispatch now
precedes synchronous sound playback. Frame-stall repeat safeguards and right-click navigation
holds remain in place.

The native host build and its five tests pass; eleven keyboard routing tests and `deno task
check` pass. Input delivery is no longer gated by capture, but capture/presentation latency
still exists and the full key-animation-to-visible-letter delay has not been measured.

The rebuilt helper and scene were loaded into the running session; the user confirmed the
latency improvement on 2026-11-08.
