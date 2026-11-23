/// <reference lib="dom" />
/**
 * Receiving the media feeds a scene's `videoSurface` items show: one WebTransport receiver
 * (`petplay_mediatransport/web/src/receiver.ts`) per listed feed, each due picture uploaded into
 * the texture every surface of that feed shares. A feed that fails or ends is retried against
 * the latest list. Works in a page or a worker.
 */
import {
  connectReceiver,
  createReceiverStats,
  type Receiver,
  type ReceiverStats,
} from "../../submodules/petplay_mediatransport/web/src/receiver.ts";
import type { FeedFrame, SceneView } from "./sceneView.ts";

/** `host` is where the encoder serves; without it, the page's host (or `?media=HOST`). */
export type FeedInfo = { port: number; fingerprint: string; host?: string };
type Feed = { key: string; receiver: Receiver | null; stats: ReceiverStats; status: string };
const FEED_RETRY_MS = 2000;

export class MediaFeeds {
  readonly feeds = new Map<string, Feed>();
  /** The latest list; a feed that fails or ends is retried against it. */
  private listed: Record<string, FeedInfo> = {};

  constructor(
    private readonly view: SceneView,
    private readonly options: URLSearchParams = new URLSearchParams(location.search),
    /** Called once per connected feed with its picture size. */
    private readonly onSize?: (name: string, width: number, height: number) => void,
  ) {}

  /** Connects to every listed feed, once per (feed, encoder instance). */
  update(listed: Record<string, FeedInfo>): void {
    this.listed = listed;
    for (const [name, info] of Object.entries(listed)) {
      const key = `${info.host ?? ""}:${info.port}:${info.fingerprint}`;
      if (this.feeds.get(name)?.key === key) continue;
      this.drop(name);
      const feed: Feed = {
        key,
        receiver: null,
        stats: createReceiverStats(this.options),
        status: "connecting",
      };
      this.feeds.set(name, feed);
      const host = info.host ?? this.options.get("media") ?? location.hostname;
      const url = new URL(`https://${host.includes(":") ? `[${host}]` : host}:${info.port}/`);
      connectReceiver({
        url,
        fingerprint: info.fingerprint,
        stats: feed.stats,
        bufferMs: Number(this.options.get("buffer") ?? 20),
        software: this.options.has("software"),
        onStatus: (text) => feed.status = text,
      }).then(async (receiver) => {
        if (this.feeds.get(name) !== feed) return receiver.close();
        feed.receiver = receiver;
        feed.status = `${receiver.meta.width}×${receiver.meta.height}`;
        this.onSize?.(name, receiver.meta.width, receiver.meta.height);
        await receiver.run();
      }).catch((error) => {
        feed.status = `error: ${error}`;
        console.warn(`media feed ${name}:`, error);
      }).finally(() => {
        if (this.feeds.get(name) !== feed) return;
        feed.receiver = null;
        feed.key = ""; // stale: the retry (or the next list) connects again
        setTimeout(() => {
          if (this.feeds.get(name) === feed) this.update(this.listed);
        }, FEED_RETRY_MS);
      });
    }
    for (const name of [...this.feeds.keys()]) if (!(name in listed)) this.drop(name);
  }

  /**
   * Stops showing a feed that changed or left: its receiver closes, and its surfaces go black
   * rather than keep the last picture of the old source.
   */
  private drop(name: string): void {
    const feed = this.feeds.get(name);
    if (!feed) return;
    this.feeds.delete(name);
    feed.receiver?.close();
    this.view.clearFeed(name)?.close();
  }

  /** Upload due pictures; the previous pictures go to `replaced`, to close after drawing. */
  present(now: number, replaced: FeedFrame[]): boolean {
    let updated = false;
    for (const [name, feed] of this.feeds) {
      const frame = feed.receiver?.takeDue(now);
      if (!frame) continue;
      updated = true;
      const previous = this.view.setFeedFrame(name, frame);
      if (previous) replaced.push(previous);
    }
    return updated;
  }
}
