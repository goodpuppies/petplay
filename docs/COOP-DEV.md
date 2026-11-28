# Coop development: two machines, one trusted link, no CI in the loop

How two people work on PetPlay together with both PetPlays running, and how one agent checks the
whole system end to end across both machines. CI and releases stay out of the inner loop; they come
in when a change has to reach people who are not pairing.

## The pieces

| Need                                                                               | Tool                                                        | Reaches                       |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------- |
| My own PetPlay picks up my edits                                                   | `--watch-webxr` hot reload (stageforge `HotReload`)         | this machine                  |
| The other PetPlay picks up my edits                                                | `deno task peer-patch --watch` (classes/peerPatch.ts)       | trusted peers in the instance |
| Changes a patch cannot carry (imports, exports, top level, the main process, Rust) | `deno task peer-build --peer NAME` (classes/peerBuild.ts)   | one trusted peer, any OS      |
| Reading the other side: status, log, actors, eval                                  | `deno task peer <name> …` (utils/peer.ts)                   | trusted peers                 |
| A build for people who are not pairing                                             | push a branch; CI publishes it; they pick it in the updater | anyone following that branch  |
| Is the whole thing working, on both ends?                                          | `deno task coop:verify` (classes/peerProbe.ts)              | this machine + trusted peers  |

## Setting up a pairing

1. Both run PetPlay with Peer Networking on, in the same VRChat instance, and press Trust on each
   other (wrist menu). Trust upgrades the link from the relay-only discovery tier to the direct
   tier, which carries everything below.
2. Both turn on Settings → Install → **Peer Code Patches**. That is the opt-in for live patches,
   peer builds, remote eval and the probes `coop:verify` and `deno task peer` send. Turn it off
   after the session.
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
instead of applying it; such a change needs a new build on the other side. That does not need CI:

```sh
deno task peer-build --peer NAME   # build here for the peer's OS, send it, it installs and restarts
```

`peer-build` asks the peer (through the trusted link) which target it runs, compiles PetPlay for
that target here, and sends only the chunks of the executable the peer does not already have (the
same chunking as delta updates). The peer checks the SHA-256, installs it with the one installer
backend (`petplay.previous` kept, so ROLL BACK works) and restarts into it. It needs the peer to run
an installed release-style build (a checkout just pulls and restarts) with Peer Code Patches on.
`--no-restart` installs without restarting; `--binary PATH` sends an existing build.

How much goes over (measured Linux → Windows over the internet, ~2.4 MB/s through the link): the
first peer build to a peer on a CI build of another OS sends ~150 MB of ~490 MB, because the build
machine's own native npm packages are embedded where CI's has the target's. After that the peer runs
your build, and each further one sends only what changed. Same-OS peers start small. Keep Deno at
CI's version (`deno-version` in .github/workflows); `peer-build` warns otherwise, since a different
runtime is another ~100 MB.

The Rust and C helpers inside the build cannot be cross-compiled from every OS. For another target
`peer-build` uses the natives CI built for the same submodule and `native/overlayPresenter` commits
(`natives-<target>.tar.gz` on every branch build, utils/natives.ts). Changing native code for the
other OS therefore means one push of the branch, after which TypeScript iteration on top of it needs
no CI again. Same-OS peers never need CI.

To see the other side without asking the person in VR:

```sh
deno task peer list                       # trusted peers in the instance
deno task peer NAME status                # their probe: build, link, displays, recent errors
deno task peer NAME log --lines 200 --grep link
deno task peer NAME actors                # actors running there
deno task peer NAME eval webxr 'return Object.keys(globalThis).length'
```

These go through this machine's `vrcPeers` (`PEERCALL`, local only) to the peer's, so the peer's
trust check sees a trusted sender. `eval` (`EVALJS` from a peer) runs only while that peer has Peer
Code Patches on; with it off, a trusted peer can still call ordinary actor functions but not run
arbitrary code.

## Testing without VR: peer nodes

`petplay --peer-node=NAME --peer-with=OTHER` runs only PetPlay's coop networking (real iroh, the
real topic server, `vrcPeers`, the remote policy) and the agent REPL: no SteamVR, GPU or window, so
it runs from SSH. VRChat is synthesized: two nodes started with each other's names are in the same
private test instance (`--peer-instance=WORD` picks a fresh one). Its identity, trust store,
settings (Peer Code Patches on) and VRChat log live in `<state dir>/peer-node/NAME`.

```sh
# machine A (checkout)                     # machine B (a release build, e.g. over SSH)
deno run -A petplay/petplay.ts \           petplay --peer-node=b --peer-with=a --peer-instance=t1
  --peer-node=a --peer-with=b --peer-instance=t1 --agent-repl-port=3991
curl -XPOST 127.0.0.1:3991/message -d '{"target":"vrcPeers","type":"TRUST","payload":{"displayName":"b"},"reply":true}'
# …and the same on B with "a"; then every tool above works with --repl-port 3991:
deno task peer --repl-port 3991 b status
deno task peer-build --repl-port 3991 --peer b
```

A compiled node logs and restarts like a release run, so `peer-build` to it installs over the
executable it runs from and the node comes back as the new build. Run B with `LOCALAPPDATA`
(Windows) or `XDG_STATE_HOME` (Linux) pointing at a scratch folder to keep it away from that
machine's real PetPlay.

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

- One installer backend (classes/installer.ts) does every install, update, rollback and uninstall,
  whether it comes from the CLI, the Settings overlay (which runs `petplay … --json` as a child
  process, classes/installerClient.ts) or the prompt a newer download shows when an older build is
  installed. Every operation takes the install directory's lock, stages the new executable, swaps it
  in atomically, keeps the replaced one as `petplay.previous`, records the build actually installed
  and keeps the SteamVR registration current.
- `petplay --install`, `--uninstall`, `--update-channels`, `--update-check [--channel=C]`,
  `--update [--channel=C] [--yes]`, `--update-rollback`; all take `--json`.
- An update is checked against `SHA256SUMS` and GitHub's asset digest, its new binary must answer
  `--version --json` before it is swapped in, and the replaced binary is kept as `petplay.previous`
  (`--update-rollback`).
- Settings → Install → RESTART (shown after an update or rollback) shuts PetPlay down as Ctrl-C does
  and starts the installed build in its place: the logging parent every release run has starts it as
  its next child (same terminal, same SteamVR launch, same log file), so the person you pair with
  presses one button after INSTALL (classes/restart.ts). Builds from before this existed still need
  a manual restart the first time.
- `PETPLAY_GITHUB_TOKEN` raises the GitHub API limit (anonymous checks are cached with ETags and
  rarely hit it).
