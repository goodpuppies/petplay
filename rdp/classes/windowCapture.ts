/**
 * Per-window enumeration, focus, and GPU-encoded media capture:
 * - Linux (KDE Plasma 6 Wayland): `screen-streamer --list-windows` / `--focus-window=<uuid>` /
 *   `--window=<uuid>` using `org_kde_plasma_window_management` + `zkde_screencast_unstable_v1`
 *   (no XDG portal dialog), feeding into a dedicated `DesktopMediaFeed` (`petplay-media`).
 * - Windows: `petplay-media capture-wgc --list-windows` / `--focus-window <hwnd>` /
 *   `--window <hwnd>` using `EnumWindows` + `IGraphicsCaptureItemInterop::CreateForWindow`.
 */
import { DesktopMediaFeed } from "../../classes/sceneStreamMedia.ts";
import { petplayMediaPath } from "../../classes/petplayMediaPath.ts";
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

/** Resize a window on KDE Plasma 6 Wayland via KWin's DBus Scripting API. */
export async function resizeCapturableWindow(
  id: string,
  width: number,
  height: number,
): Promise<void> {
  if (!id || !Number.isFinite(width) || !Number.isFinite(height)) return;
  // Round to even dimensions so VA-API H.264 (`width % 2 == 0 && height % 2 == 0`) accepts them.
  const w = Math.max(160, Math.round(width / 2) * 2);
  const h = Math.max(120, Math.round(height / 2) * 2);
  if (Deno.build.os !== "linux") return;

  const env = linuxWaylandEnv();
  const scriptName = `pp-resize-${crypto.randomUUID().slice(0, 8)}`;
  const scriptPath = await Deno.makeTempFile({ prefix: "pp-kwin-resize-", suffix: ".js" });
  const js = `
const target = ${JSON.stringify(id)}.replace(/^\\{|\\}$/g, "");
for (const win of workspace.windowList()) {
  const wid = String(win.internalId || "").replace(/^\\{|\\}$/g, "");
  if (wid === target) {
    const g = win.frameGeometry;
    win.frameGeometry = { x: g.x, y: g.y, width: ${w}, height: ${h} };
    break;
  }
}
`;
  try {
    await Deno.writeTextFile(scriptPath, js);
    const load = await new Deno.Command("qdbus6", {
      args: ["org.kde.KWin", "/Scripting", "loadScript", scriptPath, scriptName],
      env,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!load.success) return;
    const scriptId = new TextDecoder().decode(load.stdout).trim();
    if (!/^\d+$/.test(scriptId)) return;
    await new Deno.Command("qdbus6", {
      args: ["org.kde.KWin", `/Scripting/Script${scriptId}`, "run"],
      env,
      stdout: "null",
      stderr: "null",
    }).output();
    await new Deno.Command("qdbus6", {
      args: ["org.kde.KWin", "/Scripting", "unloadScript", scriptName],
      env,
      stdout: "null",
      stderr: "null",
    }).output();
  } catch {
    // Best-effort: non-KDE environments simply skip host window resize.
  } finally {
    await Deno.remove(scriptPath).catch(() => {});
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
          if (!resp.ok) throw new Error(`WebRTC offer rejected (${responseStatus(resp)}): ${text}`);
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

function responseStatus(r: Response): number {
  return r.status;
}

export type AtlasSlotLayout = {
  srcW: number;
  srcH: number;
  crop: { x: number; y: number; width: number; height: number };
};

export type AtlasLayoutEvent = {
  width: number;
  height: number;
  slots: Record<string, AtlasSlotLayout>;
};

/**
 * Per-machine Linux GPU Atlas (`petplay-media atlas`): composites all captured windows on this
 * machine into ONE VA-API NV12 surface and ONE H.264 WebRTC/WebTransport stream.
 * Resizing a window updates its `crop` and `srcSize` live with zero encoder or WebRTC restart.
 */
export class WindowAtlas {
  readonly streamId: string;
  readonly host: string;
  readonly port: number;
  readonly fingerprint: string;
  readonly webrtc: boolean;
  private readonly webrtcOfferUrl: string | null;
  private readonly child: Deno.ChildProcess;
  private readonly stdinWriter: WritableStreamDefaultWriter<Uint8Array>;
  private readonly encoder = new TextEncoder();
  private readonly dir: string;
  private readonly helpers = new Map<string, Deno.ChildProcess>();
  private readonly slots = new Map<string, AtlasSlotLayout>();
  private slotSeq = 0;
  private stopped = false;
  onLayout: ((layout: AtlasLayoutEvent) => void) | null = null;
  onWindowExited: ((windowId: string) => void) | null = null;

  private constructor(
    args: {
      streamId: string;
      host: string;
      port: number;
      fingerprint: string;
      webrtcOfferUrl: string | null;
      child: Deno.ChildProcess;
      dir: string;
    },
  ) {
    this.streamId = args.streamId;
    this.host = args.host;
    this.port = args.port;
    this.fingerprint = args.fingerprint;
    this.webrtcOfferUrl = args.webrtcOfferUrl;
    this.webrtc = Boolean(args.webrtcOfferUrl);
    this.child = args.child;
    this.stdinWriter = args.child.stdin.getWriter();
    this.dir = args.dir;
  }

  static async start(options: {
    host: string;
    port: number;
    width?: number;
    height?: number;
    fps?: number;
    bitrate?: number;
  }): Promise<WindowAtlas> {
    const dir = await Deno.makeTempDir({
      dir: Deno.env.get("XDG_RUNTIME_DIR") ?? `/run/user/${Deno.uid()}`,
      prefix: "pp-win-atlas-",
    });
    const child = new Deno.Command(petplayMediaPath(), {
      args: [
        "atlas",
        `${options.host}:${options.port}`,
        "--width",
        String(options.width ?? 2560),
        "--height",
        String(options.height ?? 1440),
        "--fps",
        String(options.fps ?? 30),
        "--bitrate",
        String(options.bitrate ?? 12_000_000),
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    const log: string[] = [];
    const keep = (l: string) => {
      log.push(l);
      if (log.length > 100) log.shift();
    };
    const drain = async (stream: ReadableStream<Uint8Array>, onLine: (l: string) => void) => {
      let buf = "";
      try {
        for await (
          const chunk of stream.pipeThrough(
            new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>,
          )
        ) {
          buf += chunk;
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            onLine(buf.slice(0, nl));
            buf = buf.slice(nl + 1);
          }
        }
      } catch { /* closed */ }
    };
    void drain(child.stderr, keep);

    let atlasRef: WindowAtlas | null = null;
    const ready = await new Promise<{ fingerprint: string; webrtcOfferUrl: string | null }>(
      (resolve, reject) => {
        let fingerprint: string | null = null;
        let webrtcOfferUrl: string | null = null;
        const timer = setTimeout(
          () => reject(new Error(`petplay-media atlas not ready: ${log.at(-1) ?? "no output"}`)),
          10_000,
        );
        void drain(child.stdout, (line) => {
          keep(line);
          if (line.startsWith("ATLAS_LAYOUT ")) {
            try {
              const parsed = JSON.parse(line.slice("ATLAS_LAYOUT ".length)) as AtlasLayoutEvent;
              if (atlasRef) {
                atlasRef.slots.clear();
                for (const [id, slot] of Object.entries(parsed.slots)) {
                  atlasRef.slots.set(id, slot);
                }
                atlasRef.onLayout?.(parsed);
              }
            } catch { /* ignore */ }
            return;
          }
          webrtcOfferUrl ??= line.match(/^WEBRTC_READY (\S+)/)?.[1] ?? null;
          fingerprint ??= line.match(/^MOQ_READY .*fingerprint=([0-9a-f]+)/)?.[1] ?? null;
          if (line.startsWith("MEDIA_READY") && fingerprint) {
            clearTimeout(timer);
            resolve({ fingerprint, webrtcOfferUrl });
          }
        });
        child.status.then((status) => {
          clearTimeout(timer);
          reject(new Error(`petplay-media atlas exited (${status.code}): ${log.at(-1) ?? ""}`));
        });
      },
    );

    const atlas = new WindowAtlas({
      streamId: `atlas-${Deno.hostname()}`,
      host: options.host,
      port: options.port,
      fingerprint: ready.fingerprint,
      webrtcOfferUrl: ready.webrtcOfferUrl,
      child,
      dir,
    });
    atlasRef = atlas;
    return atlas;
  }

  hasWindow(windowId: string): boolean {
    return this.helpers.has(windowId);
  }

  get windowCount(): number {
    return this.helpers.size;
  }

  feedInfoFor(windowId: string) {
    const slot = this.slots.get(windowId);
    return {
      host: this.host,
      port: this.port,
      fingerprint: this.fingerprint,
      webrtc: this.webrtc,
      streamId: this.streamId,
      crop: slot?.crop ?? { x: 0, y: 0, width: 1, height: 1 },
      ...(slot ? { srcSize: { width: slot.srcW, height: slot.srcH } } : {}),
    };
  }

  async addWindow(windowId: string, fps = 30): Promise<ReturnType<WindowAtlas["feedInfoFor"]>> {
    if (this.helpers.has(windowId)) return this.feedInfoFor(windowId);
    const socketPath = `${this.dir}/win-${++this.slotSeq}.sock`;
    await this.stdinWriter.write(this.encoder.encode(`ADD ${windowId} ${socketPath}\n`));
    // Brief pause so atlas binds the Unix seqpacket socket before screen-streamer connects.
    await new Promise((r) => setTimeout(r, 40));
    const helper = new Deno.Command(screenStreamerPath(), {
      args: [
        `--window=${windowId}`,
        "--no-frame-socket",
        "--no-input",
        `--media-socket=${socketPath}`,
        `--fps=${fps}`,
      ],
      env: linuxWaylandEnv(),
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    this.helpers.set(windowId, helper);
    void helper.status.then(async () => {
      if (this.helpers.get(windowId) !== helper) return;
      this.helpers.delete(windowId);
      this.slots.delete(windowId);
      if (!this.stopped) {
        await this.stdinWriter.write(this.encoder.encode(`REMOVE ${windowId}\n`)).catch(() => {});
        this.onWindowExited?.(windowId);
      }
    });
    return this.feedInfoFor(windowId);
  }

  async removeWindow(windowId: string): Promise<void> {
    const helper = this.helpers.get(windowId);
    if (!helper) return;
    this.helpers.delete(windowId);
    this.slots.delete(windowId);
    try {
      helper.kill("SIGTERM");
    } catch { /* gone */ }
    await Promise.race([helper.status, new Promise((r) => setTimeout(r, 1000))]);
    try {
      helper.kill("SIGKILL");
    } catch { /* gone */ }
    if (!this.stopped) {
      await this.stdinWriter.write(this.encoder.encode(`REMOVE ${windowId}\n`)).catch(() => {});
    }
  }

  async acceptWebRtcOffer(sdp: string): Promise<string> {
    if (!this.webrtcOfferUrl) throw new Error("atlas has no WebRTC endpoint");
    const resp = await fetch(this.webrtcOfferUrl, {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: sdp,
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`atlas WebRTC offer rejected (${resp.status}): ${text}`);
    return text;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const id of [...this.helpers.keys()]) await this.removeWindow(id);
    try {
      await this.stdinWriter.close();
    } catch { /* closed */ }
    try {
      this.child.kill("SIGTERM");
    } catch { /* gone */ }
    await Promise.race([this.child.status, new Promise((r) => setTimeout(r, 1500))]);
    try {
      this.child.kill("SIGKILL");
    } catch { /* gone */ }
    await Deno.remove(this.dir, { recursive: true }).catch(() => {});
  }
}
