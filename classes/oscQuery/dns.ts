/**
 * DNS wire format, as far as mDNS service discovery needs it (RFC 1035 + RFC 6762/6763):
 * questions and A / PTR / SRV / TXT records, with name compression on decode.
 *
 * Pure: no sockets. `mdns.ts` puts it on the network.
 */

export const TYPE_A = 1;
export const TYPE_PTR = 12;
export const TYPE_TXT = 16;
export const TYPE_SRV = 33;
export const TYPE_ANY = 255;
const CLASS_IN = 1;
/** Top bit of a question's class: "unicast response wanted" (QU). */
const CLASS_QU = 0x8000;
/** Top bit of a record's class: "cache flush" (the record set is unique to its owner). */
const CLASS_FLUSH = 0x8000;
/** Header flags of a response: QR (response) + AA (authoritative). */
export const FLAGS_RESPONSE = 0x8400;

export type DnsQuestion = { name: string; type: number; unicastResponse?: boolean };

type RecordBase = { name: string; ttl: number; flush?: boolean };
export type DnsRecord =
  | RecordBase & { type: typeof TYPE_A; address: string }
  | RecordBase & { type: typeof TYPE_PTR; target: string }
  | RecordBase & {
    type: typeof TYPE_SRV;
    port: number;
    target: string;
    priority?: number;
    weight?: number;
  }
  | RecordBase & { type: typeof TYPE_TXT; entries: string[] }
  | RecordBase & { type: number; data: Uint8Array };

export type DnsPacket = {
  id: number;
  flags: number;
  questions: DnsQuestion[];
  answers: DnsRecord[];
  authorities: DnsRecord[];
  additionals: DnsRecord[];
};

export function isResponse(packet: DnsPacket): boolean {
  return (packet.flags & 0x8000) !== 0;
}

/** DNS names compare case-insensitively; a trailing dot is not part of the name. */
export function sameName(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b);
}

export function normalizeName(name: string): string {
  return name.replace(/\.$/, "").toLowerCase();
}

// -- encode -------------------------------------------------------------------------------------

export function encodeDnsPacket(packet: Partial<DnsPacket>): Uint8Array {
  const questions = packet.questions ?? [];
  const answers = packet.answers ?? [];
  const authorities = packet.authorities ?? [];
  const additionals = packet.additionals ?? [];
  const parts: Uint8Array[] = [];
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);
  view.setUint16(0, packet.id ?? 0);
  view.setUint16(2, packet.flags ?? 0);
  view.setUint16(4, questions.length);
  view.setUint16(6, answers.length);
  view.setUint16(8, authorities.length);
  view.setUint16(10, additionals.length);
  parts.push(header);
  for (const question of questions) parts.push(encodeQuestion(question));
  for (const record of [...answers, ...authorities, ...additionals]) {
    parts.push(encodeRecord(record));
  }
  return concat(parts);
}

function encodeQuestion(question: DnsQuestion): Uint8Array {
  const name = encodeName(question.name);
  const out = new Uint8Array(name.length + 4);
  out.set(name);
  const view = new DataView(out.buffer);
  view.setUint16(name.length, question.type);
  view.setUint16(name.length + 2, CLASS_IN | (question.unicastResponse ? CLASS_QU : 0));
  return out;
}

function encodeRecord(record: DnsRecord): Uint8Array {
  const name = encodeName(record.name);
  const rdata = encodeRdata(record);
  const out = new Uint8Array(name.length + 10 + rdata.length);
  out.set(name);
  const view = new DataView(out.buffer);
  view.setUint16(name.length, record.type);
  view.setUint16(name.length + 2, CLASS_IN | (record.flush ? CLASS_FLUSH : 0));
  view.setUint32(name.length + 4, record.ttl);
  view.setUint16(name.length + 8, rdata.length);
  out.set(rdata, name.length + 10);
  return out;
}

function encodeRdata(record: DnsRecord): Uint8Array {
  if ("address" in record) {
    const octets = record.address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      throw new Error(`not an IPv4 address: ${record.address}`);
    }
    return new Uint8Array(octets);
  }
  if ("port" in record) {
    const target = encodeName(record.target);
    const out = new Uint8Array(6 + target.length);
    const view = new DataView(out.buffer);
    view.setUint16(0, record.priority ?? 0);
    view.setUint16(2, record.weight ?? 0);
    view.setUint16(4, record.port);
    out.set(target, 6);
    return out;
  }
  if ("target" in record) return encodeName(record.target);
  if ("entries" in record) {
    const encoder = new TextEncoder();
    const strings = record.entries.length
      ? record.entries.map((e) => encoder.encode(e))
      : [new Uint8Array()];
    return concat(
      strings.map((s) => concat([new Uint8Array([Math.min(s.length, 255)]), s.slice(0, 255)])),
    );
  }
  return record.data;
}

