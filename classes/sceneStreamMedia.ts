/**
 * Desktop media feed hosted inside this process's shared `petplayMedia@*` StageForge native actor
 * (`petplay-media actor`, `NativeStdioProxy`).
 *
 * `petplayMedia@*` owns the DMA-BUF `SOCK_SEQPACKET` socket path, GPU VA-API encoder, MoQ/WebTransport
 * server, and in-process WebRTC hub. Callers receive `socketPath` (or negotiate it via the
 * `dmabuf-seqpacket` StageForge `TransportKind`) and exchange WebRTC SDP offers via `WEBRTC_OFFER`.
 */
import { type ActorId, PostMan } from "../submodules/stageforge/mod.ts";
import { ensurePetplayMedia } from "../rdp/classes/petplayMediaActor.ts";

export type MediaFeedInfo = {
  port: number;
  fingerprint: string;
  width?: number;
  height?: number;
  /** With `share`: the iroh share code, reachable across the internet (and the Windows receiver's
   * only way in). */
  code?: string;
  /** True when the feed can answer WebRTC H.264 SDP offers (`acceptWebRtcOffer`). */
  webrtc?: boolean;
};

export type DesktopMediaOptions = {
  /** Where browsers reach the worker: loopback, or this machine's tailnet address. */
  host: string;
  port: number;
  fps?: number;
  bitrate?: number;
  /** Optional explicit socket path; omitted lets `petplayMedia@*` allocate and clean up its own. */
  socketPath?: string;
  /** Also announce an iroh share code (`--iroh-share`), for receivers off the LAN or tailnet. */
  share?: boolean;
  /** Stable feed id inside `petplayMedia@*` (defaults to `desktop-<port>`). */
  actorFeedId?: string;
  /** Optional StageForge subscriber actor id for `FEED_ENDED` notifications. */
  subscriber?: string;
};

export class DesktopMediaFeed {
  readonly log: string[] = [];

  private constructor(
    readonly socketPath: string,
    readonly info: MediaFeedInfo,
    private readonly actorId: ActorId,
    private readonly feedId: string,
    readonly exited: Promise<Deno.CommandStatus>,
    private readonly resolveExited: (status: Deno.CommandStatus) => void,
  ) {}

  static async start(options: DesktopMediaOptions): Promise<DesktopMediaFeed> {
    const actorId = await ensurePetplayMedia();
    const feedId = options.actorFeedId ?? `desktop-${options.port}`;
    const res = await PostMan.PostMessage({
      target: actorId,
      type: "START_SOCKET_FEED",
      payload: {
        id: feedId,
        ...(options.socketPath ? { socketPath: options.socketPath } : {}),
        host: options.host,
        port: options.port,
        layout: "mono",
        fps: options.fps ?? 30,
        maxFps: options.fps ?? 30,
        bitrate: options.bitrate ?? 8_000_000,
        persist: true,
        share: Boolean(options.share),
        ...(options.subscriber ? { subscriber: options.subscriber } : {}),
      },
    }, true) as {
      id: string;
      socketPath: string;
      port: number;
      fingerprint: string;
      code?: string;
      webrtc?: boolean;
    };

    let resolveExited!: (status: Deno.CommandStatus) => void;
    const exited = new Promise<Deno.CommandStatus>((resolve) => {
      resolveExited = resolve;
    });

    return new DesktopMediaFeed(
      res.socketPath,
      {
        port: res.port,
        fingerprint: res.fingerprint,
        ...(res.code ? { code: res.code } : {}),
        ...(res.webrtc ? { webrtc: true } : {}),
      },
      actorId,
      res.id,
      exited,
      resolveExited,
    );
  }

  /** Exchange a browser's WebRTC SDP offer for this feed's ICE-lite SDP answer. */
  async acceptWebRtcOffer(offerSdp: string): Promise<string> {
    const res = await PostMan.PostMessage({
      target: this.actorId,
      type: "WEBRTC_OFFER",
      payload: { id: this.feedId, sdp: offerSdp },
    }, true) as { sdp: string };
    return res.sdp;
  }

  /** Called by the owning actor when `petplayMedia@*` pushes `FEED_ENDED` for this feed. */
  notifyActorEnded(): void {
    this.resolveExited({ success: false, code: 1, signal: null });
  }

  async stop(): Promise<void> {
    await PostMan.PostMessage({
      target: this.actorId,
      type: "STOP_FEED",
      payload: { id: this.feedId },
    }, true).catch(() => {});
    this.resolveExited({ success: true, code: 0, signal: null });
  }
}
