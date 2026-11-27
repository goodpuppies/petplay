/**
 * PetPlay's connection to VRChat over OSC + OSCQuery, done the way OscGoesPurrr's
 * `vrchat_osc.py` does it (itself modelled on VRCFaceTracking's OscQueryService):
 *
 * 1. Discovery first. Browse `_oscjson._tcp.local` and bind nothing, advertise nothing, until
 *    VRChat's own record is on the bus.
 * 2. Then bind the OSC UDP listener and the OSCQuery HTTP server on 127.0.0.1, both on ports the
 *    OS picks, and publish `_oscjson._tcp` + `_osc._udp` at 127.0.0.1 under a per-launch name
 *    (`PetPlay-AB12CD`), so VRChat can never reuse a port it cached from an earlier run.
 *    Loopback, never 0.0.0.0: on Windows a 0.0.0.0 socket can share a port with another
 *    program's 127.0.0.1 socket without any error, and that program then gets every datagram.
 * 3. Connect: read VRChat's UDP port from its `?HOST_INFO` and send a handshake ping from the
 *    listener's own socket.
 * 4. Stay honest: VRChat's mDNS goodbye, or its HTTP server missing two health checks in a row,
 *    disconnects. A second VRChat record (a crashed VRChat's leftover) takes over only if it
 *    answers and ours no longer does. While disconnected, the bus is queried every 5 s.
 * 5. Watch the data, not the handshake: connected but no packet for 15 s is logged; at 45 s the
 *    handshake ping is re-sent; at 75 s the advertisement is withdrawn and re-published under a
 *    fresh name so VRChat re-reads it; both repeat every 5 min while the silence lasts.
 *
 * `stop()` says goodbye on mDNS, so VRChat drops the record instead of polling a dead port.
 */
import { type BrowsedService, type BrowseEvent, Mdns, type MdnsService } from "./mdns.ts";
import { encodeOscMessage, type OscMessage, type OscOutboundArg, parseOscPacket } from "./osc.ts";

export type { OscMessage, OscOutboundArg } from "./osc.ts";

export const OSCJSON_TYPE = "_oscjson._tcp.local";
export const OSC_UDP_TYPE = "_osc._udp.local";
const LOOPBACK = "127.0.0.1";
/** VRChat's OSC input port, until its `?HOST_INFO` says otherwise. */
export const VRCHAT_DEFAULT_OSC_PORT = 9000;

// OscGoesPurrr's timings (vrchat_osc.py).
const BROWSER_REFRESH_MS = 5_000;
const HEALTH_INTERVAL_MS = 5_000;
const HEALTH_TIMEOUT_MS = 1_500;
const CONNECT_TIMEOUT_MS = 2_000;
const DIAG_LOG_INTERVAL_MS = 30_000;
const SILENT_THRESHOLD_MS = 15_000;
const SILENT_REPROBE_MS = 45_000;
const SILENT_REREGISTER_MS = 75_000;
const SILENT_RETRY_INTERVAL_MS = 300_000;
const CONNECT_GRACE_MS = 5_000;
/** "Receiving" in the status: a packet within this long. */
const RECEIVING_WINDOW_MS = 5_000;
const SUFFIX_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SUFFIX_LENGTH = 6;
const MAX_EVENTS = 200;

export type OscQueryNode = {
  FULL_PATH: string;
  ACCESS?: number;
  TYPE?: string;
  DESCRIPTION?: string;
  CONTENTS?: Record<string, OscQueryNode>;
};

export type VrchatLinkOptions = {
  /** Base of the per-launch service name: `PetPlay` advertises as `PetPlay-AB12CD`. */
  serviceBase: string;
  /** DESCRIPTION of the root node we serve. */
  description?: string;
  /**
   * Nodes to serve beside `/avatar/change`. Listing any `/avatar` node is what makes VRChat
   * stream every avatar parameter to us; `/avatar/change` is always there for that.
   */
  contents?: Record<string, OscQueryNode>;
  /** Every OSC message received; `packet` numbers the datagrams, so a bundle's messages share one. */
  onMessage: (message: OscMessage, packet: number) => void;
  log?: (message: string) => void;
  /** Which `_oscjson._tcp` instances are VRChat. Default: names containing `VRChat`, as OGP does. */
  vrchatPattern?: RegExp;
};

