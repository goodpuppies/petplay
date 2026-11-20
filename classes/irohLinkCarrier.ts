/**
 * Iroh as a stageforge link carrier: how hubs first reach each other from a topic record.
 *
 * One `petplay-media link` child per hub owns the iroh endpoint (see
 * submodules/petplay_mediatransport/src/link.rs); this module drives it over stdio and turns
 * each iroh connection into a `Carrier`. The published endpoint is `{id, relay}`: it identifies
 * and authenticates this hub and reveals no IP address. Better transports are negotiated over
 * the link afterwards (`link.upgrade`).
 *
 * `local: true` binds loopback with no relay, for tests on one machine; its endpoint carries
 * loopback addresses instead of a relay.
 */
import type { Carrier, LinkCarrierKind } from "../submodules/stageforge/mod.ts";
import {
  decodeWebSocketWorkerMessage,
  encodeWebSocketWorkerMessage,
} from "../submodules/stageforge/src/lib/webSocketWorkerCodec.ts";
import { fromFileUrl } from "@std/path";

export type IrohEndpoint = { id: string; relay?: string | null; addrs?: string[] };

export type IrohLinkCarrierOptions = {
  /** `petplay-media` built with `--features iroh`. Default: PETPLAY_LINK_BINARY, else the release build. */
  binary?: string;
  local?: boolean;
  /** Use this relay instead of n0's public ones (self-hosted, or `iroh-relay --dev` in tests). */
  relay?: string;
};

type Event =
  | { ev: "ready"; id: string; relay: string | null; addrs: string[] }
  | { ev: "connected"; req: number; conn: number }
  | { ev: "failed"; req: number; error: string }
  | { ev: "incoming"; conn: number; peer: string }
  | { ev: "data"; conn: number; data: string }
  | { ev: "closed"; conn: number; reason: string };

