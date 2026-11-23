/**
 * Per-window enumeration, focus, and GPU-encoded media capture:
 * - Linux (KDE Plasma 6 Wayland): `screen-streamer --list-windows` / `--focus-window=<uuid>` /
 *   `--window=<uuid>` using `org_kde_plasma_window_management` + `zkde_screencast_unstable_v1`
 *   (no XDG portal dialog), feeding into a dedicated `DesktopMediaFeed` (`petplay-media`).
 * - Windows: `petplay-media capture-wgc --list-windows` / `--focus-window <hwnd>` /
 *   `--window <hwnd>` using `EnumWindows` + `IGraphicsCaptureItemInterop::CreateForWindow`.
 */
import { DesktopMediaFeed } from "../../classes/sceneStreamMedia.ts";
import { captureSessionEnvironment } from "../../classes/ScreenCapturer/captureSessionEnvironment.ts";
import { screenStreamerPath } from "../../classes/ScreenCapturer/screenStreamerPath.ts";
import {
  loadWorkspaceOutputs,
  workspaceOutputsFromKscreen,
} from "../../classes/environment/workspaceDisplays.ts";
import { mediaBinary, wgcMonitors } from "./wgcMediaFeed.ts";

export type WindowRegion = { x: number; y: number; width: number; height: number };

export type WindowInfo = {
  id: string;
  title: string;
  app: string;
  pid: number;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  active: boolean;
  /** Fraction of the virtual desktop, for mapping pointer input to this window. */
  region?: WindowRegion;
};

function linuxWaylandEnv(): Record<string, string> {
  const env = captureSessionEnvironment();
  if (!env.WAYLAND_DISPLAY && !Deno.env.get("WAYLAND_DISPLAY")) {
    const runtime = env.XDG_RUNTIME_DIR ?? Deno.env.get("XDG_RUNTIME_DIR") ??
      `/run/user/${Deno.uid()}`;
    try {
      for (const entry of Deno.readDirSync(runtime)) {
        if (/^wayland-\d+$/.test(entry.name)) {
          env.WAYLAND_DISPLAY = entry.name;
          break;
        }
      }
    } catch {
      // ignore
    }
  }
  return env;
}

function attachRegions(
  windows: WindowInfo[],
  bounds: { left: number; top: number; width: number; height: number } | null,
): WindowInfo[] {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return windows;
  return windows.map((w) => ({
    ...w,
    region: {
      x: (w.x - bounds.left) / bounds.width,
      y: (w.y - bounds.top) / bounds.height,
      width: w.width / bounds.width,
      height: w.height / bounds.height,
    },
  }));
}

async function workspaceBounds(): Promise<
  { left: number; top: number; width: number; height: number } | null
> {
  try {
    if (Deno.build.os === "windows") {
      const monitors = await wgcMonitors();
      if (!monitors.length) return null;
      const left = Math.min(...monitors.map((m) => m.x));
      const top = Math.min(...monitors.map((m) => m.y));
      const right = Math.max(...monitors.map((m) => m.x + m.width));
      const bottom = Math.max(...monitors.map((m) => m.y + m.height));
      return { left, top, width: right - left, height: bottom - top };
    }
    let outputs = await loadWorkspaceOutputs();
    if (!outputs.length && Deno.build.os === "linux") {
      // Retry kscreen-doctor with discovered WAYLAND_DISPLAY if the parent env omitted it.
      const res = await new Deno.Command("kscreen-doctor", {
        args: ["-j"],
        env: linuxWaylandEnv(),
        stdout: "piped",
        stderr: "null",
      }).output();
      if (res.success) {
        outputs = workspaceOutputsFromKscreen(JSON.parse(new TextDecoder().decode(res.stdout)));
      }
    }
    if (!outputs.length) return null;
    const left = Math.min(...outputs.map((o) => o.logicalX));
    const top = Math.min(...outputs.map((o) => o.logicalY));
    const right = Math.max(...outputs.map((o) => o.logicalX + o.logicalWidth));
    const bottom = Math.max(...outputs.map((o) => o.logicalY + o.logicalHeight));
    return { left, top, width: right - left, height: bottom - top };
  } catch {
    return null;
  }
}