export type VrchatLinkStatus = {
  /** start() was called and stop() was not. */
  running: boolean;
  mdnsListening: boolean;
  /** The UDP listener and HTTP server are bound and advertised (VRChat was seen at least once). */
  advertised: boolean;
  /** VRChat answered its `?HOST_INFO` and has not gone away since. */
  connected: boolean;
  /** A packet arrived within the last 5 s. */
  receiving: boolean;
  /** Connected for 15 s or more without a single packet. */
  silent: boolean;
  serviceName: string | null;
  oscPort: number | null;
  httpPort: number | null;
  vrchatName: string | null;
  vrchatHttpPort: number | null;
  vrchatOscPort: number;
  httpRequests: number;
  packets: number;
  lastPacketAgeMs: number | null;
  connectedForMs: number | null;
  readvertiseCount: number;
  /** Recent diagnostic lines, oldest first. */
  events: string[];
};

export class VrchatOscQueryLink {
  private mdns: Mdns | null = null;
  private oscSocket: Deno.DatagramConn | null = null;
  private httpServer: Deno.HttpServer<Deno.NetAddr> | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private discovery: Promise<void> = Promise.resolve();
  private shutdown = true;

  private serviceName: string | null = null;
  private oscPort: number | null = null;
  private httpPort: number | null = null;

  private connected = false;
  private vrchatName: string | null = null;
  private vrchatHttpPort: number | null = null;
  private vrchatOscPort = VRCHAT_DEFAULT_OSC_PORT;
  private connectedSince: number | null = null;
  private advertisingSince: number | null = null;

  private httpRequests = 0;
  private packets = 0;
  private lastPacketAt: number | null = null;
  private firstPacketLogged = false;
  private handlerErrors = 0;
  private packetsAtLastWatch = 0;
  private packetsAtLastDiag = 0;
  private silentWarned = false;
  private lastReprobeAt: number | null = null;
  private lastReregisterAt: number | null = null;
  private readvertiseCount = 0;
  private healthFailures = 0;
  private healthBusy = false;
  private refreshCycles = 0;
  private readonly failedConnects = new Set<string>();
  private readonly otherClients = new Set<string>();
  private readonly events: string[] = [];

  constructor(private readonly options: VrchatLinkOptions) {}

  get running(): boolean {
    return !this.shutdown;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Where to send OSC to VRChat, once our listener is bound. */
  get controlEndpoint(): { hostname: string; port: number } | null {
    return this.oscSocket ? { hostname: LOOPBACK, port: this.vrchatOscPort } : null;
  }

  async start(): Promise<void> {
    if (!this.shutdown) return;
    this.shutdown = false;
    this.log(
      `start(): deferred bind, as VRCFaceTracking and OscGoesPurrr do: nothing is bound or ` +
        `advertised until VRChat appears on mDNS`,
    );
    await this.startMdns();
    this.timers.push(setInterval(() => void this.refreshTick(), BROWSER_REFRESH_MS));
    this.timers.push(setInterval(() => {
      void this.healthTick();
      this.watchdogTick();
    }, HEALTH_INTERVAL_MS));
    this.timers.push(setInterval(() => this.diagnosticsTick(), DIAG_LOG_INTERVAL_MS));
  }

  /** Says goodbye on mDNS and closes every socket. */
  async stop(): Promise<void> {
    if (this.shutdown) return;
    this.shutdown = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.connected) this.disconnect("stopped");
    const mdns = this.mdns;
    this.mdns = null;
    await mdns?.stop().catch(() => {});
    try {
      this.oscSocket?.close();
    } catch {
      // Already closed.
    }
    this.oscSocket = null;
    await this.httpServer?.shutdown().catch(() => {});
    this.httpServer = null;
    this.serviceName = null;
    this.oscPort = null;
    this.httpPort = null;
    this.advertisingSince = null;
    this.log("stopped");
  }

