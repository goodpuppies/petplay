/**
 * `dmabuf-seqpacket`: a StageForge `TransportKind` for negotiating local Linux `SOCK_SEQPACKET`
 * DMA-BUF frame sockets (`petplay_mediatransport/docs/protocol.md`) between native media actors
 * (`petplayMedia@*`, `screenStreamer@*`, `petplay_ovrdriver`) and their TypeScript coordinators.
 *
 * The StageForge transport handshake carries only the bound Unix socket descriptor (`{ socketPath }`)
 * over `TRANSPORTOFFER` / `TRANSPORTSIGNAL`; GPU frames (`SCM_RIGHTS` DMA-BUF FDs) flow directly
 * between native processes without touching JS/Deno.
 */
import {
  closedSignal,
  type EstablishContext,
  type KindConnection,
  type TransportKind,
  type TransportParams,
} from "../../submodules/stageforge/mod.ts";

export const MEDIA_FRAMES_PURPOSE = "media.frames";
export const DMABUF_SEQPACKET_KIND = "dmabuf-seqpacket";

export type DmabufSeqpacketEndpoint = {
  socketPath: string;
  params: TransportParams;
};

/**
 * Initiator side: calls `Transport.open(mediaActor, { purpose: MEDIA_FRAMES_PURPOSE,
 * kinds: [DMABUF_SEQPACKET_KIND], params: { feedId } | { atlasId, slotId } })` and receives the
 * bound Unix `SOCK_SEQPACKET` path in `transport.connection.socketPath`.
 */
export function dmabufSeqpacketClientTransport(): TransportKind {
  return {
    kind: DMABUF_SEQPACKET_KIND,
    preferListener: "responder",
    listenReach: () => null,
    connectReach: () => (Deno.build.os === "linux" ? "host" : null),
    async establish(ctx: EstablishContext): Promise<KindConnection<DmabufSeqpacketEndpoint>> {
      const msg = await ctx.signal.recv() as { socketPath?: unknown } | null;
      if (typeof msg?.socketPath !== "string" || !msg.socketPath) {
        throw new Error("dmabuf-seqpacket signal missing socketPath");
      }
      const { closed, end } = closedSignal();
      ctx.signal.abort.addEventListener("abort", () => end("signal aborted"), { once: true });
      return {
        connection: { socketPath: msg.socketPath, params: ctx.params },
        closed,
        close: (reason) => end(reason),
      };
    },
  };
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
