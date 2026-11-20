/**
 * The browser side of the iroh remote carrier (submodules/petplay_mediatransport/link-web).
 * iroh in a browser is relay-only: the page dials other processes through their relay and is
 * reached through its own, so it publishes `{id, relay}` in topic records like any process.
 *
 * Takes the wasm-bindgen module (`pkg-web` in a page, `pkg-deno` in tests) so this file has no
 * build step of its own.
 */
import type { Carrier, RemoteCarrierKind } from "../submodules/stageforge/mod.ts";
import {
  decodeWebSocketWorkerMessage,
  encodeWebSocketWorkerMessage,
} from "../submodules/stageforge/src/lib/webSocketWorkerCodec.ts";
import type { IrohEndpoint } from "./irohCarrier.ts";

type LinkConnection = {
  send(text: string): Promise<void>;
  recv(): Promise<{ data?: string; closed?: string }>;
  close(reason: string): Promise<void>;
};
type LinkEndpoint = {
  id(): string;
  relay(): string | undefined;
  connect(id: string, relay: string): Promise<LinkConnection>;
  /** The next incoming connection; undefined once the endpoint is closed. */
  accept(): Promise<LinkConnection | undefined>;
  close(): Promise<void>;
};
export type IrohWebModule = {
  LinkEndpoint: { bind(relay?: string | null): Promise<LinkEndpoint> };
};

class WebCarrier implements Carrier {
  onclose: ((reason?: string) => void) | null = null;
  #onmessage: ((data: unknown) => void) | null = null;
  #queue: unknown[] = [];
  #closed = false;
  #sending: Promise<void> = Promise.resolve();
  constructor(private readonly connection: LinkConnection) {
    void this.#receive();
  }
  get onmessage() {
    return this.#onmessage;
  }
  set onmessage(handler: ((data: unknown) => void) | null) {
    this.#onmessage = handler;
    if (handler) { for (const data of this.#queue.splice(0)) handler(data); }
  }
  send(data: unknown): void {
    if (this.#closed) throw new Error("iroh web carrier is closed");
    const text = encodeWebSocketWorkerMessage(data);
    this.#sending = this.#sending.then(() => this.connection.send(text)).catch((error) =>
      this.#end(`send failed: ${error}`)
    );
  }
  close(reason = "closed"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#sending = this.#sending.then(() => this.connection.close(reason)).catch(() => {});
  }
  async #receive(): Promise<void> {
    while (!this.#closed) {
      let frame: { data?: string; closed?: string };
      try {
        frame = await this.connection.recv();
      } catch (error) {
        this.#end(String(error));
        return;
      }
      if (frame.closed !== undefined) {
        this.#end(frame.closed);
        return;
      }
      let data: unknown;
      try {
        data = decodeWebSocketWorkerMessage(frame.data ?? "");
      } catch {
        continue;
      }
      if (this.#onmessage) this.#onmessage(data);
      else this.#queue.push(data);
    }
  }
  #end(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.onclose?.(reason);
  }
}

/** The iroh carrier for a page. `relay` replaces n0's public relays. */
export function irohWebCarrier(
  module: IrohWebModule,
  options: { relay?: string } = {},
): RemoteCarrierKind & { stop(): Promise<void> } {
  let endpoint: Promise<LinkEndpoint> | null = null;
  let accepting = false;
  const bound = () => endpoint ??= module.LinkEndpoint.bind(options.relay ?? null);
  return {
    kind: "iroh",
    publishable: true,
    async listen(accept) {
      const running = await bound();
      const relay = running.relay();
      if (!relay) throw new Error("the page's iroh endpoint has no relay");
      if (!accepting) {
        accepting = true;
        void (async () => {
          for (;;) {
            const connection = await running.accept().catch(() => undefined);
            if (!connection) return;
            accept(new WebCarrier(connection));
          }
        })();
      }
      return { id: running.id(), relay };
    },
    async connect(target) {
      const { id, relay } = target as IrohEndpoint;
      if (!relay) throw new Error("a page reaches other processes only through their relay");
      return new WebCarrier(await (await bound()).connect(id, relay));
    },
    async stop() {
      const running = endpoint;
      endpoint = null;
      accepting = false;
      await (await running)?.close();
    },
  };
}