  /** Sends one OSC message to VRChat from our listener's socket. False while nothing is bound. */
  send(address: string, args: OscOutboundArg[]): boolean {
    const socket = this.oscSocket;
    if (!socket) return false;
    void socket.send(encodeOscMessage(address, args), {
      hostname: LOOPBACK,
      port: this.vrchatOscPort,
      transport: "udp",
    }).catch(() => {});
    return true;
  }

  /**
   * Withdraws the advertisement and publishes it again under a fresh name, so VRChat treats us
   * as a new client and reads our HOST_INFO again (OscGoesPurrr's `reregister_mdns`).
   */
  async reannounce(): Promise<boolean> {
    if (!this.mdns || this.oscPort == null || this.httpPort == null) {
      this.log("re-announce skipped: VRChat has not been seen yet, so nothing is advertised");
      if (this.connected === false) void this.refreshTick();
      return false;
    }
    this.readvertiseCount++;
    const old = this.serviceName;
    await this.mdns.unpublish();
    this.serviceName = makeServiceName(this.options.serviceBase);
    this.log(`re-advertising as ${this.serviceName} (was ${old}, cycle #${this.readvertiseCount})`);
    await delay(500);
    await this.advertise();
    this.advertisingSince = Date.now();
    return true;
  }

  status(): VrchatLinkStatus {
    const now = Date.now();
    return {
      running: this.running,
      mdnsListening: this.mdns?.listening ?? false,
      advertised: this.serviceName != null,
      connected: this.connected,
      receiving: this.lastPacketAt != null && now - this.lastPacketAt < RECEIVING_WINDOW_MS,
      silent: this.silentWarned,
      serviceName: this.serviceName,
      oscPort: this.oscPort,
      httpPort: this.httpPort,
      vrchatName: this.vrchatName,
      vrchatHttpPort: this.connected ? this.vrchatHttpPort : null,
      vrchatOscPort: this.vrchatOscPort,
      httpRequests: this.httpRequests,
      packets: this.packets,
      lastPacketAgeMs: this.lastPacketAt == null ? null : now - this.lastPacketAt,
      connectedForMs: this.connectedSince == null ? null : now - this.connectedSince,
      readvertiseCount: this.readvertiseCount,
      events: this.events.slice(-40),
    };
  }

  // -- discovery --------------------------------------------------------------------------------

  private async startMdns(): Promise<void> {
    if (this.mdns || this.shutdown) return;
    const mdns = new Mdns((message) => this.log(message));
    try {
      await mdns.start();
    } catch (error) {
      if (this.refreshCycles <= 1) {
        this.log(
          `mDNS unavailable (${messageOf(error)}); retrying every ${BROWSER_REFRESH_MS / 1000} s`,
        );
      }
      return;
    }
    if (this.shutdown) {
      await mdns.stop();
      return;
    }
    this.mdns = mdns;
    mdns.browse(OSCJSON_TYPE, (event) => this.queueBrowseEvent(event));
  }

  /**
   * While disconnected: ask the bus again and re-offer every VRChat record already known, like
   * OscGoesPurrr rebuilding its ServiceBrowser (a new browser reports every cached service).
   */
  private async refreshTick(): Promise<void> {
    if (this.shutdown || this.connected) {
      this.refreshCycles = 0;
      return;
    }
    this.refreshCycles++;
    if (!this.mdns) await this.startMdns();
    const mdns = this.mdns;
    if (!mdns) return;
    await mdns.query(OSCJSON_TYPE);
    for (const service of mdns.known(OSCJSON_TYPE)) {
      if (this.isVrchat(service)) this.queueBrowseEvent({ kind: "added", service });
    }
    if (this.refreshCycles === 1 || this.refreshCycles % 6 === 0) {
      this.log(`mDNS browser refreshed (cycle #${this.refreshCycles}): still waiting for VRChat`);
    }
  }

