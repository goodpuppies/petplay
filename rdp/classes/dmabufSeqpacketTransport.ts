/**
 * `dmabuf-seqpacket`: a StageForge `TransportKind` for negotiating local Linux `SOCK_SEQPACKET`
 * DMA-BUF frame sockets (`petplay_mediatransport/docs/protocol.md`) between native media actors
 * (`petplayMedia@*`, `screenStreamer@*`, `petplay_ovrdriver`) and their TypeScript coordinators.
 *
 * Opening with `{ feedId, host, port, ... }` starts and owns the feed on `petplayMedia@*` (closing
 * the transport stops and unlinks it); opening with `{ feedId }` or `{ atlasId, slotId }` attaches
 * to an existing bound socket. GPU frames (`SCM_RIGHTS` DMA-BUF FDs) flow directly between native
 * processes without touching JS/Deno.
 */
import {
  closedSignal,
  type EstablishContext,
  type KindConnection,
  PostMan,
  registerTransportKind,
  type Transport,
  type TransportKind,
  type TransportParams,
} from "../../submodules/stageforge/mod.ts";

export const MEDIA_FRAMES_PURPOSE = "media.frames";
export const DMABUF_SEQPACKET_KIND = "dmabuf-seqpacket";

export type DmabufSeqpacketEndpoint = {
  socketPath: string;
  feedId?: string;
  host?: string;
  port?: number;
  fingerprint?: string;
  code?: string;
  webrtc?: boolean;
  params: TransportParams;
};

let clientRegistered = false;

/** Idempotently register the `dmabuf-seqpacket` client transport kind on this actor. */
export function ensureDmabufSeqpacketClient(): void {
  if (clientRegistered) return;
  clientRegistered = true;
  registerTransportKind(dmabufSeqpacketClientTransport());
}

/**
 * Initiator side: calls `Transport.open(mediaActor, { purpose: MEDIA_FRAMES_PURPOSE,
 * kinds: [DMABUF_SEQPACKET_KIND], params: ... })` and receives the bound socket + feed metadata in
 * `transport.connection`. Closing the transport sends `{ closed: true }` over `TRANSPORTSIGNAL`.
 */
export function dmabufSeqpacketClientTransport(): TransportKind {
  return {
    kind: DMABUF_SEQPACKET_KIND,
    preferListener: "responder",
    listenReach: () => null,
    connectReach: () => (Deno.build.os === "linux" ? "host" : null),
    async establish(ctx: EstablishContext): Promise<KindConnection<DmabufSeqpacketEndpoint>> {
      const msg = await ctx.signal.recv() as {
        socketPath?: unknown;
        feedId?: unknown;
        host?: unknown;
        port?: unknown;
        fingerprint?: unknown;
        code?: unknown;
        webrtc?: unknown;
      } | null;
      if (typeof msg?.socketPath !== "string" || !msg.socketPath) {
        throw new Error("dmabuf-seqpacket signal missing socketPath");
      }
      const { closed, end } = closedSignal();
      let sentClose = false;
      ctx.signal.onmessage = (data) => {
        const d = data as { closed?: unknown; reason?: unknown } | null;
        if (d?.closed) end(typeof d.reason === "string" ? d.reason : "peer closed");
      };
      ctx.signal.abort.addEventListener("abort", () => end("signal aborted"), { once: true });
      const endpoint: DmabufSeqpacketEndpoint = {
        socketPath: msg.socketPath,
        ...(typeof msg.feedId === "string" ? { feedId: msg.feedId } : {}),
        ...(typeof msg.host === "string" ? { host: msg.host } : {}),
        ...(typeof msg.port === "number" ? { port: msg.port } : {}),
        ...(typeof msg.fingerprint === "string" ? { fingerprint: msg.fingerprint } : {}),
        ...(typeof msg.code === "string" ? { code: msg.code } : {}),
        ...(typeof msg.webrtc === "boolean" ? { webrtc: msg.webrtc } : {}),
        params: ctx.params,
      };
      return {
        connection: endpoint,
        closed,
        close: (reason) => {
          if (!sentClose) {
            sentClose = true;
            try {
              ctx.signal.send({ closed: true, reason });
            } catch { /* channel already closed */ }
          }
          end(reason);
        },
      };
    },
  };
}

/**
 * Close a `dmabuf-seqpacket` transport and wait for the responder (`petplayMedia@*`) to finish
 * stopping the feed and unlinking its socket before returning.
 */
export async function closeDmabufSeqpacketTransport(
  transport: Transport,
  reason = "stopped",
): Promise<void> {
  if (!transport.isClosed) {
    await PostMan.PostMessage({
      target: transport.info.peer,
      type: "TRANSPORTSIGNAL",
      payload: { id: transport.info.id, data: { closed: true, reason } },
    }, true).catch(() => {});
    transport.close(reason);
  }
  await transport.closed;
}

/** Responder side (for TypeScript actors advertising a local `SOCK_SEQPACKET` socket). */
export function dmabufSeqpacketServerTransport(
  resolveSocketPath: (params: TransportParams) => Promise<string> | string,
): TransportKind {
  return {
    kind: DMABUF_SEQPACKET_KIND,
    preferListener: "responder",
    listenReach: () => (Deno.build.os === "linux" ? "host" : null),
    connectReach: () => null,
    async establish(ctx: EstablishContext): Promise<KindConnection<DmabufSeqpacketEndpoint>> {
      const socketPath = await resolveSocketPath(ctx.params);
      ctx.signal.send({ socketPath });
      const { closed, end } = closedSignal();
      ctx.signal.abort.addEventListener("abort", () => end("signal aborted"), { once: true });
      return {
        connection: { socketPath, params: ctx.params },
        closed,
        close: (reason) => end(reason),
      };
    },
  };
}
