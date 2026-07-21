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

On Wayland, desktop capture and keyboard/pointer injection use the desktop portal. KDE currently
shows separate consent dialogs for screen capture and remote control because the capture and input
sessions are independent; select the same monitor in both. PetPlay forwards its normalized display
pointer and virtual keyboard events to the bundled Linux `screen-streamer` helper.

Stageforge networking and its Iroh worker wrapper are disabled by default, so local actors use
native Deno workers. To connect to the Stageforge signaling server, use `deno task dev:network`,
pass `--stageforge-networking` to a launch, or set `PETPLAY_STAGEFORGE_NETWORKING=1`.