/** Enumerate capturable top-level windows on this machine (KDE Wayland or Windows). */
export async function listCapturableWindows(): Promise<WindowInfo[]> {
  if (Deno.build.os === "windows") {
    const { success, stdout, stderr } = await new Deno.Command(mediaBinary(), {
      args: ["capture-wgc", "--list-windows"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!success) {
      throw new Error(new TextDecoder().decode(stderr).trim() || "capture-wgc --list-windows failed");
    }
    const parsed = JSON.parse(new TextDecoder().decode(stdout)) as WindowInfo[];
    return attachRegions(parsed, await workspaceBounds());
  }
  if (Deno.build.os === "linux") {
    const { success, stdout, stderr } = await new Deno.Command(screenStreamerPath(), {
      args: ["--list-windows"],
      env: linuxWaylandEnv(),
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!success) {
      throw new Error(new TextDecoder().decode(stderr).trim() || "screen-streamer --list-windows failed");
    }
    const parsed = JSON.parse(new TextDecoder().decode(stdout)) as WindowInfo[];
    return attachRegions(parsed, await workspaceBounds());
  }
  return [];
}

/** Unminimize and focus a window by id (KWin UUID on KDE, HWND hex on Windows). */
export async function focusCapturableWindow(id: string): Promise<void> {
  if (!id) return;
  if (Deno.build.os === "windows") {
    await new Deno.Command(mediaBinary(), {
      args: ["capture-wgc", "--focus-window", id],
      stdout: "null",
      stderr: "null",
    }).output();
    return;
  }
  if (Deno.build.os === "linux") {
    await new Deno.Command(screenStreamerPath(), {
      args: [`--focus-window=${id}`],
      env: linuxWaylandEnv(),
      stdout: "null",
      stderr: "null",
    }).output();
  }
}

export type WindowFeedOptions = {
  windowId: string;
  host: string;
  port: number;
  fps?: number;
  bitrate?: number;
  share?: boolean;
};

/** One running per-window GPU-encoded media feed (WebTransport + WebRTC + optional iroh). */
export class WindowMediaFeed {
  readonly exited: Promise<void>;

  private constructor(
    readonly info: {
      host: string;
      port: number;
      fingerprint: string;
      code?: string;
      webrtc?: boolean;
    },
    private readonly acceptOfferFn: (sdp: string) => Promise<string>,
    private readonly stopFn: () => Promise<void>,
    exited: Promise<void>,
  ) {
    this.exited = exited;
  }

  acceptWebRtcOffer(sdp: string): Promise<string> {
    return this.acceptOfferFn(sdp);
  }

  stop(): Promise<void> {
    return this.stopFn();
  }

  static async start(options: WindowFeedOptions): Promise<WindowMediaFeed> {
    if (Deno.build.os === "windows") {
      return await WindowMediaFeed.startWindows(options);
    }
    if (Deno.build.os === "linux") {
      return await WindowMediaFeed.startLinux(options);
    }
    throw new Error(`per-window capture is not supported on ${Deno.build.os}`);
  }

  private static async startLinux(options: WindowFeedOptions): Promise<WindowMediaFeed> {
    const encoder = await DesktopMediaFeed.start({
      host: options.host,
      port: options.port,
      fps: options.fps ?? 30,
      bitrate: options.bitrate ?? 8_000_000,
      share: options.share,
    });
    const helper = new Deno.Command(screenStreamerPath(), {
      args: [
        `--window=${options.windowId}`,
        "--no-frame-socket",
        "--no-input",
        `--media-socket=${encoder.socketPath}`,
        `--fps=${options.fps ?? 30}`,
      ],
      env: linuxWaylandEnv(),
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();

    const stop = async () => {
      try {
        helper.kill("SIGTERM");
      } catch { /* exited */ }
      await Promise.race([helper.status, new Promise((r) => setTimeout(r, 1500))]);
      try {
        helper.kill("SIGKILL");
      } catch { /* exited */ }
      await encoder.stop();
    };

    const exited = Promise.race([
      helper.status.then(() => {}),
      encoder.exited.then(() => {}),
    ]).then(stop);

    return new WindowMediaFeed(
      {
        host: options.host,
        port: encoder.info.port,
        fingerprint: encoder.info.fingerprint,
        ...(encoder.info.code ? { code: encoder.info.code } : {}),
        ...(encoder.info.webrtcOfferUrl ? { webrtc: true } : {}),
      },
      (sdp) => encoder.acceptWebRtcOffer(sdp),
      stop,
      exited,
    );
  }

  private static async startWindows(options: WindowFeedOptions): Promise<WindowMediaFeed> {
    const child = new Deno.Command(mediaBinary(), {
      args: [
        "capture-wgc",
        "--window",
        options.windowId,
        `${options.host}:${options.port}`,
        "--iroh-share",
        "--fps",
        String(options.fps ?? 30),
        "--bitrate",
        String(options.bitrate ?? 8_000_000),
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const log: string[] = [];
    const drain = async (stream: ReadableStream<Uint8Array>, onLine: (l: string) => void) => {
      let buf = "";
      try {
        for await (
          const chunk of stream.pipeThrough(
            new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>,
          )
        ) {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            onLine(buf.slice(0, nl));
            buf = buf.slice(nl + 1);
          }
        }
      } catch { /* closed */ }
    };
    const keep = (l: string) => {
      log.push(l);
      if (log.length > 100) log.shift();
    };
    const drained = [drain(child.stderr, keep)];
    try {
      const ready = await new Promise<
        { fingerprint: string; code: string; webrtcOfferUrl?: string }
      >((resolve, reject) => {
        let fingerprint: string | null = null;
        let code: string | null = null;
        let webrtcOfferUrl: string | null = null;
        const timer = setTimeout(
          () => reject(new Error(`capture-wgc --window not ready: ${log.at(-1) ?? "no output"}`)),
          20_000,
        );
        drained.push(drain(child.stdout, (line) => {
          keep(line);
          code ??= line.match(/^IROH_SHARE code=(\S+)/)?.[1] ?? null;
          webrtcOfferUrl ??= line.match(/^WEBRTC_READY (\S+)/)?.[1] ?? null;
          fingerprint ??= line.match(/^MOQ_READY .*fingerprint=([0-9a-f]+)/)?.[1] ?? null;
          if (line.startsWith("MEDIA_SOURCE") && code && fingerprint) {
            clearTimeout(timer);
            resolve({ fingerprint, code, ...(webrtcOfferUrl ? { webrtcOfferUrl } : {}) });
          }
        }));
        child.status.then(async (status) => {
          clearTimeout(timer);
          await Promise.race([Promise.allSettled(drained), new Promise((r) => setTimeout(r, 500))]);
          reject(new Error(`capture-wgc --window exited (${status.code}): ${log.at(-1) ?? ""}`));
        });
      });

      const stop = async () => {
        try {
          child.kill();
        } catch { /* exited */ }
        await Promise.race([child.status, new Promise((r) => setTimeout(r, 1500))]);
      };

      return new WindowMediaFeed(
        {
          host: options.host,
          port: options.port,
          fingerprint: ready.fingerprint,
          code: ready.code,
          ...(ready.webrtcOfferUrl ? { webrtc: true } : {}),
        },
        async (sdp) => {
          if (!ready.webrtcOfferUrl) throw new Error("window feed has no WebRTC endpoint");
          const resp = await fetch(ready.webrtcOfferUrl, {
            method: "POST",
            headers: { "content-type": "application/sdp" },
            body: sdp,
          });
          const text = await resp.text();
          if (!resp.ok) throw new Error(`WebRTC offer rejected (${resp.status}): ${text}`);
          return text;
        },
        stop,
        child.status.then(() => {}),
      );
    } catch (error) {
      try {
        child.kill();
      } catch { /* exited */ }
      throw error;
    }
  }
}
