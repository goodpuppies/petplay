/**
 * `webrtc-video`: a StageForge `TransportKind` for streaming H.264 video from `petplay-media`
 * (via `ui.tsx` → `desktopSource`) to a browser tab over WebRTC (`RTCPeerConnection`).
 *
 * Uses StageForge's generalized `establish(ctx)` + `TRANSPORTSIGNAL` channel for the 2-way
 * SDP offer/answer exchange over the encrypted iroh actor route:
 *
 * - Browser side (`webRtcVideoBrowserTransport`): runs inside the `client.ts` Web Worker and
 *   delegates `RTCPeerConnection` + `<video>` + `createImageBitmap` to the main thread (`page.ts`)
 *   over their existing `MessagePort` (`RTCPeerConnection` is main-thread-only in browsers).
 * - Server side (`webRtcVideoServerTransport`): runs inside `ui.tsx`, validates the session
 *   secret, forwards the browser's SDP offer to the selected desktop's `desktopSource`
 *   (`WEBRTC_OFFER`), and returns `petplay-media`'s ICE-lite SDP answer over `ctx.signal`.
 */
import {
  closedSignal,
  type EstablishContext,
  type KindConnection,
  type TransportKind,
  type TransportParams,
} from "../../submodules/stageforge/mod.ts";

export const MEDIA_PURPOSE = "rdp.media";
export const WEBRTC_VIDEO_KIND = "webrtc-video";

/** Server side (`ui.tsx`): accepts an SDP offer and returns the SDP answer. */
export function webRtcVideoServerTransport(
  acceptOffer: (params: TransportParams, offerSdp: string) => Promise<string>,
): TransportKind {
  return {
    kind: WEBRTC_VIDEO_KIND,
    preferListener: "responder",
    listenReach: () => "network",
    connectReach: () => null,
    async establish(ctx: EstablishContext): Promise<KindConnection<{ feed: string }>> {
      const msg = await ctx.signal.recv() as { sdp?: unknown } | null;
      if (typeof msg?.sdp !== "string" || !msg.sdp) {
        throw new Error("webrtc-video offer missing sdp");
      }
      const answerSdp = await acceptOffer(ctx.params, msg.sdp);
      ctx.signal.send({ sdp: answerSdp });
      const { closed, end } = closedSignal();
      ctx.signal.abort.addEventListener("abort", () => end("signal aborted"), { once: true });
      return {
        connection: { feed: String(ctx.params.feed ?? "") },
        closed,
        close: (reason) => end(reason),
      };
    },
  };
}

/** Bridge messages between `client.ts` (worker) and `page.ts` (main thread) for WebRTC video. */
export type PageWebRtcCommand =
  | { webrtc: "offer"; id: string; feed: string }
  | { webrtc: "answer"; id: string; sdp: string }
  | { webrtc: "close"; id: string };

export type PageWebRtcEvent =
  | { webrtc: "offer"; id: string; sdp: string }
  | { webrtc: "error"; id: string; error: string }
  | { webrtc: "closed"; id: string; reason?: string }
  | { webrtc: "size"; id: string; feed: string; width: number; height: number }
  | { webrtc: "frame"; id: string; feed: string; bitmap: ImageBitmap };

export type WebRtcVideoClientHandle = {
  id: string;
  feed: string;
  takeFrame(): ImageBitmap | null;
  onSize: ((width: number, height: number) => void) | null;
};

/**
 * Browser worker side (`client.ts`): registers `webrtc-video` backed by `page.ts`'s main-thread
 * `RTCPeerConnection` bridge. Call `handlePageEvent` for each inbound `{ webrtc: ... }` message
 * from the page's `MessagePort`.
 */
export function webRtcVideoBrowserTransport(
  postToPage: (cmd: PageWebRtcCommand) => void,
): TransportKind & { handlePageEvent(event: PageWebRtcEvent): void } {
  type PendingOffer = { resolve: (sdp: string) => void; reject: (err: Error) => void };
  type Active = {
    latest: ImageBitmap | null;
    end: (reason?: string) => void;
    handle: WebRtcVideoClientHandle;
  };
  const pendingOffers = new Map<string, PendingOffer>();
  const active = new Map<string, Active>();

  return {
    kind: WEBRTC_VIDEO_KIND,
    preferListener: "responder",
    listenReach: () => null,
    connectReach: () => "network",
    async establish(ctx: EstablishContext): Promise<KindConnection<WebRtcVideoClientHandle>> {
      const feed = String(ctx.params.feed ?? "desktop");
      const { closed, end } = closedSignal();
      const entry: Active = {
        latest: null,
        end,
        handle: {
          id: ctx.id,
          feed,
          onSize: null,
          takeFrame() {
            const frame = entry.latest;
            entry.latest = null;
            return frame;
          },
        },
      };
      active.set(ctx.id, entry);

      try {
        const offerSdp = await new Promise<string>((resolve, reject) => {
          pendingOffers.set(ctx.id, { resolve, reject });
          postToPage({ webrtc: "offer", id: ctx.id, feed });
        });
        ctx.signal.send({ sdp: offerSdp });
        const reply = await ctx.signal.recv() as { sdp?: unknown } | null;
        if (typeof reply?.sdp !== "string" || !reply.sdp) {
          throw new Error("webrtc-video answer missing sdp");
        }
        postToPage({ webrtc: "answer", id: ctx.id, sdp: reply.sdp });
      } catch (error) {
        pendingOffers.delete(ctx.id);
        active.delete(ctx.id);
        entry.latest?.close();
        postToPage({ webrtc: "close", id: ctx.id });
        throw error;
      }

      return {
        connection: entry.handle,
        closed,
        close(reason) {
          active.delete(ctx.id);
          entry.latest?.close();
          entry.latest = null;
          postToPage({ webrtc: "close", id: ctx.id });
          end(reason);
        },
      };
    },
    handlePageEvent(event: PageWebRtcEvent): void {
      if (event.webrtc === "offer") {
        const p = pendingOffers.get(event.id);
        if (p) {
          pendingOffers.delete(event.id);
          p.resolve(event.sdp);
        }
      } else if (event.webrtc === "error") {
        const p = pendingOffers.get(event.id);
        if (p) {
          pendingOffers.delete(event.id);
          p.reject(new Error(event.error));
        }
        const a = active.get(event.id);
        if (a) {
          active.delete(event.id);
          a.latest?.close();
          a.latest = null;
          a.end(event.error);
        }
      } else if (event.webrtc === "closed") {
        const a = active.get(event.id);
        if (a) {
          active.delete(event.id);
          a.latest?.close();
          a.latest = null;
          a.end(event.reason ?? "webrtc closed");
        }
      } else if (event.webrtc === "size") {
        active.get(event.id)?.handle.onSize?.(event.width, event.height);
      } else if (event.webrtc === "frame") {
        const a = active.get(event.id);
        if (!a) {
          event.bitmap.close();
          return;
        }
        a.latest?.close();
        a.latest = event.bitmap;
      }
    },
  };
}
