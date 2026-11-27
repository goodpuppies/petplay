# Remote Windows Rendering & Verification Guide

PetPlay's decoupled renderer (`petplay/overlayRenderOwner.ts`) runs as an independent Stageforge
actor with its own OpenVR + OpenGL/DXGI context. Because the scene→renderer boundary is pure actor
messages, you can keep `pp dev` (or `vrlab`) running on Linux while streaming live scenes over a
direct Iroh P2P link to a remote Windows machine running SteamVR.

## Prerequisites

1. **Matching Deno version** on both machines (so `node:v8` `serialize`/`deserialize` in
   `classes/overlaySceneWire.ts` matches cleanly).
2. **SSH access** to the Windows host (`<win-user>@<win-host>`), with the PetPlay renderer source
   tree synced to `<remote-dir>` (e.g. `~/petplay-remote-renderer`) and `deno install` completed.
3. **Windows `petplay-media.exe`** built with `--features iroh` (passed via `--link-binary` or
   `PETPLAY_LINK_BINARY`).
4. **Windows `resources/petplay_overlay_presenter.dll`** (cross-compiled from Linux with Zig via
   `native/overlayPresenter/`).
5. **SteamVR running in Console Session 1** on the Windows host (with `driver_null` enabled in
   `steamvr.vrsettings` when testing without a physical headset attached).

> **Why Console Session 1 matters:** Processes launched directly from an SSH shell run in Session 0
> (or a non-interactive logon) and cannot reliably access SteamVR IPC or hardware WGL/DXGI
> interop. Always pass `--windows-session` so `utils/remote-renderer-attach.ts` launches
> `utils/remote-overlay-renderer.ts` inside the interactive desktop session via Windows Task
> Scheduler (`schtasks`).

## Attaching a Remote Windows Renderer

With PetPlay running locally with `--agent-repl` (e.g. `deno task server` or
`deno task vrlab up --no-vrchat`):

```sh
deno run -A utils/remote-renderer-attach.ts \
  --ssh=<win-user>@<win-host> \
  --remote-dir=<remote-dir> \
  --windows-session \
  --link-binary=<remote-dir>/petplay-media.exe \
  --mode=native \
  --banks=3
```

What `remote-renderer-attach.ts` does automatically:
1. Queries the local `agentRepl` for `webxr`'s actor ID and direct Iroh endpoint (enabling
   Stageforge networking if off).
2. Launches `utils/remote-overlay-renderer.ts` inside Console Session 1 on the Windows host.
3. Exchanges the direct Iroh endpoint via handshake file, allowlists the Windows peer locally, and
   connects directly over Iroh P2P.
4. Starts `petplay/overlayRenderOwner.ts` on Windows in the requested `--mode` (`panorama`,
   `projection`, or `native`) and `--banks` (`3` = DXGI 3-bank visibility flip, `0` = legacy GL)
   and streams live heartbeat stats back to your terminal.

## Checking Native Overlay Health Remotely

Pass `--remote-repl-port=3989` to expose an `agentRepl` on the Windows renderer, or watch the
heartbeat log lines (`publishedFrames`, `transport`, `native`, `nativeError`).

- Look for `transport: "shared"` in `native` status to confirm `TextureType_DXGISharedHandle`
  (`dxgi_banks.zig`) is active rather than `TextureType_OpenGL`.
- Look for `sizeMismatches: 0` and `nativeError: null` when resizing or opening/closing UI panels.

## Standalone Release Self-Test on Windows

To verify a packaged `petplay.exe` release artifact on the Windows host (in Console Session 1):

```powershell
petplay.exe --test --require-vr
```

This checks actor boot, WebXR/OpenVR attachment, decoupled renderer presentation, and desktop
capture end to end.
