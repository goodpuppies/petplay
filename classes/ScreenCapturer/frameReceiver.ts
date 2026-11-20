/**
 * The receiving end of the capture helper's frame socket: a worker listening on a loopback TCP
 * port that the helper (`--port=N`) connects to and streams RGBA frames into. Whoever shows
 * frames owns one; whoever owns the helper (`desktopSource`) is told its port.
 *
 * With `reaccept` (the default) it outlives helpers: a restarted helper connects to the same
 * port again.
 */
import type { CapturedFrame } from "./scclass.ts";

export type FrameReceiverOptions = {
  /** 0 (default): any free port. */
  port?: number;
  reaccept?: boolean;
  /** The helper's socket closed. */
  onDisconnect?: () => void;
  /** Every 30 frames. */
  onStats?: (stats: { fps: number; avgLatency: number }) => void;
};

const LISTENER_START_TIMEOUT_MS = 5_000;

export class FrameReceiver {
  #worker: Worker;
  #frame: CapturedFrame | null = null;
  #received = false;
  #connected = false;
  #waiters: Array<(frame: CapturedFrame | null) => void> = [];
  #count = 0;
  #receiveTime = 0;
  #statsSince = performance.now();
  #disposed = false;

  private constructor(worker: Worker, readonly port: number, options: FrameReceiverOptions) {
    this.#worker = worker;
    worker.onmessage = (event: MessageEvent) => {
      const { type, data, width, height, receiveTime } = event.data;
      if (type === "connected") this.#connected = true;
      else if (type === "disconnected") {
        this.#connected = false;
        options.onDisconnect?.();
      } else if (type === "frame") {
        this.#frame = { data, width, height, receiveTime };
        this.#received = true;
        for (const finish of this.#waiters.splice(0)) finish(this.#frame);
        this.#count++;
        this.#receiveTime += receiveTime;
        if (this.#count % 30 === 0) {
          const now = performance.now();
          options.onStats?.({
            fps: (this.#count * 1000) / Math.max(1, now - this.#statsSince),
            avgLatency: this.#receiveTime / this.#count,
          });
          this.#count = 0;
          this.#receiveTime = 0;
          this.#statsSince = now;
        }
      }
    };
  }

  static async start(options: FrameReceiverOptions = {}): Promise<FrameReceiver> {
    const worker = new Worker(new URL("./frame_receiver_worker.ts", import.meta.url).href, {
      type: "module",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const port = await Promise.race([
        new Promise<number>((resolve, reject) => {
          worker.onerror = (event) => {
            event.preventDefault();
            reject(new Error(`Capture receiver worker failed to load: ${event.message}`));
          };
          worker.onmessageerror = () =>
            reject(new Error("Capture receiver worker could not deserialize a message"));
          worker.onmessage = (event: MessageEvent) => {
            if (event.data.type === "listening") resolve(event.data.port);
            else if (event.data.type === "error") reject(new Error(event.data.error));
          };
          worker.postMessage({
            type: "connect",
            port: options.port ?? 0,
            reaccept: options.reaccept ?? true,
          });
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Capture receiver did not start listening within ${LISTENER_START_TIMEOUT_MS}ms`,
                ),
              ),
            LISTENER_START_TIMEOUT_MS,
          );
        }),
      ]);
      return new FrameReceiver(worker, port, options);
    } catch (error) {
      worker.terminate();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  get connected(): boolean {
    return this.#connected;
  }

  /** True once any helper has delivered a frame. */
  hasReceivedFrame(): boolean {
    return this.#received;
  }

  latestFrame(): CapturedFrame | null {
    return this.#frame;
  }

  /** A frame newer than `previous`, or null after `timeoutMs` (or on dispose). */
  nextFrame(previous: CapturedFrame | null, timeoutMs = 1_000): Promise<CapturedFrame | null> {
    if (this.#disposed) return Promise.resolve(null);
    if (this.#frame && this.#frame !== previous) return Promise.resolve(this.#frame);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (frame: CapturedFrame | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const index = this.#waiters.indexOf(finish);
        if (index >= 0) this.#waiters.splice(index, 1);
        resolve(frame);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.#waiters.push(finish);
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#worker.postMessage({ type: "stop" });
    this.#worker.terminate();
    this.#frame = null;
    for (const finish of this.#waiters.splice(0)) finish(null);
  }
}