  private queueBrowseEvent(event: BrowseEvent): void {
    this.discovery = this.discovery
      .then(() => this.handleBrowseEvent(event))
      .catch((error) => this.log(`discovery step failed: ${messageOf(error)}`));
  }

  private async handleBrowseEvent(event: BrowseEvent): Promise<void> {
    if (this.shutdown) return;
    const service = event.service;
    if (!this.isVrchat(service)) {
      if (event.kind !== "removed" && !this.otherClients.has(service.fullName)) {
        this.otherClients.add(service.fullName);
        if (service.instance !== this.serviceName) {
          this.log(`other OSCQuery client present: ${service.instance} port=${service.port}`);
        }
      }
      return;
    }
    if (event.kind === "removed") {
      this.log(`VRChat mDNS removed: ${service.instance}`);
      this.disconnect("VRChat mDNS service removed", { onlyName: service.fullName });
      return;
    }
    if (
      this.connected && service.fullName === this.vrchatName && service.port === this.vrchatHttpPort
    ) return;

    if (!this.failedConnects.has(service.fullName)) {
      this.log(
        `VRChat OSCQuery service discovered: ${service.instance} port=${service.port} ` +
          `addresses=[${service.addresses.join(", ")}]`,
      );
    }
    if (this.connected) {
      // A second VRChat record while connected. A crashed VRChat's record can linger for hours
      // next to the live game; switch only when the new one answers and ours no longer does
      // (VRChat crashed and came back before the health check noticed).
      const current = this.vrchatHttpPort;
      if (!(await answers(service.port))) {
        this.log(
          `ignoring ${service.instance}: its OSCQuery server doesn't answer (left over from an earlier VRChat?)`,
        );
        return;
      }
      if (current != null && await answers(current)) {
        this.log(
          `ignoring ${service.instance}: still connected to ${
            shortName(this.vrchatName)
          }, which answers`,
        );
        return;
      }
      this.disconnect(`VRChat was restarted (${service.instance})`, { onlyPort: current });
    }
    if (this.oscSocket == null) {
      try {
        await this.bindAndAdvertise();
      } catch (error) {
        this.log(`setup after discovering VRChat failed: ${messageOf(error)}`);
        await this.releaseSockets();
        return;
      }
    }
    await this.connectTo(service);
  }

  /** VRCFaceTracking's FirstClientDiscovered: bind on loopback, then advertise. Once per start(). */
  private async bindAndAdvertise(): Promise<void> {
    this.serviceName = makeServiceName(this.options.serviceBase);
    this.log(`VRChat observed on the bus: binding sockets and advertising as ${this.serviceName}`);
    const socket = Deno.listenDatagram({ hostname: LOOPBACK, port: 0, transport: "udp" });
    this.oscSocket = socket;
    this.oscPort = (socket.addr as Deno.NetAddr).port;
    this.log(`OSC UDP listener bound to ${LOOPBACK}:${this.oscPort}`);
    void this.receiveLoop(socket);

    const server = Deno.serve(
      { hostname: LOOPBACK, port: 0, onListen: () => {} },
      (request) => this.handleHttp(request),
    );
    this.httpServer = server;
    this.httpPort = server.addr.port;
    this.log(`OSCQuery HTTP server on ${LOOPBACK}:${this.httpPort}`);

    await this.advertise();
    this.advertisingSince = Date.now();
  }

  private async releaseSockets(): Promise<void> {
    try {
      this.oscSocket?.close();
    } catch {
      // Already closed.
    }
    this.oscSocket = null;
    await this.httpServer?.shutdown().catch(() => {});
    this.httpServer = null;
    await this.mdns?.unpublish().catch(() => {});
    this.serviceName = null;
    this.oscPort = null;
    this.httpPort = null;
  }

