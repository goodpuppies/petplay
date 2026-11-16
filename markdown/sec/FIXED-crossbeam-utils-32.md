# markdown/sec/

Security notes: dependency alerts we have triaged, and why. One entry per alert, newest first.
Record what was flagged, how it reaches us, and the decision (fixed, dismissed, accepted), so the
same alert is not re-investigated when it comes back.

## Platform scope

PetPlay targets 64-bit only. 32-bit targets are not supported, so
advisories that only affect 32-bit builds are dismissed.

## Alerts

### Dependabot #1: crossbeam-utils < 0.8.7 (dismissed, 2026-11-16)

- **Advisory:** unsound `AtomicCell<{i,u}64>` arithmetic on 32-bit targets that support
  `Atomic{I,U}64`. Severity high. Patched in 0.8.7.
- **Where:** `native/pathfinderText/Cargo.lock` has `crossbeam-utils 0.7.2`, via
  `pathfinder_renderer` → `crossbeam-channel 0.4.4`. The same version is in
  `markdown/issues/webxr-text-is-hard-to-read/probe.Cargo.lock` (not flagged; not a `Cargo.lock`).
- **Why not updated:** `crossbeam-channel 0.4` requires `crossbeam-utils ^0.7`, and we already pin
  upstream servo/pathfinder's head (`6c3c046`), which still declares `crossbeam-channel = "0.4"`.
  Updating would mean forking pathfinder.
- **Decision:** dismissed. The bug only affects 32-bit targets, and the crate is built only for
  x86_64 Linux (`utils/build-pathfinder-text.ts`). The Pathfinder renderer is an experimental
  comparison renderer kept as research reference, not a shipped path.
- **Lock:** `native/pathfinderText/src/lib.rs` has a `compile_error!` for any target where
  `target_pointer_width != "64"`, so the crate cannot be built 32-bit by accident.
- **Revisit if:** we add a 32-bit target, or Pathfinder becomes a shipped renderer. Dropping the
  `pathfinder_renderer` dependency (keeping Windfoil, which only needs `pathfinder_geometry`)
  also removes it.