export function encodeName(name: string): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const label of normalizeLabels(name)) {
    const bytes = encoder.encode(label);
    if (bytes.length > 63) throw new Error(`DNS label longer than 63 bytes: ${label}`);
    parts.push(new Uint8Array([bytes.length]), bytes);
  }
  parts.push(new Uint8Array([0]));
  return concat(parts);
}

function normalizeLabels(name: string): string[] {
  return name.replace(/\.$/, "").split(".").filter((label) => label.length > 0);
}

// -- decode -------------------------------------------------------------------------------------

/** Throws on a malformed packet. */
export function decodeDnsPacket(bytes: Uint8Array): DnsPacket {
  if (bytes.length < 12) throw new Error("DNS packet shorter than its header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const counts = [view.getUint16(4), view.getUint16(6), view.getUint16(8), view.getUint16(10)];
  const reader = { bytes, view, offset: 12 };
  const questions: DnsQuestion[] = [];
  for (let i = 0; i < counts[0]; i++) {
    const name = readName(reader);
    need(reader, 4);
    const type = view.getUint16(reader.offset);
    const klass = view.getUint16(reader.offset + 2);
    reader.offset += 4;
    questions.push({ name, type, unicastResponse: (klass & CLASS_QU) !== 0 });
  }
  const sections: DnsRecord[][] = [[], [], []];
  for (let section = 0; section < 3; section++) {
    for (let i = 0; i < counts[section + 1]; i++) sections[section].push(readRecord(reader));
  }
  return {
    id: view.getUint16(0),
    flags: view.getUint16(2),
    questions,
    answers: sections[0],
    authorities: sections[1],
    additionals: sections[2],
  };
}

type Reader = { bytes: Uint8Array; view: DataView; offset: number };

function need(reader: Reader, length: number): void {
  if (reader.offset + length > reader.bytes.length) throw new Error("DNS packet truncated");
}

function readRecord(reader: Reader): DnsRecord {
  const name = readName(reader);
  need(reader, 10);
  const { view } = reader;
  const type = view.getUint16(reader.offset);
  const klass = view.getUint16(reader.offset + 2);
  const ttl = view.getUint32(reader.offset + 4);
  const length = view.getUint16(reader.offset + 8);
  reader.offset += 10;
  need(reader, length);
  const start = reader.offset;
  const end = start + length;
  const flush = (klass & CLASS_FLUSH) !== 0;
  let record: DnsRecord;
  if (type === TYPE_A && length === 4) {
    record = { name, ttl, flush, type, address: [...reader.bytes.subarray(start, end)].join(".") };
  } else if (type === TYPE_PTR) {
    record = { name, ttl, flush, type, target: readName({ ...reader, offset: start }) };
  } else if (type === TYPE_SRV && length >= 7) {
    record = {
      name,
      ttl,
      flush,
      type,
      priority: view.getUint16(start),
      weight: view.getUint16(start + 2),
      port: view.getUint16(start + 4),
      target: readName({ ...reader, offset: start + 6 }),
    };
  } else if (type === TYPE_TXT) {
    const entries: string[] = [];
    const decoder = new TextDecoder();
    let offset = start;
    while (offset < end) {
      const size = reader.bytes[offset];
      if (offset + 1 + size > end) break;
      if (size > 0) {
        entries.push(decoder.decode(reader.bytes.subarray(offset + 1, offset + 1 + size)));
      }
      offset += 1 + size;
    }
    record = { name, ttl, flush, type, entries };
  } else {
    record = { name, ttl, flush, type, data: reader.bytes.slice(start, end) };
  }
  reader.offset = end;
  return record;
}

/** Reads a (possibly compressed) name at `reader.offset` and advances past it. */
function readName(reader: Reader): string {
  const labels: string[] = [];
  const decoder = new TextDecoder();
  let offset = reader.offset;
  let jumped = false;
  let jumps = 0;
  while (true) {
    if (offset >= reader.bytes.length) throw new Error("DNS name runs past the packet");
    const length = reader.bytes[offset];
    if (length === 0) {
      offset += 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= reader.bytes.length) throw new Error("DNS name pointer truncated");
      if (++jumps > 32) throw new Error("DNS name pointer loop");
      const pointer = ((length & 0x3f) << 8) | reader.bytes[offset + 1];
      if (!jumped) reader.offset = offset + 2;
      jumped = true;
      offset = pointer;
      continue;
    }
    if ((length & 0xc0) !== 0) throw new Error("unsupported DNS label type");
    if (offset + 1 + length > reader.bytes.length) {
      throw new Error("DNS label runs past the packet");
    }
    labels.push(decoder.decode(reader.bytes.subarray(offset + 1, offset + 1 + length)));
    offset += 1 + length;
  }
  if (!jumped) reader.offset = offset;
  return labels.join(".");
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
