# Coop development: two machines, one trusted link, no CI in the loop

How two people work on PetPlay together with both PetPlays running, and how one agent checks the
whole system end to end across both machines. CI and releases stay out of the inner loop; they come
in when a change has to reach people who are not pairing.

## The pieces

| Need                                                                               | Tool                                                        | Reaches                       |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------- |
| My own PetPlay picks up my edits                                                   | `--watch-webxr` hot reload (stageforge `HotReload`)         | this machine                  |
| The other PetPlay picks up my edits                                                | `deno task peer-patch --watch` (classes/peerPatch.ts)       | trusted peers in the instance |
| Changes a patch cannot carry (imports, exports, top level, the main process, Rust) | push a branch; CI publishes it; both pick it in the updater | anyone following that branch  |
| Is the whole thing working, on both ends?                                          | `deno task coop:verify` (classes/peerProbe.ts)              | this machine + trusted peers  |

## Setting up a pairing

1. Both run PetPlay with Peer Networking on, in the same VRChat instance, and press Trust on each
   other (wrist menu). Trust upgrades the link from the relay-only discovery tier to the direct
   tier, which carries everything below.
2. Both turn on Settings → Install → **Peer Code Patches**. That is the opt-in for both live patches
   and the read-only probes `coop:verify` sends. Turn it off after the session.
3. Start from the same build. Either both run a checkout of the same commit, or both pick the same
   **Update Channel** (Settings → Install, or `petplay --update --channel=<owner>/<repo>#<branch>`).
   `coop:verify` reports a build mismatch as its first warning.

## The loop

On the machine with the checkout (and the agent):

```sh
deno task peer-patch --watch      # every save that type-checks goes to the peer as well
deno task coop:verify             # whenever you want to know whether it works end to end
deno task coop:verify --watch 10  # a soak while both people use the feature
```

`peer-patch` replaces function bodies only. It reports anything structural ("structural", "blocked")
instead of applying it; such a change needs a restart on the other side, which means a build:

- **The peer runs a checkout**: they pull your branch and restart.
- **The peer runs a release**: push the branch. CI (`.github/workflows/branch-build.yml`) builds it
  and publishes the binaries as a prerelease, and the peer installs it from Settings → Install →
  Update Channel → your branch → INSTALL. A delta update downloads only the changed parts of the
  binary, usually a few MB of the ~500 MB.

## What `coop:verify` checks

It asks this machine's `vrcPeers` (through the agent REPL on port 3987) for a probe of itself and of
every trusted peer in the instance, then compares them:

| Check                                 | Pass                                                                  | Warn / fail means                                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| networking, trusted peers in instance | link up, ≥1 trusted peer                                              | Peer Networking off, nobody trusted in this instance                                                                                |
| probe                                 | the peer answered                                                     | the peer has Peer Code Patches off, or runs a build without `PEERPROBE`                                                             |
| same build                            | same commit                                                           | code drift: the versions and channels to line up are named                                                                          |
| link (each side)                      | `direct` path, RTT ≤ 150 ms                                           | `relay`: holepunching failed; the open path candidates are listed for each side. No connection: the trusted upgrade never completed |
| display poses                         | viewer's copy of each shared display within 3 cm / 2° of the sharer's | pose sync is fighting or stale; the distance and the two poses' timestamps are given                                                |
| log errors (each side)                | none recently                                                         | the last error line of that side's log                                                                                              |

Exit code 1 means a check failed, so an agent can gate on it. `--json` prints both probes and all
checks for the agent to dig into.

The link path comes from `petplay-media link`, which logs
`[link] conn N (direct) path: direct via
…` whenever a connection's selected path changes. Since the
direct offer includes the IP candidates (trusted peers only), a relay path with candidates on both
sides points at NAT (CGNAT, symmetric NAT, a firewall blocking UDP), not at PetPlay.

## Contributors' branch builds

Anyone with a fork can make their branch installable for testers:

1. Fork `goodpuppies/petplay` and enable Actions on the fork (GitHub disables workflows on new
   forks: the fork's Actions tab → "I understand my workflows, go ahead and enable them").
2. Push a branch. When CI passes, the fork's Releases get a prerelease `build-<branch>-<sha>` with
   all three binaries, their chunk indexes and `SHA256SUMS`. Older builds of the branch are pruned
   (the newest two stay); deleting the branch deletes its builds.
3. Testers' PetPlays list recently pushed forks' branch builds in Settings → Install → Update
   Channel (or `petplay --update-channels`). A fork that is not a GitHub fork of the main repo can
   be added with the `updateRepos` setting.

A branch build runs that branch's code with the tester's permissions, so pick only channels from
people you trust. Stable never switches by itself, and the background check only notifies.

Submodule changes on a branch need the submodule commit to be reachable from the URL in
`.gitmodules`; push it there (or to a fork and point `.gitmodules` at it on the branch).

## Updater reference

- `petplay --update-channels`, `--update-check [--channel=C]`, `--update [--channel=C] [--yes]`,
  `--update-rollback`; all take `--json`.
- An update is checked against `SHA256SUMS` and GitHub's asset digest, its new binary must answer
  `--version --json` before it is swapped in, and the replaced binary is kept as `petplay.previous`
  (`--update-rollback`).
- Settings → Install → RESTART (shown after an update or rollback) shuts PetPlay down as Ctrl-C
  does and starts the installed build in its place: the logging parent every release run has
  starts it as its next child (same terminal, same SteamVR launch, same log file), so the person
  you pair with presses one button after INSTALL (classes/restart.ts). Builds from before this
  existed still need a manual restart the first time.
- `PETPLAY_GITHUB_TOKEN` raises the GitHub API limit (anonymous checks are cached with ETags and
  rarely hit it).
