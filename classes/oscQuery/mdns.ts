/**
 * The part of python-zeroconf that an OSCQuery client needs, on Deno sockets:
 *
 * - a responder: publishes service records, announces them, answers queries for them and says
 *   goodbye (TTL 0) when they are withdrawn;
 * - a browser: queries a service type and reports instances coming, changing and going.
 *
 * One listener on 0.0.0.0:5353 (shared with every other mDNS user on the machine through
 * SO_REUSEADDR) takes part in the multicast group on every IPv4 interface. Outgoing packets leave
 * from port 5353 on every interface, so a peer bound to any one of them hears them; mDNS
 * receivers drop responses that do not come from 5353 (RFC 6762 section 6). A failing interface
 * is skipped, never fatal.
 */
import {
  decodeDnsPacket,
  type DnsPacket,
  type DnsQuestion,
  type DnsRecord,
  encodeDnsPacket,
  FLAGS_RESPONSE,
  isResponse,
  normalizeName,
  sameName,
  TYPE_A,
  TYPE_ANY,
  TYPE_PTR,
  TYPE_SRV,
  TYPE_TXT,
} from "./dns.ts";

const MDNS_GROUP = "224.0.0.251";
const MDNS_PORT = 5353;
const SERVICES_META_TYPE = "_services._dns-sd._udp.local";
/** TTL of the records we publish. Short, so a record of ours left by a crash fades quickly. */
const RECORD_TTL_SECONDS = 120;
/** RFC 6762 section 6: the same record is multicast at most once per second. */
const MULTICAST_RECORD_INTERVAL_MS = 1_000;
/** An identical packet seen again within this window (other interface, loopback) is a copy. */
const DUPLICATE_WINDOW_MS = 500;
const SWEEP_INTERVAL_MS = 1_000;

export type MdnsService = {
  /** Instance label, e.g. `PetPlay-AB12CD`. */
  instance: string;
  /** Service type, e.g. `_oscjson._tcp.local`. */
  type: string;
  port: number;
  /** Host name the SRV record points at, e.g. `PetPlay-AB12CD.local`. */
  host: string;
  /** IPv4 address of `host`. */
  address: string;
  txt?: string[];
};

export type BrowsedService = {
  /** Instance label, e.g. `VRChat-Client-0A1B2C`. */
  instance: string;
  /** `<instance>.<type>`. */
  fullName: string;
  type: string;
  port: number;
  host: string;
  addresses: string[];
};

export type BrowseEvent = { kind: "added" | "updated" | "removed"; service: BrowsedService };

type BrowseEntry = {
  instance: string;
  fullName: string;
  type: string;
  port: number | null;
  host: string | null;
  ptrSeenAt: number;
  ptrTtlMs: number;
  refreshQueriedAt: number;
  srvQueriedAt: number;
  announced: boolean;
};

type Sender = { address: string; conn: Deno.DatagramConn };

export class Mdns {
  private listener: Deno.DatagramConn | null = null;
  private readonly senders = new Map<string, Sender>();
  private readonly failedInterfaces = new Set<string>();
  private published: MdnsService[] = [];
  private readonly browsers = new Map<string, (event: BrowseEvent) => void>();
  private readonly entries = new Map<string, BrowseEntry>();
  private readonly hostAddresses = new Map<string, { address: string; expiresAt: number }>();
  private readonly lastMulticast = new Map<string, number>();
  private readonly recentPackets = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly announceTimers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(private readonly log: (message: string) => void = () => {}) {}

  get listening(): boolean {
    return this.listener != null;
  }

