/**
 * Desktop media feed hosted inside this process's shared `petplayMedia@*` StageForge native actor
 * (`petplay-media actor`, `NativeStdioProxy`), opened and closed as a `dmabuf-seqpacket`
 * StageForge `Transport`.
 */
import { type ActorId, PostMan, Transport } from "../submodules/stageforge/mod.ts";
import {
  closeDmabufSeqpacketTransport,
  DMABUF_SEQPACKET_KIND,
  type DmabufSeqpacketEndpoint,
  ensureDmabufSeqpacketClient,
  MEDIA_FRAMES_PURPOSE,
} from "../rdp/classes/dmabufSeqpacketTransport.ts";
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
  /** Frame layout ("mono" or "side-by-side"); default "mono". */
  layout?: "mono" | "side-by-side";
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
    private readonly transport: Transport,
    readonly exited: Promise<Deno.CommandStatus>,
  ) {}

  static async start(options: DesktopMediaOptions): Promise<DesktopMediaFeed> {
    ensureDmabufSeqpacketClient();
    const actorId = await ensurePetplayMedia();
    const feedId = options.actorFeedId ?? `desktop-${options.port}`;
    const transport = await Transport.open(actorId, {
      purpose: MEDIA_FRAMES_PURPOSE,
      kinds: [DMABUF_SEQPACKET_KIND],
      params: {
        feedId,
        ...(options.socketPath ? { socketPath: options.socketPath } : {}),
        host: options.host,
        port: options.port,
        layout: options.layout ?? "mono",
        fps: options.fps ?? 30,
        maxFps: options.fps ?? 30,
        bitrate: options.bitrate ?? 8_000_000,
        persist: true,
        share: Boolean(options.share),
      },
    });
    const endpoint = transport.connection as DmabufSeqpacketEndpoint;
    const exited: Promise<Deno.CommandStatus> = transport.closed.then((reason) => ({
      success: reason === "stopped",
      code: reason === "stopped" ? 0 : 1,
      signal: null,
    }));

    return new DesktopMediaFeed(
      endpoint.socketPath,
      {
        port: endpoint.port ?? options.port,
        fingerprint: endpoint.fingerprint ?? "",
        ...(endpoint.code ? { code: endpoint.code } : {}),
        ...(endpoint.webrtc ? { webrtc: true } : {}),
      },
      actorId,
      endpoint.feedId ?? feedId,
      transport,
      exited,
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

  /** Called by the owning actor if `petplayMedia@*` pushes `FEED_ENDED`. */
  notifyActorEnded(): void {
    this.transport.close("feed ended");
  }

  async stop(): Promise<void> {
    await closeDmabufSeqpacketTransport(this.transport, "stopped");
  }
}