  private async advertise(): Promise<void> {
    const mdns = this.mdns;
    if (!mdns || !this.serviceName || this.oscPort == null || this.httpPort == null) return;
    const host = `${this.serviceName}.local`;
    const services: MdnsService[] = [
      {
        instance: this.serviceName,
        type: OSCJSON_TYPE,
        port: this.httpPort,
        host,
        address: LOOPBACK,
      },
      {
        instance: this.serviceName,
        type: OSC_UDP_TYPE,
        port: this.oscPort,
        host,
        address: LOOPBACK,
      },
    ];
    await mdns.publish(services);
    this.log(
      `mDNS advertised ${this.serviceName}: ${OSCJSON_TYPE} -> ${LOOPBACK}:${this.httpPort}, ` +
        `${OSC_UDP_TYPE} -> ${LOOPBACK}:${this.oscPort}`,
    );
  }

  /** Reads VRChat's UDP port from its HOST_INFO; the record becomes ours only once that answers. */
  private async connectTo(service: BrowsedService): Promise<void> {
    const socket = this.oscSocket;
    if (!socket || this.shutdown) return;
    const quiet = this.failedConnects.has(service.fullName);
    let hostInfo: { OSC_PORT?: unknown } | null = null;
    try {
      const response = await fetch(`http://${LOOPBACK}:${service.port}/?HOST_INFO`, {
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      });
      if (response.ok) hostInfo = await response.json();
      else {
        await response.body?.cancel();
        if (!quiet) this.log(`VRChat HOST_INFO returned HTTP ${response.status}`);
      }
    } catch (error) {
      if (!quiet) {
        this.log(`could not read VRChat's HOST_INFO on port ${service.port}: ${messageOf(error)}`);
      }
    }
    if (!hostInfo || this.shutdown || this.oscSocket !== socket) {
      this.failedConnects.add(service.fullName);
      return;
    }
    this.failedConnects.delete(service.fullName);
    const port = Number(hostInfo.OSC_PORT);
    this.vrchatOscPort = Number.isInteger(port) && port > 0 && port < 65536
      ? port
      : VRCHAT_DEFAULT_OSC_PORT;
    this.vrchatHttpPort = service.port;
    this.vrchatName = service.fullName;
    this.connected = true;
    this.connectedSince = Date.now();
    this.silentWarned = false;
    this.lastReprobeAt = null;
    this.lastReregisterAt = null;
    this.firstPacketLogged = false;
    this.healthFailures = 0;
    this.log(
      `connected to ${service.instance}: VRChat OSC port ${this.vrchatOscPort}, ours ${this.oscPort}`,
    );
    this.sendPing("handshake ping");
  }

  private sendPing(what: string): void {
    const address = `/${this.options.serviceBase}/ping`;
    if (this.send(address, [true])) {
      this.log(
        `sent ${what} ${address} to ${LOOPBACK}:${this.vrchatOscPort} from ${LOOPBACK}:${this.oscPort}`,
      );
    }
  }

  private disconnect(
    reason: string,
    only: { onlyName?: string; onlyPort?: number | null } = {},
  ): void {
    if (!this.connected) return;
    if (only.onlyName != null && only.onlyName !== this.vrchatName) {
      this.log(
        `keeping the connection to ${shortName(this.vrchatName)}: ${reason} was about ${
          shortName(only.onlyName)
        }`,
      );
      return;
    }
    if (only.onlyPort != null && only.onlyPort !== this.vrchatHttpPort) {
      this.log(
        `keeping the connection on HTTP port ${this.vrchatHttpPort}: ${reason} was about port ${only.onlyPort}`,
      );
      return;
    }
    const session = this.connectedSince == null ? 0 : (Date.now() - this.connectedSince) / 1000;
    const last = this.lastPacketAt == null
      ? "never"
      : `${((Date.now() - this.lastPacketAt) / 1000).toFixed(1)}s ago`;
    this.log(
      `disconnecting (${reason}): session=${session.toFixed(1)}s packets=${this.packets} ` +
        `last_packet=${last} http_requests=${this.httpRequests}`,
    );
    this.connected = false;
    this.vrchatName = null;
    this.connectedSince = null;
    this.silentWarned = false;
    this.lastReprobeAt = null;
    this.lastReregisterAt = null;
  }

