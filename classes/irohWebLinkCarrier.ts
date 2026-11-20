/**
 * The browser side of iroh links (submodules/petplay_mediatransport/link-web): a dial-only
 * stageforge link carrier. iroh in a browser is relay-only, so a page reaches a hub through the
 * hub's relay, and the hubs then negotiate a direct transport over the link (`link.upgrade`).
 *
 * Takes the wasm-bindgen module (`pkg-web` in a page, `pkg-deno` in tests) so this file has no
 * build step of its own.
 */
import type { Carrier, LinkCarrierKind } from "../submodules/stageforge/mod.ts";
import {
  decodeWebSocketWorkerMessage,
  encodeWebSocketWorkerMessage,
} from "../submodules/stageforge/src/lib/webSocketWorkerCodec.ts";
import type { IrohEndpoint } from "./irohLinkCarrier.ts";

type LinkConnection = {
  send(text: string): Promise<void>;
  recv(): Promise<{ data?: string; closed?: string }>;
  close(reason: string): Promise<void>;
};
type LinkEndpoint = {
  id(): string;
  connect(id: string, relay: string): Promise<LinkConnection>;
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

/** Dial-only iroh carrier for a page. `relay` replaces n0's public relays. */
export function irohWebLinkCarrier(
  module: IrohWebModule,
  options: { relay?: string } = {},
): LinkCarrierKind & { stop(): Promise<void> } {
  let endpoint: Promise<LinkEndpoint> | null = null;
  const bound = () => endpoint ??= module.LinkEndpoint.bind(options.relay ?? null);
  return {
    kind: "iroh",
    // A browser cannot accept connections, so it has nothing to publish.
    publishable: false,
    listen: () => Promise.reject(new Error("a browser cannot accept iroh links")),
    async connect(target) {
      const { id, relay } = target as IrohEndpoint;
      if (!relay) throw new Error("a browser reaches a hub only through its relay");
      return new WebCarrier(await (await bound()).connect(id, relay));
    },
    async stop() {
      const running = endpoint;
      endpoint = null;
      await (await running)?.close();
    },
  };
}
