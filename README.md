# A modular overlay augmented reality system

Join the discord! https://discord.gg/Ms24sS9kEa

##### YouTube demo

[![Demo](https://img.youtube.com/vi/2hV8siAFJfI/0.jpg)](https://www.youtube.com/watch?v=2hV8siAFJfI)

Reqs: Npm, Deno, SteamVR, probably windows, optionally vscode

Clone: `git clone -v --recurse-submodules --progress "https://github.com/goodpuppies/petplay.git"`

Setup:

1. `deno run preconf`
2. `deno install`

Usage:

1. `deno run dev`

### Linux / SteamVR

PetPlay discovers the native OpenVR library from `/usr/lib` or SteamVR and uses the bundled raylib
5.5 shared library. Both paths can be overridden when needed:

```bash
PETPLAY_OPENVR_LIBRARY=/path/to/libopenvr_api.so \
PETPLAY_RAYLIB_LIBRARY=/path/to/libraylib.so \
deno task dev
```

Nested WebXR dependencies require their generated checkout artifacts once after cloning:

```bash
(cd submodules/threewebxrwebgpudeno/submodules/iwer && NODE_ENV=development npm install --include=dev --production=false && NODE_ENV=development npm run build)
(cd submodules/threewebxrwebgpudeno/submodules/uikit && pnpm install --filter @pmndrs/uikit... --ignore-scripts && pnpm --filter @pmndrs/uikit generate)
```

With SteamVR running, `deno task openvr:probe` is a lightweight native runtime check.
`deno task dev` starts the full RayThree/WebXR raylib overlay path.

For desktop-only development without SteamVR, run `deno task dev:desktop`. This starts the Raylib
desktop-control window, WebXR scene, wrist menu, VRC camera OSC receiver, and agent REPL. Desktop
capture/display presentation is currently disabled in this mode because it is still backed by an
OpenVR overlay.

On KDE Wayland, select **Full Workspace** in the initial ScreenCast portal dialog. PetPlay requests
persistent capture access and stores the rotating, single-use restore token under
`$XDG_CONFIG_HOME/petplay` (normally `~/.config/petplay`), so later launches restore the workspace
without prompting unless access was revoked or the workspace configuration is no longer valid.
Keyboard and pointer injection use `/dev/uinput` and therefore do not require a remote-control
portal dialog. The capture helper starts with the display actor and remains alive independently of
virtual display creation or visibility. Future virtual display units are crop views into this one
workspace stream rather than separate portal captures.

Stageforge networking and its Iroh worker wrapper are disabled by default, so local actors use
native Deno workers. To connect to the Stageforge signaling server, use `deno task dev:network`,
pass `--stageforge-networking` to a launch, or set `PETPLAY_STAGEFORGE_NETWORKING=1`.

### Overlay performance workflow

`deno task overlay:perf` measures the overlay's per-frame CPU from inside the `webxr` actor through
the agent REPL. It launches a windowless run (`--novr --agent-repl`), drives synthetic controllers
through the production input path (IWER → `@pmndrs/xr` pointers → `@pmndrs/handle` → r3f), and
prints one row per interaction scenario:

```bash
deno task overlay:perf                                  # idle, hover, trigger, drag, sweep, scroll
deno task overlay:perf -- --scenario=hover,drag          # subset; `none` measures without input
deno task overlay:perf -- --seconds=6                    # seconds per scenario
deno task overlay:perf -- --profile                      # + V8 CPU profile of the worker
deno task overlay:perf -- --json                         # machine-readable report
deno task overlay:perf -- --attach --scenario=none --seconds=30   # watch your own running session
```

Use `--attach` against a session you already have open — including a headset run (`deno task dev`),
where `--scenario=none` observes your own hands without installing synthetic input (a live IVRInput
session refuses synthesized controllers outright). `r3f avg` is the r3f `advance()` cost per frame
(`useFrame` jobs + pointer raycasting) as reported by `WebXRHost`, `r3f max` the worst single frame
in the phase, and `ovl fps` appears once the raylib overlay is presenting.

Both halves of the workflow are in `utils/`: `overlay-perf.ts` (launch/attach, REPL transport,
report and profile analysis) and `overlay-perf-harness.ts` (runs inside the `webxr` worker:
synthetic input, scenarios, metric sampling, optional profile capture). The same `--eval` workflow
is available by hand against `http://127.0.0.1:3987`; see `petplay/agentRepl.ts` for the endpoints
and `utils/overlay-perf.ts` for how it drives them. Useful live signals while doing this in VR:
`--webxr-frame-logs` (`[PERF]` / `[FPS]` lines), `--webxr-r3f-job-logs` (per-scheduler-job cost) and
`--webxr-cpu-profile=<path>` (V8 profile written by the `webxr` worker itself).

A perf run never touches your saved spatial layout: launched runs are pointed at
`tmp/overlay-perf-layout.json`, and the harness snapshots and restores the layout file when
scenarios run against a session it did not launch.