  // -- health and watchdog ----------------------------------------------------------------------

  /** VRChat's OSCQuery server must answer; two misses in a row mean it is gone. */
  private async healthTick(): Promise<void> {
    if (this.healthBusy) return;
    const port = this.vrchatHttpPort;
    if (!this.connected || port == null) {
      this.healthFailures = 0;
      return;
    }
    this.healthBusy = true;
    try {
      if (await answers(port, HEALTH_TIMEOUT_MS)) {
        if (this.healthFailures > 0) {
          this.log(`health check recovered after ${this.healthFailures} miss(es)`);
        }
        this.healthFailures = 0;
        return;
      }
      this.healthFailures++;
      if (this.healthFailures <= 2) {
        this.log(
          `health check: VRChat's OSCQuery server on ${port} did not answer (${this.healthFailures} in a row)`,
        );
      }
      if (this.healthFailures >= 2) {
        this.disconnect("OSCQuery HTTP unreachable", { onlyPort: port });
        this.healthFailures = 0;
      }
    } finally {
      this.healthBusy = false;
    }
  }

  /** "Connected" is VRChat's word; packets are the proof. */
  private watchdogTick(): void {
    const now = Date.now();
    const delta = this.packets - this.packetsAtLastWatch;
    this.packetsAtLastWatch = this.packets;
    if (
      !this.connected || this.connectedSince == null || now - this.connectedSince < CONNECT_GRACE_MS
    ) return;
    const anchor = Math.max(
      this.lastPacketAt ?? 0,
      this.advertisingSince ?? 0,
      this.connectedSince,
    );
    const silentFor = now - anchor;
    if (delta === 0 && silentFor >= SILENT_THRESHOLD_MS) {
      if (!this.silentWarned) {
        this.silentWarned = true;
        this.log(
          `WARNING: connected to VRChat but no OSC packet for ${(silentFor / 1000).toFixed(0)}s. ` +
            `Is OSC on in VRChat's Action Menu? Will re-ping at ${SILENT_REPROBE_MS / 1000}s and ` +
            `re-advertise under a fresh name at ${SILENT_REREGISTER_MS / 1000}s.`,
        );
      }
      const due = (last: number | null) => last == null || now - last >= SILENT_RETRY_INTERVAL_MS;
      if (silentFor >= SILENT_REPROBE_MS && due(this.lastReprobeAt)) {
        this.lastReprobeAt = now;
        this.sendPing("silent-connection re-ping");
      }
      if (silentFor >= SILENT_REREGISTER_MS && due(this.lastReregisterAt)) {
        this.lastReregisterAt = now;
        this.log("still silent: re-publishing mDNS under a fresh name");
        void this.reannounce();
      }
    } else if (delta > 0 && this.silentWarned) {
      this.log(`packet flow restored (${delta} packets in the last ${HEALTH_INTERVAL_MS / 1000}s)`);
      this.silentWarned = false;
      this.lastReprobeAt = null;
      this.lastReregisterAt = null;
    }
  }

  private diagnosticsTick(): void {
    const delta = this.packets - this.packetsAtLastDiag;
    this.packetsAtLastDiag = this.packets;
    if (!this.connected) return;
    const last = this.lastPacketAt == null
      ? "never"
      : `${((Date.now() - this.lastPacketAt) / 1000).toFixed(1)}s ago`;
    this.log(
      `diagnostics: packets_last_${DIAG_LOG_INTERVAL_MS / 1000}s=${delta} ` +
        `(${
          (delta / (DIAG_LOG_INTERVAL_MS / 1000)).toFixed(1)
        }/s) total=${this.packets} last_packet=${last} ` +
        `http_requests=${this.httpRequests} handler_errors=${this.handlerErrors}`,
    );
  }

