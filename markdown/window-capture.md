# Per-Window Capture & Sharing (KDE Plasma 6 + Windows)

Status: plan (2026-11-23).

## Goal

Let a user share or view a **single application window** instead of the full desktop — in VR (`displayShare` / overlays), in the browser RDP app, and across household/peer machines — with:

- **No PipeWire / XDG portal popup** on KDE
- **No custom Wayland compositor**
- **GPU-only capture** (works even when the window is occluded by other windows)
- **First-class support for KDE Plasma 6 (Wayland) and Windows** (no crop fallback)

## Platform Backends

### 1. KDE Plasma 6 (Wayland) — `submodules/screen-streamer`

Uses KWin's native Wayland protocols directly via `wayland-client` + `wayland-protocols-plasma`:

- **Window enumeration & focus (`org_kde_plasma_window_management`)**:
  - Lists all windows with `{ uuid, title, app_id, pid, geometry (x, y, w, h), minimized, active }`.
  - Filters out panels, desktops, docks, and skip-taskbar windows (`state & (skip_taskbar | ...)`).
  - Focus/unminimize on click via `org_kde_plasma_window.set_state(active)`.
- **Window capture (`zkde_screencast_unstable_v1`)**:
  - `stream_window(uuid, pointer_mode)` asks KWin for a PipeWire node ID for that exact window with **zero portal dialog**.
  - Feeds the returned PipeWire node ID straight into `screen-streamer`'s existing PipeWire → DMA-BUF → `petplay-media` VA-API pipeline.
  - KWin renders the window even when occluded or on another virtual desktop; `closed` event tears down the stream cleanly when the window closes.
- **One-time KWin permission file**:
  - KWin gates `org_kde_plasma_window_management` and `zkde_screencast_unstable_v1` via `X-KDE-Wayland-Interfaces` in `/usr/share/applications/` (same mechanism Sunshine uses in `/usr/share/applications/dev.lizardbyte.app.Sunshine.kwin.desktop`).
  - Ship `resources/linux/petplay-screen-streamer.kwin.desktop`:
    ```ini
    [Desktop Entry]
    Exec=<path-to-screen-streamer>
    X-KDE-Wayland-Interfaces=org_kde_plasma_window_management,zkde_screencast_unstable_v1
    Type=Application
    Name=PetPlay Screen Streamer KWin Permission
    NoDisplay=true
    ```
  - Surface installation status/instructions in PetPlay's Linux setup (alongside `resources/linux/petplay.rules`).
- **CLI additions to `screen-streamer`**:
  - `--list-windows`: prints JSON array of `WindowInfo` and exits.
  - `--window=<uuid>`: captures that window via `zkde_screencast_unstable_v1` instead of the XDG ScreenCast portal.
  - `--focus-window=<uuid>`: activates/unminimizes that window via `org_kde_plasma_window_management`.

### 2. Windows — `submodules/screen-streamer/capture` + `submodules/petplay_mediatransport`

Extends the existing WGC + D3D11 pipeline (`submodules/screen-streamer/capture/src/windows.rs`, `submodules/petplay_mediatransport/src/wgc_source.rs`):

- **Window enumeration**:
  - `EnumWindows` filtered by `IsWindowVisible`, non-empty title, non-zero size, and `!DWMWA_CLOAKED` (hides suspended UWP / other-virtual-desktop windows, matching XSOverlay's `uWindowCapture`).
  - Reads title (`GetWindowTextW`), process/app name (`QueryFullProcessImageNameW`), minimized state (`IsIconic`), and bounds (`DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` fallback `GetWindowRect`).
- **Capture (`IGraphicsCaptureItemInterop::CreateForWindow`)**:
  - Same `Capture` struct, `Direct3D11CaptureFramePool`, and `GraphicsCaptureSession` already used for `CreateForMonitor(HMONITOR)` — adds `Capture::start_window(device, hwnd, cursor)` calling `CreateForWindow(HWND)`.
  - GPU-only BGRA → NV12 → Media Foundation H.264 → MoQ/WebTransport + WebRTC + iroh.
  - Works when occluded (not when minimized); live window resize recreates the frame pool automatically.
- **CLI additions to `petplay-media capture-wgc`**:
  - `capture-wgc --list-windows`: prints `WGC_WINDOW` lines (or JSON) with `hwnd`, `title`, `app`, `x`, `y`, `width`, `height`, `minimized`, `region`.
  - `capture-wgc --window <hwnd> <host:port> [--iroh-share] [--fps N] [--bitrate N]`: captures that HWND.
- **Focus**: `ShowWindow(hwnd, SW_RESTORE)` (if minimized) + `SetForegroundWindow(hwnd)` on click.

## Unified PetPlay Actor API (`rdp/desktopSource.ts`)

```ts
export type WindowInfo = {
  id: string; // KDE KWin UUID or Windows HWND hex
  title: string;
  app: string;
  width: number;
  height: number;
  minimized: boolean;
  /** Fraction of the virtual desktop, for pointer input mapping. */
  region: { x: number; y: number; width: number; height: number };
};
```

- `LISTWINDOWS` (also in `GUARDED`): returns `WindowInfo[]` for this machine.
- `START { window: string }` (also in `GUARDED`): starts a dedicated `petplay-media` feed for that window (port allocated above monitors/audio, e.g. `port + 200 + slot`), returns `FeedInfo` (with WebTransport, WebRTC, and iroh share code).
- `STOP { window: string }`: stops that window's feed and capture helper.
- `FOCUSWINDOW { window: string }`: activates the window on the host before/on pointer click.
- Automatic cleanup when the captured window closes (helper exits → `desktopSource` drops the window feed instead of restarting it).

## Consumer Integration

1. **RDP browser app (`rdp/ui.tsx`, `rdp/app.tsx`)**:
   - Toolbar picker adds a "Windows" section/dropdown populated from `LISTWINDOWS`.
   - Selecting a window calls `START { window }` and switches the video surface + input region to that window.
2. **VR sharing (`petplay/displayShare.ts` & `WindowLayer`)**:
   - Allows sharing a specific window with VR peers (only that window's pixels leave the machine; pointer input maps into `window.region` and focuses the window on click).

## Implementation Phases

1. **Windows backend**: `windows()` + `Capture::start_window(HWND)` in `petplay-capture`, `--list-windows` / `--window <hwnd>` in `petplay-media capture-wgc`.
2. **KDE backend**: `wayland-client` + `wayland-protocols-plasma` in `screen-streamer` (`--list-windows`, `--window=<uuid>`, `--focus-window=<uuid>`), plus `resources/linux/petplay-screen-streamer.kwin.desktop`.
3. **`desktopSource` actor**: `LISTWINDOWS`, `START { window }`, `STOP { window }`, `FOCUSWINDOW { window }` (both local and `GUARDED` household), clean teardown on window close.
4. **UI & sharing**: window picker in RDP (`rdp/ui.tsx` / `rdp/app.tsx`) and VR sharing (`petplay/displayShare.ts`).