class IrohCarrier implements Carrier {
  onclose: ((reason?: string) => void) | null = null;
  #onmessage: ((data: unknown) => void) | null = null;
  #queue: unknown[] = [];
  #closed = false;
  constructor(private readonly daemon: LinkDaemon, readonly conn: number, readonly peer: string) {}
  get onmessage() {
    return this.#onmessage;
  }
  set onmessage(handler: ((data: unknown) => void) | null) {
    this.#onmessage = handler;
    if (handler) { for (const data of this.#queue.splice(0)) handler(data); }
  }
  send(data: unknown): void {
    if (this.#closed) throw new Error("iroh carrier is closed");
    this.daemon.command({ op: "send", conn: this.conn, data: encodeWebSocketWorkerMessage(data) });
  }
  close(reason = "closed"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.daemon.forget(this.conn);
    this.daemon.command({ op: "close", conn: this.conn, reason });
  }
  receive(text: string): void {
    let data: unknown;
    try {
      data = decodeWebSocketWorkerMessage(text);
    } catch {
      return;
    }
    if (this.#onmessage) this.#onmessage(data);
    else this.#queue.push(data);
  }
  ended(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.onclose?.(reason);
  }
}

class LinkDaemon {
  readonly ready: Promise<IrohEndpoint>;
  #process: Deno.ChildProcess;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #encoder = new TextEncoder();
  #requests = new Map<number, { resolve: (c: IrohCarrier) => void; reject: (e: Error) => void }>();
  #carriers = new Map<number, IrohCarrier>();
  #nextReq = 1;
  #accept: ((carrier: Carrier) => void) | null = null;

  constructor(binary: string, local: boolean, relay?: string) {
    this.#process = new Deno.Command(binary, {
      args: ["link", ...(local ? ["--local"] : []), ...(relay ? ["--relay", relay] : [])],
      stdin: "piped",
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    this.#writer = this.#process.stdin.getWriter();
    let resolveReady!: (endpoint: IrohEndpoint) => void;
    let rejectReady!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.ready.catch(() => {});
    void this.#read(resolveReady).finally(() => {
      const reason = "iroh link process exited";
      rejectReady(new Error(reason));
      for (const pending of this.#requests.values()) pending.reject(new Error(reason));
      this.#requests.clear();
      for (const carrier of this.#carriers.values()) carrier.ended(reason);
      this.#carriers.clear();
    });
  }

  onIncoming(accept: (carrier: Carrier) => void): void {
    this.#accept = accept;
  }

  command(value: Record<string, unknown>): void {
    void this.#writer.write(this.#encoder.encode(JSON.stringify(value) + "\n")).catch(() => {});
  }

  forget(conn: number): void {
    this.#carriers.delete(conn);
  }

  connect(endpoint: IrohEndpoint): Promise<IrohCarrier> {
    const req = this.#nextReq++;
    return new Promise((resolve, reject) => {
      this.#requests.set(req, { resolve, reject });
      this.command({ op: "connect", req, endpoint });
    });
  }

  async stop(): Promise<void> {
    await this.#writer.close().catch(() => {});
    await this.#process.status;
  }

  async #read(resolveReady: (endpoint: IrohEndpoint) => void): Promise<void> {
    const lines = this.#process.stdout.pipeThrough(new TextDecoderStream());
    let buffer = "";
    for await (const chunk of lines) {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) this.#handle(JSON.parse(line) as Event, resolveReady);
      }
    }
  }

  #handle(event: Event, resolveReady: (endpoint: IrohEndpoint) => void): void {
    switch (event.ev) {
      case "ready":
        resolveReady({ id: event.id, relay: event.relay, addrs: event.addrs });
        return;
      case "connected": {
        const pending = this.#requests.get(event.req);
        this.#requests.delete(event.req);
        const carrier = new IrohCarrier(this, event.conn, "");
        this.#carriers.set(event.conn, carrier);
        pending?.resolve(carrier);
        return;
      }
      case "failed": {
        const pending = this.#requests.get(event.req);
        this.#requests.delete(event.req);
        pending?.reject(new Error(event.error));
        return;
      }
      case "incoming": {
        const carrier = new IrohCarrier(this, event.conn, event.peer);
        this.#carriers.set(event.conn, carrier);
        if (this.#accept) this.#accept(carrier);
        else carrier.close("not accepting links");
        return;
      }
      case "data":
        this.#carriers.get(event.conn)?.receive(event.data);
        return;
      case "closed":
        this.#carriers.get(event.conn)?.ended(event.reason);
        this.#carriers.delete(event.conn);
        return;
    }
  }
}

export function defaultLinkBinary(): string {
  return Deno.env.get("PETPLAY_LINK_BINARY") ??
    fromFileUrl(
      new URL(
        "../submodules/petplay_mediatransport/target/release/petplay-media",
        import.meta.url,
      ),
    );
}

/** The iroh link carrier, plus `stop()` to end its child process. */
export function irohLinkCarrier(
  options: IrohLinkCarrierOptions = {},
): LinkCarrierKind & { stop(): Promise<void>; endpoint(): Promise<IrohEndpoint> } {
  let daemon: LinkDaemon | null = null;
  const start = () =>
    daemon ??= new LinkDaemon(
      options.binary ?? defaultLinkBinary(),
      !!options.local,
      options.relay,
    );
  return {
    kind: "iroh",
    // An endpoint id plus relay URL identifies the hub and reveals no IP address. A local
    // endpoint carries loopback addresses, which mean nothing off this machine.
    publishable: true,
    async listen(accept) {
      const running = start();
      running.onIncoming(accept);
      const endpoint = await running.ready;
      return options.local
        ? { id: endpoint.id, addrs: endpoint.addrs }
        : { id: endpoint.id, relay: endpoint.relay };
    },
    async connect(endpoint) {
      const running = start();
      await running.ready;
      return await running.connect(endpoint as IrohEndpoint);
    },
    endpoint: () => start().ready,
    async stop() {
      const running = daemon;
      daemon = null;
      await running?.stop();
    },
  };
}
