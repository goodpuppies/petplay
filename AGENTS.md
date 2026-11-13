# AGENTS.md

- `docs/`: settled docs, starting with `docs/ARCHITECTURE.md`.
- Submodules follow this root `AGENTS.md` and do not require a separate copy.
- `submodules/petplay_mediatransport/`: native media ingestion, encoding, MoQ/Iroh transport,
  and the browser receiver; start with its `README.md`.
- `markdown/`: plans and work in progress. Start with `markdown/what-petplay-is.md` and
  `markdown/petplay-2.0/README.md`.
- `markdown/issues/`: the bug tracker, one folder per issue (see its README).
- Use `_scratch/` for agent scratch files, experiments and local test artifacts. Do not use the
  repo-local `tmp/` for agent work: PetPlay manages it programmatically and may clobber its contents.
  Leave PetPlay's runtime files there.
- Do not put time limits or automatic expiry on experiments unless the user explicitly asks.
  Leave experimental sessions running until asked to stop; retain explicit stop and cleanup paths.
- Assume the developer is in VR using a live PetPlay while you work, usually launched by SteamVR
  with `--watch-webxr` so every save hot-reloads the `webxr` actor. Keep it running: crashes
  happen during development, but avoid causing them. Apply each change in one step (all files of
  a cross-file edit in one write; importers first, removed exports last) so a reload never sees a
  half-done edit. If it does go down, read `logs/petplay-<start time>.log` for why and restart it detached, the way SteamVR does:
  `STEAMVR_APPKEY=petplay.overlay setsid -f ~/.local/share/petplay/steamvr/launch-petplay.sh`
  (its launch log is `~/.local/state/petplay/steamvr-launch.log`).
- Type-check with `deno task check`: it filters out the vendor submodules' unrelated errors that
  raw `deno check` reports (`deno task check:all` for the unfiltered graph).

## Git

Manage git however you see fit. Work on `main`.

- Commit as the configured git identity. No `Co-Authored-By` or other co-author trailers.
- End every agent-made commit message with:

  ```
  Agent: <harness> <version>; model <exact model id>; thread <harness thread/session id>
  ```

  For example, `Agent: Claude Code 2.1.296; model claude-opus-5-5; thread 941be8c7-aca1-4664-b284-7cc0eed69e21`.
