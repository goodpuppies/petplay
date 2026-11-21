# One of each: PetPlay's desktop path and rdp as the same parts

Status: plan, 2026-11-20. Research notes on the current code, then the target and the order.
Related: `README.md` (rdp actors), `peers.md` (other machines, other users).

The aim is one implementation of each job, shared by the VR desktop, the browser rdp app and
desktops on other machines. Platforms are separate modules behind one actor API (Linux and
Windows input, capture, decode). Different jobs stay separate actors.

## Current state (verified in code)

### Capture

- `petplay/displayOverlayHost.ts` (1311 lines) owns capture through `ScreenCapturer`
  (`classes/ScreenCapturer/scclass.ts`). The helper is `screen-streamer`, connecting to a TCP
  receiver in the actor. The capture backend delivers CPU pixels, and the RGBA frames are
  uploaded to the actor's GL texture (`glManager.createTextureFromData`). The same actor also
  owns the OpenVR overlays, cursor compositing and, through the helper's stdin, input.
- The helper already feeds two consumers at once: the TCP frame socket for the overlay, and
  `--media-socket` for the encoder (one copy into a GBM DMA-BUF). The scene stream turns that on
  with `SETDESKTOPMEDIASOCKET`.
- `rdp/desktopSource.ts` runs a second helper (`--no-frame-socket --no-input --media-socket`) with
  its own portal restore token. Both running means two captures of one desktop.
- Monitor layout comes from the display graph's side: `classes/environment/workspaceDisplays.ts`
  reads `kscreen-doctor` (KDE) or the Windows monitor list, and turns each monitor into a crop
  of the one stitched capture. GNOME (cachyos) has no provider, so it is one full-workspace
  output.

### Input

- The VR scene already sends typed events to swappable sinks: `DisplayMouseSink` (move, button,
  wheel, all with a 0..1 position) and `KeyboardSink` (`KeyboardLogicEvent`: scan hex, virtual
  key name, char, modifier latches).
- Linux (`classes/environment/scene.tsx`): `createLinuxMouseSink` smooths the ray and sends the
  strings `M`, `B`, `W` as `INPUTCONTROL` to displayOverlayHost, which writes them to the
  capture helper's stdin (uinput). `C,x,y`, the cursor position used for compositing, travels in
  the same stream. Wheel first tries a discrete X11 wheel (`linuxX11Scroll.ts`, libX11 in the
  webxr worker). Keyboard: `createLinuxKeyboardSink` maps to `K,<scan>,<0|1>`.
- Windows: `SendInput` straight from the webxr worker (`displayInstance/mouse.ts`,
  `keyboard/win32SystemKeyboard.ts`).
- `rdp/desktopInput.ts`: `InputEvent` (`pointer`, `button`, `wheel` in notches, `key` scan +
  down). `screen-streamer --input-only`, which creates the same uinput devices ("PetPlay Mouse",
  "PetPlay Keyboard") as the capture helper. Linux only. Releases held keys and buttons when a
  client goes away.

### Showing a desktop in VR

- The display graph is already modular for pixels. Each display is a `WorkspaceOutput` with
  an `overlayHostActor`, and a display instance sends `SYNCVIRTUALDISPLAY` to that actor
  (`displayInstance/logic.tsx`). displayOverlayHost and `petplay/remoteMediaOverlay.ts` both
  answer it.
- Remote feeds are found by `INSPECT` for local `remoteMedia@` actors
  (`classes/environment/remoteDisplayFeeds.ts`) and get `input: "none"`. Only one exists, started
  by a command with a share code or an iroh URL.
- `remoteMediaOverlay` runs as its own process. It decodes natively (Linux VA-API → DMA-BUF →
  `GpuMediaSocket` → `EglMediaTexture`; Windows D3D11 in `remoteMediaWindows.ts`) and owns its
  own overlay (`RemoteDisplayBinding`). The separate process matters: a second GL context in one
  process destroys raylib's textures (the black-eye bug).

### Feeds and scene serving

- Four descriptor shapes for one idea: desktopSource `{host, port, fingerprint}`,
  sceneStreamMedia `{port, fingerprint, width, height}`, the viewer's `{port, fingerprint, host?}`,
  remoteMedia `{code | url + address}`.
- `DesktopMediaFeed` (the encoder supervisor) is already shared by the scene stream and
  desktopSource.
- Two scene servers: `classes/sceneStreamServer.ts` (a WebSocket and HTTP in the webxr worker,
  pointer plus camera input, no access control) and the rdp UI actor (Transport, `SceneFeed`,
  DOM events, secret). `SceneFeed` copies the scene stream's latest-since-ack logic.

## Target

