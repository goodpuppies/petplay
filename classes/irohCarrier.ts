/**
 * Iroh as this process's stageforge remote carrier: how actors in other processes reach the
 * actors here once a topic record names them (`PostalService.registerRemoteCarrier`).
 *
 * One `petplay-media link` child per process owns two iroh endpoints (see
 * submodules/petplay_mediatransport/src/link.rs):
 * - A relay-only **discovery** endpoint (published as `{id, relay}` on the topic server; binds no
 *   UDP socket and leaks zero IP addresses, mitigating iroh#3535).
 * - A lazy **direct** P2P endpoint (never published; full QUIC holepunching, guarded by an
 *   `EndpointHooks::after_handshake` allowlist). Peers only learn it over the encrypted discovery
 *   link after the user trusts them.
 *
 * `local: true` binds loopback with no relay, for tests on one machine; its endpoint carries
 * loopback addresses instead of a relay.
 */
import type { Carrier, CarrierTier, RemoteCarrierKind } from "../submodules/stageforge/mod.ts";
import {
  decodeWebSocketWorkerMessage,
  encodeWebSocketWorkerMessage,
} from "../submodules/stageforge/src/lib/webSocketWorkerCodec.ts";
import { petplayMediaPath } from "./petplayMediaPath.ts";

export type IrohEndpoint = { id: string; relay?: string | null; addrs?: string[] };

/** The network path a link connection currently uses (link.rs `path` events). */
export type IrohPath = {
  /** `direct`: UDP between the two machines (holepunched or LAN); `relay`: through the relay. */
  path: "direct" | "relay";
  remote: string;
  rttMs: number;
  /** Every open path (`ip:<addr>` or `relay:<url>`, as is `remote`). */
  open: string[];
  since: number;
};

export type IrohConnectionInfo = {
  conn: number;
  peer: string;
  tier: CarrierTier;
  path: IrohPath | null;
};

export type IrohCarrierOptions = {
  /** `petplay-media` built with `--features iroh`. Default: PETPLAY_LINK_BINARY, else the release build. */
  binary?: string;
  local?: boolean;
  /** Use this relay instead of n0's public ones (self-hosted, or `iroh-relay --dev` in tests). */
  relay?: string;
};

type Event =
  | { ev: "ready"; id: string; relay: string | null; addrs: string[] }
  | { ev: "direct_ready"; req: number; id: string; relay: string | null; addrs: string[] }
  | { ev: "connected"; req: number; conn: number; peer?: string; tier?: CarrierTier }
  | { ev: "failed"; req: number; error: string }
  | { ev: "incoming"; conn: number; peer: string; tier?: CarrierTier }
  | { ev: "data"; conn: number; data: string }
  | {
    ev: "path";
    conn: number;
    path: "direct" | "relay";
    remote: string;
    rtt_ms: number;
    open: string[];
  }
  | { ev: "closed"; conn: number; reason: string };