  // -- serving ----------------------------------------------------------------------------------

  private async receiveLoop(socket: Deno.DatagramConn): Promise<void> {
    try {
      for await (const [data] of socket) {
        const packet = ++this.packets;
        this.lastPacketAt = Date.now();
        const messages = parseOscPacket(data);
        if (!this.firstPacketLogged && messages.length > 0) {
          this.firstPacketLogged = true;
          this.log(`first OSC packet this session: ${messages[0].address}`);
        }
        for (const message of messages) {
          try {
            this.options.onMessage(message, packet);
          } catch (error) {
            if (++this.handlerErrors <= 5) {
              this.log(`OSC handler failed for ${message.address}: ${messageOf(error)}`);
            }
          }
        }
      }
    } catch {
      // Closed by stop().
    }
  }

  private handleHttp(request: Request): Response {
    this.httpRequests++;
    const url = new URL(request.url);
    if (this.httpRequests <= 3) {
      this.log(`OSCQuery GET #${this.httpRequests} ${url.pathname}${url.search}`);
    }
    // ?HOST_INFO as a query, or /HOST_INFO as a path: both appear in the wild.
    if (`${url.pathname}${url.search}`.toUpperCase().includes("HOST_INFO")) {
      return json(this.hostInfo());
    }
    const tree = this.tree();
    if (url.pathname === "/" || url.pathname === "" || url.pathname === "/index") return json(tree);
    const node = findNode(tree, url.pathname);
    return node ? json(node) : json({ error: "not found" }, 404);
  }

  private hostInfo() {
    return {
      NAME: this.serviceName,
      EXTENSIONS: { ACCESS: true, CLIPMODE: false, RANGE: true, TYPE: true, VALUE: true },
      OSC_IP: LOOPBACK,
      OSC_PORT: this.oscPort,
      OSC_TRANSPORT: "UDP",
    };
  }

  private tree(): OscQueryNode {
    const extra = { ...(this.options.contents ?? {}) };
    const avatar = extra.avatar;
    delete extra.avatar;
    return {
      FULL_PATH: "/",
      ACCESS: 0,
      DESCRIPTION: this.options.description ?? this.serviceName ?? this.options.serviceBase,
      CONTENTS: {
        avatar: {
          ...avatar,
          FULL_PATH: "/avatar",
          ACCESS: avatar?.ACCESS ?? 2,
          CONTENTS: {
            change: { FULL_PATH: "/avatar/change", TYPE: "s", ACCESS: 3 },
            ...(avatar?.CONTENTS ?? {}),
          },
        },
        ...extra,
      },
    };
  }

  private isVrchat(service: BrowsedService): boolean {
    return (this.options.vrchatPattern ?? /VRChat/).test(service.instance);
  }

  private log(message: string): void {
    const line = `${new Date().toISOString().slice(11, 19)}  ${message}`;
    this.events.push(line);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    try {
      this.options.log?.(message);
    } catch {
      // Logging must never break the link.
    }
  }
}

export function makeServiceName(base: string): string {
  let suffix = "";
  const random = crypto.getRandomValues(new Uint8Array(SUFFIX_LENGTH));
  for (const byte of random) suffix += SUFFIX_CHARS[byte % SUFFIX_CHARS.length];
  return `${base}-${suffix}`;
}

export function findNode(root: OscQueryNode, path: string): OscQueryNode | null {
  let node: OscQueryNode = root;
  for (const part of path.split("/").filter((p) => p.length > 0)) {
    const next = node.CONTENTS?.[part];
    if (!next) return null;
    node = next;
  }
  return node;
}

/** Does the OSCQuery server on this loopback port answer `/` right now? */
async function answers(port: number, timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
  try {
    const response = await fetch(`http://${LOOPBACK}:${port}/`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Pragma": "no-cache",
      "Cache-Control": "no-cache",
    },
  });
}

function shortName(fullName: string | null): string {
  return fullName ? fullName.split(".")[0] : "?";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