| Job | One owner | Per platform |
| --- | --- | --- |
| Capture + monitor layout | `desktopSource` | capture backend (in the helper); layout (KDE, GNOME, Windows) |
| Encode | `DesktopMediaFeed` inside desktopSource | encoder (VA-API; Windows `capture-tcp`) |
| Inject input | `desktopInput` | Linux (uinput helper, X11 wheel), Windows (`SendInput`) |
| Decode a remote feed | a feed receiver (today's remoteMediaOverlay decode) | VA-API / D3D11 |
| Show a desktop in VR | the display graph; overlay hosts per process (GL isolation) | none |
| Serve a scene | `SceneFeed` + Transport (the UI actor's) | none |
| Find, authorize | topics + node-bound proofs (`peers.md`) | none |

A VR display is then a `WorkspaceOutput` naming three actors: whose pixels (`overlayHostActor`),
whose input (`inputActor`, a desktopInput anywhere), and the source it came from. Local and
remote desktops differ only in those ids.

## Order

The pattern throughout: the actor is the high level (messages, validation, lifecycle), with a
class per job, and a class per platform where platforms differ (as `desktopInput` does:
`LinuxDesktopInput`, `WindowsDesktopInput`).

Each step leaves the VR desktop working. displayOverlayHost runs in the live session, so changes
there are tested in a novr server first (`petplay-test-server-isolation`) and land in one step.

1. **Input through desktopInput.** (Done 2026-11-20: the actor and its platform classes
   in `rdp/classes/input/`, the scene's sink in `classes/environment/desktopInputSink.ts`; main
   spawns it. The capture helper runs with `--no-input`; the overlay host only takes cursor
   positions.)
   - Widen `InputEvent` to what the scene sends: key taps, modifier latches as scan keys, wheel
     in the scene's units.
   - Give desktopInput platform backends: the Linux helper plus the X11 discrete wheel (moved
     out of the webxr worker), and Windows `SendInput` (moved from the scene).
   - The scene's sinks become one sink posting `InputEvent`s to a desktopInput: over
     `rdp.input` (messageport) in one process, as actor messages across machines.
   - The capture helper runs with `--no-input`. `C,x,y` stays a display message to
     displayOverlayHost, for the cursor.
   - Smoothing and key repeat stay in the scene: they describe the VR pointer and keyboard, not
     the desktop.
2. **One capture.** (Capture done 2026-11-20: `desktopSource` runs the only helper
   (`CaptureHelper`) for a frame sink, its own encoder or the scene stream's; the overlay host
   keeps a `FrameReceiver` and relays capture status as toasts; `ScreenCapturer` is now the two
   classes composed. `LAYOUT` answers with the monitors; GNOME is hardcoded to cachyos's single
   1366x768 panel until Mutter's `DisplayConfig` is parsed. The VR scene still reads its own.)
   - desktopSource owns the machine's only helper and portal token. It delivers frames to the
     overlay host's existing TCP receiver (a frame-sink port it is given) and to the encoder when
     anyone wants a feed.
   - displayOverlayHost keeps its receiver, GL and overlays and loses process supervision.
   - Monitor layout moves to desktopSource (`LAYOUT`), with a GNOME provider (Mutter
     `DisplayConfig` over D-Bus).
3. **One feed descriptor.**
   - `{kind: "webtransport", host, port, fingerprint} | {kind: "iroh", ...}`, from desktopSource
     on request.
   - The scene stream, the rdp tab and the feed receiver all take it. Share codes become an
     iroh descriptor sent over the actor route.
4. **Remote desktops as displays.** (Done 2026-11-21 for household desktops: they are display
   outputs from `householdDesktops`, fed by `remoteMediaOverlay` from desktopSource's feed;
   `WorkspaceOutput.inputActor` routes a display's mouse, and the keyboard follows the display
   clicked last. One output per machine, the whole capture: a remote machine's monitors as
   separate outputs (its `LAYOUT`) is still open. The Windows receiver takes share codes only.)
   - The feed receiver starts per desktopSource found on a topic.
   - `WorkspaceOutput` gets `inputActor` instead of `input: "none"`, and display instances
     route mouse and keyboard to it.
   - Discovery covers topic contacts as well as local actors.
5. **One overlay host.**
   - displayOverlayHost and remoteMediaOverlay become one actor, run once per source, each
     instance in its own process (one GL context per process). The actor is the high level:
     messages, lifecycle, health. Underneath it, a class per job:
     - frame input: `CpuFrameInput` (RGBA over the helper's TCP socket), `DmabufFrameInput`
       (`GpuMediaSocket` + `EglMediaTexture`), `D3d11FrameInput` (Windows shared texture);
     - `OverlaySet`: one OpenVR overlay per virtual display, cropping the shared texture, placed
       by `SYNCVIRTUALDISPLAY` (today's two copies: displayOverlayHost's entries and
       `RemoteDisplayBinding`);
     - `CursorCompositor`, on wherever pointer positions arrive.
   - A local desktop is one instance fed by desktopSource, a remote one an instance fed by a
     receiver. Remote desktops gain the cursor and several virtual displays from one feed.
6. **One scene server** (later). The scene stream becomes a `SceneFeed` behind a Transport, with
   topics and the secret. Its pointer-plus-camera input stays a different input kind from the
   rdp tab's DOM events, since VR views and 2D tabs need both.

Later, separately: hand the overlay host DMA-BUF frames instead of CPU RGBA, through the same
import path remote feeds use (`EglMediaTexture`). That makes local and remote pixels identical
inside PetPlay, but it touches the GL hazards above, so it gets its own step.

## Open

- Step 2 restarts the helper whenever its consumers change (frame sink on or off). The helper
  takes its outputs as flags, so either it learns to add and drop outputs at runtime, or a
  restart is acceptable. Portal restore makes a restart quiet.
- Windows capture already stitches monitors and feeds the overlay the same way. Its media path
  (`capture-tcp`) needs checking before step 2 claims it.
- The X11 wheel needs `DISPLAY` and runs per process. In desktopInput it moves to whichever
  process injects, which is the right one.