class IrohCarrier implements Carrier {
  onclose: ((reason?: string) => void) | null = null;
  #onmessage: ((data: unknown) => void) | null = null;
  #queue: unknown[] = [];
  #closed = false;
  path: IrohPath | null = null;
  constructor(
    private readonly daemon: LinkDaemon,
    readonly conn: number,
    readonly peer: string,
    readonly tier: CarrierTier,
  ) {}
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
  #directRequests = new Map<
    number,
    { resolve: (ep: IrohEndpoint) => void; reject: (e: Error) => void }
  >();
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
      for (const pending of this.#directRequests.values()) pending.reject(new Error(reason));
      this.#directRequests.clear();
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

  connections(): IrohConnectionInfo[] {
    return [...this.#carriers.values()].map((carrier) => ({
      conn: carrier.conn,
      peer: carrier.peer,
      tier: carrier.tier,
      path: carrier.path,
    }));
  }

  connect(endpoint: IrohEndpoint, tier: CarrierTier = "discovery"): Promise<IrohCarrier> {
    const req = this.#nextReq++;
    return new Promise((resolve, reject) => {
      this.#requests.set(req, { resolve, reject });
      this.command({ op: "connect", req, endpoint, tier });
    });
  }

  directEndpoint(): Promise<IrohEndpoint> {
    const req = this.#nextReq++;
    return new Promise((resolve, reject) => {
      this.#directRequests.set(req, { resolve, reject });
      this.command({ op: "direct_endpoint", req });
    });
  }

  allowDirect(peer: string): void {
    this.command({ op: "allow_direct", peer });
  }

  revokeDirect(peer: string): void {
    this.command({ op: "revoke_direct", peer });
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
      case "direct_ready": {
        const pending = this.#directRequests.get(event.req);
        this.#directRequests.delete(event.req);
        pending?.resolve({ id: event.id, relay: event.relay, addrs: event.addrs });
        return;
      }
      case "connected": {
        const pending = this.#requests.get(event.req);
        this.#requests.delete(event.req);
        const carrier = new IrohCarrier(
          this,
          event.conn,
          event.peer ?? "",
          event.tier ?? "discovery",
        );
        this.#carriers.set(event.conn, carrier);
        pending?.resolve(carrier);
        return;
      }
      case "failed": {
        const pending = this.#requests.get(event.req);
        if (pending) {
          this.#requests.delete(event.req);
          pending.reject(new Error(event.error));
          return;
        }
        const directPending = this.#directRequests.get(event.req);
        if (directPending) {
          this.#directRequests.delete(event.req);
          directPending.reject(new Error(event.error));
        }
        return;
      }
      case "incoming": {
        const carrier = new IrohCarrier(
          this,
          event.conn,
          event.peer,
          event.tier ?? "discovery",
        );
        this.#carriers.set(event.conn, carrier);
        if (this.#accept) this.#accept(carrier);
        else carrier.close("not accepting connections");
        return;
      }
      case "data":
        this.#carriers.get(event.conn)?.receive(event.data);
        return;
      case "path": {
        const carrier = this.#carriers.get(event.conn);
        if (!carrier) return;
        const previous = carrier.path?.path;
        carrier.path = {
          path: event.path,
          remote: event.remote,
          rttMs: event.rtt_ms,
          open: event.open,
          since: Date.now(),
        };
        if (previous !== event.path) {
          console.log(
            `[iroh] ${carrier.tier} link to ${
              carrier.peer.slice(0, 10)
            } is ${event.path} via ${event.remote} (rtt ${event.rtt_ms} ms)`,
          );
        }
        return;
      }
      case "closed":
        this.#carriers.get(event.conn)?.ended(event.reason);
        this.#carriers.delete(event.conn);
        return;
    }
  }
}

export function defaultLinkBinary(): string {
  return petplayMediaPath({ forLink: true });
}

/** The iroh remote carrier, plus `stop()` to end its child process. */
export function irohCarrier(
  options: IrohCarrierOptions = {},
): Omit<RemoteCarrierKind, "directEndpoint" | "allowDirect" | "revokeDirect" | "connectDirect"> & {
  stop(): Promise<void>;
  endpoint(): Promise<IrohEndpoint>;
  directEndpoint(): Promise<IrohEndpoint>;
  connections(): IrohConnectionInfo[];
  allowDirect(peerId: string): void;
  revokeDirect(peerId: string): void;
  connectDirect(endpoint: IrohEndpoint): Promise<Carrier>;
} {
  let daemon: LinkDaemon | null = null;
  const start = () =>
    daemon ??= new LinkDaemon(
      options.binary ?? defaultLinkBinary(),
      !!options.local,
      options.relay,
    );
  const publishableEndpoint = (endpoint: IrohEndpoint): IrohEndpoint =>
    options.local
      ? { id: endpoint.id, addrs: endpoint.addrs }
      : { id: endpoint.id, relay: endpoint.relay };
  return {
    kind: "iroh",
    // An endpoint id plus relay URL identifies the process and reveals no IP address. A local
    // endpoint carries loopback addresses, which mean nothing off this machine.
    publishable: true,
    async listen(accept) {
      const running = start();
      running.onIncoming(accept);
      const endpoint = await running.ready;
      return publishableEndpoint(endpoint);
    },
    async connect(endpoint) {
      const running = start();
      await running.ready;
      return await running.connect(endpoint as IrohEndpoint, "discovery");
    },
    async directEndpoint() {
      const running = start();
      await running.ready;
      const endpoint = await running.directEndpoint();
      // Only trusted peers get this, over the encrypted discovery link, so it carries the IP
      // candidates holepunching starts from (the discovery endpoint stays address-free).
      return {
        id: endpoint.id,
        relay: options.local ? undefined : endpoint.relay,
        addrs: (endpoint.addrs ?? []).filter((addr) => !/^\[fe80:/i.test(addr)),
      };
    },
    allowDirect(peerId: string) {
      start().allowDirect(peerId);
    },
    revokeDirect(peerId: string) {
      start().revokeDirect(peerId);
    },
    async connectDirect(endpoint) {
      const running = start();
      await running.ready;
      return await running.connect(endpoint as IrohEndpoint, "direct");
    },
    endpoint: () => start().ready,
    /** Each open link connection and the network path it uses, for diagnostics. */
    connections: () => daemon?.connections() ?? [],
    async stop() {
      const running = daemon;
      daemon = null;
      await running?.stop();
    },
  };
}
