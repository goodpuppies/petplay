/**
 * Per-window enumeration, focus, and GPU-encoded media capture:
 * - Linux (KDE Plasma 6 Wayland): `screen-streamer --list-windows` / `--focus-window=<uuid>` /
 *   `--window=<uuid>` using `org_kde_plasma_window_management` + `zkde_screencast_unstable_v1`
 *   (no XDG portal dialog), feeding into a dedicated `DesktopMediaFeed` (`petplay-media`).
 * - Windows: `petplay-media capture-wgc --list-windows` / `--focus-window <hwnd>` /
 *   `--window <hwnd>` using `EnumWindows` + `IGraphicsCaptureItemInterop::CreateForWindow`.
 */
import { type ActorId, PostMan } from "../../submodules/stageforge/mod.ts";
import { ensurePetplayMedia } from "./petplayMediaActor.ts";
import { DesktopMediaFeed } from "../../classes/sceneStreamMedia.ts";
import { petplayMediaPath } from "../../classes/petplayMediaPath.ts";
import {
  loadWorkspaceOutputs,
  workspaceOutputsFromKscreen,
} from "../../classes/environment/workspaceDisplays.ts";
import { ensureScreenStreamer, linuxWaylandEnv } from "./screenStreamerActor.ts";
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
    const streamer = await ensureScreenStreamer();
    const parsed = await PostMan.PostMessage({
      target: streamer,
      type: "LISTWINDOWS",
    }, true) as WindowInfo[];
    return attachRegions(Array.isArray(parsed) ? parsed : [], await workspaceBounds());
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
    const streamer = await ensureScreenStreamer();
    await PostMan.PostMessage({
      target: streamer,
      type: "FOCUSWINDOW",
      payload: { window: id },
    }, true);
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
      actorFeedId: `win-${options.windowId}`,
    });
    const streamer = await ensureScreenStreamer();
    const captureId = `win:${options.windowId}`;
    await PostMan.PostMessage({
      target: streamer,
      type: "START_CAPTURE",
      payload: {
        id: captureId,
        target: { kind: "window", window: options.windowId },
        mediaSocket: encoder.socketPath,
        fps: options.fps ?? 30,
      },
    }, true);

    const stop = async () => {
      await PostMan.PostMessage({
        target: streamer,
        type: "STOP_CAPTURE",
        payload: { id: captureId },
      }, true).catch(() => {});
      await encoder.stop();
    };

    const exited = encoder.exited.then(() => stop());

    return new WindowMediaFeed(
      {
        host: options.host,
        port: encoder.info.port,
        fingerprint: encoder.info.fingerprint,
        ...(encoder.info.code ? { code: encoder.info.code } : {}),
        ...(encoder.info.webrtc ? { webrtc: true } : {}),
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
  private readonly mediaActor: ActorId;
  private readonly atlasId: string;
  private readonly activeWindows = new Set<string>();
  private readonly slots = new Map<string, AtlasSlotLayout>();
  private stopped = false;
  onLayout: ((layout: AtlasLayoutEvent) => void) | null = null;
  onWindowExited: ((windowId: string) => void) | null = null;

  private constructor(
    args: {
      streamId: string;
      atlasId: string;
      mediaActor: ActorId;
      host: string;
      port: number;
      fingerprint: string;
      webrtc: boolean;
    },
  ) {
    this.streamId = args.streamId;
    this.atlasId = args.atlasId;
    this.mediaActor = args.mediaActor;
    this.host = args.host;
    this.port = args.port;
    this.fingerprint = args.fingerprint;
    this.webrtc = args.webrtc;
  }

  static async start(options: {
    host: string;
    port: number;
    width?: number;
    height?: number;
    fps?: number;
    bitrate?: number;
    subscriber?: string;
  }): Promise<WindowAtlas> {
    const atlasId = `atlas-${Deno.hostname()}`;
    const mediaActor = await ensurePetplayMedia();
    const res = await PostMan.PostMessage({
      target: mediaActor,
      type: "ATLAS_START",
      payload: {
        id: atlasId,
        host: options.host,
        port: options.port,
        width: options.width ?? 2560,
        height: options.height ?? 1440,
        fps: options.fps ?? 30,
        bitrate: options.bitrate ?? 12_000_000,
        ...(options.subscriber ? { subscriber: options.subscriber } : {}),
      },
    }, true) as {
      id: string;
      host: string;
      port: number;
      fingerprint: string;
      webrtc?: boolean;
    };
    return new WindowAtlas({
      streamId: atlasId,
      atlasId: res.id,
      mediaActor,
      host: res.host,
      port: res.port,
      fingerprint: res.fingerprint,
      webrtc: Boolean(res.webrtc),
    });
  }

  /** Called by desktopSource when `petplayMedia@*` pushes `ATLAS_LAYOUT`. */
  handleLayout(layout: AtlasLayoutEvent): void {
    this.slots.clear();
    for (const [id, slot] of Object.entries(layout.slots)) {
      this.slots.set(id, slot);
    }
    this.onLayout?.(layout);
  }

  hasWindow(windowId: string): boolean {
    return this.activeWindows.has(windowId);
  }

  get windowCount(): number {
    return this.activeWindows.size;
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
    if (this.activeWindows.has(windowId)) return this.feedInfoFor(windowId);
    // petplayMedia@* allocates and binds the Unix SOCK_SEQPACKET synchronously before replying.
    const added = await PostMan.PostMessage({
      target: this.mediaActor,
      type: "ATLAS_ADD",
      payload: { id: this.atlasId, slotId: windowId },
    }, true) as { slotId: string; socketPath: string };
    const streamer = await ensureScreenStreamer();
    await PostMan.PostMessage({
      target: streamer,
      type: "START_CAPTURE",
      payload: {
        id: `win:${windowId}`,
        target: { kind: "window", window: windowId },
        mediaSocket: added.socketPath,
        fps,
      },
    }, true);
    this.activeWindows.add(windowId);
    return this.feedInfoFor(windowId);
  }

  /** Called by desktopSource when `screenStreamer` pushes `CAPTURE_ENDED` for `win:<id>`. */
  handleCaptureEnded(windowId: string): void {
    if (!this.activeWindows.delete(windowId)) return;
    this.slots.delete(windowId);
    if (!this.stopped) {
      void PostMan.PostMessage({
        target: this.mediaActor,
        type: "ATLAS_REMOVE",
        payload: { id: this.atlasId, slotId: windowId },
      }, true).catch(() => {});
      this.onWindowExited?.(windowId);
    }
  }

  async removeWindow(windowId: string): Promise<void> {
    if (!this.activeWindows.delete(windowId)) return;
    this.slots.delete(windowId);
    const streamer = await ensureScreenStreamer().catch(() => null);
    if (streamer) {
      await PostMan.PostMessage({
        target: streamer,
        type: "STOP_CAPTURE",
        payload: { id: `win:${windowId}` },
      }, true).catch(() => {});
    }
    if (!this.stopped) {
      await PostMan.PostMessage({
        target: this.mediaActor,
        type: "ATLAS_REMOVE",
        payload: { id: this.atlasId, slotId: windowId },
      }, true).catch(() => {});
    }
  }

  async acceptWebRtcOffer(sdp: string): Promise<string> {
    const res = await PostMan.PostMessage({
      target: this.mediaActor,
      type: "WEBRTC_OFFER",
      payload: { id: this.atlasId, sdp },
    }, true) as { sdp: string };
    return res.sdp;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const id of [...this.activeWindows]) await this.removeWindow(id);
    await PostMan.PostMessage({
      target: this.mediaActor,
      type: "STOP_FEED",
      payload: { id: this.atlasId },
    }, true).catch(() => {});
  }
}