  /** Binds the shared listener. Throws if 0.0.0.0:5353 cannot be bound at all. */
  async start(): Promise<void> {
    if (this.listener) return;
    this.stopped = false;
    const listener = Deno.listenDatagram({
      hostname: "0.0.0.0",
      port: MDNS_PORT,
      transport: "udp",
      reuseAddress: true,
    });
    this.listener = listener;
    const joined: string[] = [];
    await Promise.all(
      ipv4Addresses().map(async (address) => {
        try {
          const membership = await listener.joinMulticastV4(MDNS_GROUP, address);
          await membership.setLoopback(true).catch(() => {});
          joined.push(address);
        } catch {
          // An interface without multicast (or one going away) is not ours to fix.
        }
      }),
    );
    this.log(
      `mDNS listener on 0.0.0.0:${MDNS_PORT}, joined on ${joined.join(", ") || "no interface"}`,
    );
    void this.receiveLoop(listener);
    this.refreshSenders();
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  /** Withdraws what is published (goodbye packets), then closes every socket. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    await this.unpublish();
    this.stopped = true;
    if (this.sweepTimer != null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const timer of this.announceTimers) clearTimeout(timer);
    this.announceTimers.clear();
    for (const sender of this.senders.values()) closeQuietly(sender.conn);
    this.senders.clear();
    if (this.listener) closeQuietly(this.listener);
    this.listener = null;
    this.browsers.clear();
    this.entries.clear();
  }

  /**
   * Publishes `services` (replacing what was published) and announces them three times, a second
   * apart, as python-zeroconf's register_service does. Resolves after the first announcement.
   */
  async publish(services: MdnsService[]): Promise<void> {
    this.published = services.map((service) => ({ ...service }));
    for (const service of this.published) this.forgetMulticast(service);
    await this.announce(this.published);
    const announced = this.published;
    for (const delay of [1_000, 2_000]) {
      const timer = setTimeout(() => {
        this.announceTimers.delete(timer);
        if (!this.stopped && this.published === announced) void this.announce(announced);
      }, delay);
      this.announceTimers.add(timer);
    }
  }

  /** Sends goodbyes (TTL 0) for everything published and stops answering for it. */
  async unpublish(): Promise<void> {
    const withdrawn = this.published;
    this.published = [];
    if (withdrawn.length === 0 || this.stopped) return;
    for (let i = 0; i < 2; i++) {
      for (const service of withdrawn) {
        await this.multicast(encodeDnsPacket({
          flags: FLAGS_RESPONSE,
          answers: serviceRecords(service, 0),
        }));
      }
      if (i === 0) await delay(250);
    }
  }

  /** Reports instances of `type` to `onEvent`, and asks the network for them now. */
  browse(type: string, onEvent: (event: BrowseEvent) => void): void {
    this.browsers.set(normalizeName(type), onEvent);
    void this.query(type);
  }

  /** One PTR query for `type` (a fresh query burst, like rebuilding a zeroconf ServiceBrowser). */
  async query(type: string): Promise<void> {
    await this.multicast(encodeDnsPacket({ questions: [{ name: type, type: TYPE_PTR }] }));
  }

  /** The instances of `type` currently known. */
  known(type: string): BrowsedService[] {
    const out: BrowsedService[] = [];
    for (const entry of this.entries.values()) {
      if (sameName(entry.type, type) && entry.port != null) out.push(this.toService(entry));
    }
    return out;
  }

  // -- sockets ----------------------------------------------------------------------------------

  /** Opens a sender per IPv4 interface that has none, and closes those of vanished interfaces. */
  private refreshSenders(): void {
    if (this.stopped) return;
    const current = new Set(ipv4Addresses());
    for (const [address, sender] of this.senders) {
      if (!current.has(address)) {
        closeQuietly(sender.conn);
        this.senders.delete(address);
      }
    }
    for (const address of current) {
      if (this.senders.has(address)) continue;
      let conn: Deno.DatagramConn;
      try {
        conn = Deno.listenDatagram({
          hostname: address,
          port: MDNS_PORT,
          transport: "udp",
          reuseAddress: true,
        });
      } catch (error) {
        if (!this.failedInterfaces.has(address)) {
          this.failedInterfaces.add(address);
          this.log(`mDNS: no sender on ${address}:${MDNS_PORT} (${messageOf(error)})`);
        }
        continue;
      }
      const sender = { address, conn };
      this.senders.set(address, sender);
      void conn.joinMulticastV4(MDNS_GROUP, address)
        .then(async (membership) => {
          await membership.setTTL(255).catch(() => {});
          await membership.setLoopback(true).catch(() => {});
        })
        .catch(() => {});
      void this.receiveLoop(conn);
    }
  }

  private async multicast(packet: Uint8Array): Promise<void> {
    if (this.stopped) return;
    this.refreshSenders();
    const target = { hostname: MDNS_GROUP, port: MDNS_PORT, transport: "udp" as const };
    const sends = [...this.senders.values()].map((sender) => sender.conn.send(packet, target));
    if (sends.length === 0 && this.listener) sends.push(this.listener.send(packet, target));
    await Promise.allSettled(sends);
  }

  private async unicast(packet: Uint8Array, to: Deno.NetAddr): Promise<void> {
    const conn = this.listener ?? this.senders.values().next().value?.conn;
    if (!conn) return;
    await conn.send(packet, { hostname: to.hostname, port: to.port, transport: "udp" }).catch(
      () => {},
    );
  }

  private async receiveLoop(conn: Deno.DatagramConn): Promise<void> {
    try {
      for await (const [data, addr] of conn) {
        if (this.stopped) break;
        try {
          this.handlePacket(data, addr as Deno.NetAddr);
        } catch {
          // A malformed packet from anyone on the network must never stop the loop.
        }
      }
    } catch {
      // Closed (stop, or an interface going away).
    }
  }

  private handlePacket(data: Uint8Array, from: Deno.NetAddr): void {
    const now = Date.now();
    const key = fingerprint(data);
    const seen = this.recentPackets.get(key);
    if (seen != null && now - seen < DUPLICATE_WINDOW_MS) return;
    this.recentPackets.set(key, now);
    const packet = decodeDnsPacket(data);
    if (isResponse(packet)) this.handleResponse(packet, now);
    else this.handleQuery(packet, from, now);
  }

  // -- responder --------------------------------------------------------------------------------

  private handleQuery(packet: DnsPacket, from: Deno.NetAddr, now: number): void {
    if (this.published.length === 0 || packet.questions.length === 0) return;
    const answers: DnsRecord[] = [];
    const additionals: DnsRecord[] = [];
    for (const question of packet.questions) {
      for (const service of this.published) answerQuestion(question, service, answers, additionals);
    }
    const known = packet.answers;
    const fresh = dedupeRecords(answers).filter((record) => !knownAnswerCovers(known, record));
    if (fresh.length === 0) return;
    const extra = dedupeRecords(additionals).filter((a) =>
      !fresh.some((r) => recordKey(r) === recordKey(a))
    );

    if (from.port !== MDNS_PORT) {
      // Legacy unicast query (RFC 6762 section 6.7): answer the sender directly, echoing the
      // question and its id, with short TTLs.
      const short = (record: DnsRecord) => ({
        ...record,
        ttl: Math.min(record.ttl, 10),
        flush: false,
      });
      void this.unicast(
        encodeDnsPacket({
          id: packet.id,
          flags: FLAGS_RESPONSE,
          questions: packet.questions,
          answers: fresh.map(short),
          additionals: extra.map(short),
        }),
        from,
      );
      return;
    }
    if (packet.questions.some((question) => question.unicastResponse)) {
      void this.unicast(
        encodeDnsPacket({ flags: FLAGS_RESPONSE, answers: fresh, additionals: extra }),
        from,
      );
      return;
    }
    const due = fresh.filter((record) =>
      now - (this.lastMulticast.get(recordKey(record)) ?? 0) >= MULTICAST_RECORD_INTERVAL_MS
    );
    if (due.length === 0) return;
    for (const record of [...due, ...extra]) this.lastMulticast.set(recordKey(record), now);
    void this.multicast(
      encodeDnsPacket({ flags: FLAGS_RESPONSE, answers: due, additionals: extra }),
    );
  }

  /** One packet per service: its PTR first, the SRV/TXT/A it needs as additionals. */
  private async announce(services: MdnsService[]): Promise<void> {
    const now = Date.now();
    for (const service of services) {
      const [ptr, ...rest] = serviceRecords(service, RECORD_TTL_SECONDS);
      for (const record of [ptr, ...rest]) this.lastMulticast.set(recordKey(record), now);
      await this.multicast(
        encodeDnsPacket({ flags: FLAGS_RESPONSE, answers: [ptr], additionals: rest }),
      );
    }
  }

  private forgetMulticast(service: MdnsService): void {
    for (const record of serviceRecords(service, RECORD_TTL_SECONDS)) {
      this.lastMulticast.delete(recordKey(record));
    }
  }

  // -- browser ----------------------------------------------------------------------------------

  private handleResponse(packet: DnsPacket, now: number): void {
    if (this.browsers.size === 0) return;
    const records = [...packet.answers, ...packet.authorities, ...packet.additionals];
    for (const record of records) {
      if ("address" in record && record.type === TYPE_A) {
        this.hostAddresses.set(normalizeName(record.name), {
          address: record.address,
          expiresAt: now + record.ttl * 1000,
        });
      }
    }
    const touched = new Set<BrowseEntry>();
    for (const record of records) {
      if (record.type !== TYPE_PTR || !("target" in record) || "port" in record) continue;
      const type = normalizeName(record.name);
      if (!this.browsers.has(type)) continue;
      const fullName = normalizeName(record.target);
      const existing = this.entries.get(fullName);
      if (record.ttl === 0) {
        // Goodbye: RFC 6762 section 10.1 keeps it one more second; nothing here needs that grace.
        if (existing) this.remove(existing);
        continue;
      }
      const entry = existing ?? {
        instance:
          record.target.slice(0, Math.max(0, record.target.length - record.name.length - 1)) ||
          record.target.split(".")[0],
        fullName,
        type,
        port: null,
        host: null,
        ptrSeenAt: now,
        ptrTtlMs: record.ttl * 1000,
        refreshQueriedAt: 0,
        srvQueriedAt: 0,
        announced: false,
      };
      entry.ptrSeenAt = now;
      entry.ptrTtlMs = record.ttl * 1000;
      entry.refreshQueriedAt = 0;
      this.entries.set(fullName, entry);
      touched.add(entry);
    }
    for (const record of records) {
      if (record.type !== TYPE_SRV || !("port" in record)) continue;
      const entry = this.entries.get(normalizeName(record.name));
      if (!entry) continue;
      if (record.ttl === 0) {
        this.remove(entry);
        continue;
      }
      if (entry.port !== record.port || entry.host !== record.target) {
        entry.port = record.port;
        entry.host = record.target;
        touched.add(entry);
      }
    }
    for (const entry of touched) {
      if (!this.entries.has(entry.fullName)) continue;
      if (entry.port == null) {
        if (now - entry.srvQueriedAt > 1_000) {
          entry.srvQueriedAt = now;
          void this.multicast(
            encodeDnsPacket({ questions: [{ name: entry.fullName, type: TYPE_SRV }] }),
          );
        }
        continue;
      }
      const kind = entry.announced ? "updated" : "added";
      entry.announced = true;
      this.emit(entry.type, { kind, service: this.toService(entry) });
    }
  }

  private remove(entry: BrowseEntry): void {
    this.entries.delete(entry.fullName);
    if (entry.announced) this.emit(entry.type, { kind: "removed", service: this.toService(entry) });
  }

  private emit(type: string, event: BrowseEvent): void {
    try {
      this.browsers.get(type)?.(event);
    } catch (error) {
      this.log(`mDNS browse handler failed: ${messageOf(error)}`);
    }
  }

  private toService(entry: BrowseEntry): BrowsedService {
    const host = entry.host ?? "";
    const address = this.hostAddresses.get(normalizeName(host))?.address;
    return {
      instance: entry.instance,
      fullName: entry.fullName,
      type: entry.type,
      port: entry.port ?? 0,
      host,
      addresses: address ? [address] : [],
    };
  }

  /** Expires records past their TTL and re-queries at 80% of it, as zeroconf's cache does. */
  private sweep(): void {
    const now = Date.now();
    const refreshTypes = new Set<string>();
    for (const entry of [...this.entries.values()]) {
      const age = now - entry.ptrSeenAt;
      if (age >= entry.ptrTtlMs) {
        this.remove(entry);
      } else if (age >= entry.ptrTtlMs * 0.8 && entry.refreshQueriedAt === 0) {
        entry.refreshQueriedAt = now;
        refreshTypes.add(entry.type);
      }
    }
    for (const type of refreshTypes) void this.query(type);
    for (const [key, at] of this.recentPackets) {
      if (now - at > DUPLICATE_WINDOW_MS) this.recentPackets.delete(key);
    }
    for (const [host, cached] of this.hostAddresses) {
      if (cached.expiresAt < now) this.hostAddresses.delete(host);
    }
  }
}

/** PTR, SRV, TXT and A records for `service`, PTR first. */
export function serviceRecords(service: MdnsService, ttl: number): DnsRecord[] {
  const fullName = `${service.instance}.${service.type}`;
  return [
    { name: service.type, type: TYPE_PTR, ttl, target: fullName },
    { name: fullName, type: TYPE_SRV, ttl, flush: true, port: service.port, target: service.host },
    { name: fullName, type: TYPE_TXT, ttl, flush: true, entries: service.txt ?? ["txtvers=1"] },
    { name: service.host, type: TYPE_A, ttl, flush: true, address: service.address },
  ];
}

function answerQuestion(
  question: DnsQuestion,
  service: MdnsService,
  answers: DnsRecord[],
  additionals: DnsRecord[],
) {
  const [ptr, srv, txt, a] = serviceRecords(service, RECORD_TTL_SECONDS);
  const fullName = `${service.instance}.${service.type}`;
  const wants = (type: number) => question.type === type || question.type === TYPE_ANY;
  if (wants(TYPE_PTR) && sameName(question.name, SERVICES_META_TYPE)) {
    answers.push({
      name: SERVICES_META_TYPE,
      type: TYPE_PTR,
      ttl: RECORD_TTL_SECONDS,
      target: service.type,
    });
  }
  if (wants(TYPE_PTR) && sameName(question.name, service.type)) {
    answers.push(ptr);
    additionals.push(srv, txt, a);
  }
  if (sameName(question.name, fullName)) {
    if (wants(TYPE_SRV)) {
      answers.push(srv);
      additionals.push(a);
    }
    if (wants(TYPE_TXT)) answers.push(txt);
  }
  if (wants(TYPE_A) && sameName(question.name, service.host)) answers.push(a);
}

/** RFC 6762 section 7.1: skip an answer the querier already holds with at least half its TTL. */
function knownAnswerCovers(known: DnsRecord[], record: DnsRecord): boolean {
  return known.some((k) => recordKey(k) === recordKey(record) && k.ttl * 2 >= record.ttl);
}

function dedupeRecords(records: DnsRecord[]): DnsRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = recordKey(record);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function recordKey(record: DnsRecord): string {
  const value = "address" in record
    ? record.address
    : "port" in record
    ? `${record.port}@${normalizeName(record.target)}`
    : "target" in record
    ? normalizeName(record.target)
    : "entries" in record
    ? record.entries.join("\u0000")
    : [...record.data].join(",");
  return `${normalizeName(record.name)}|${record.type}|${value}`;
}

/** Every IPv4 interface address, loopback and link-local included. */
function ipv4Addresses(): string[] {
  try {
    const addresses = Deno.networkInterfaces()
      .filter((networkInterface) => networkInterface.family === "IPv4")
      .map((networkInterface) => networkInterface.address);
    return [...new Set(addresses)];
  } catch {
    return [];
  }
}

function fingerprint(data: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return `${data.length}:${hash >>> 0}`;
}

function closeQuietly(conn: Deno.DatagramConn): void {
  try {
    conn.close();
  } catch {
    // Already closed.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
