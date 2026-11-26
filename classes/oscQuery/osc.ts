/** OSC 1.0 messages and bundles, as VRChat sends and accepts them. Pure: no sockets. */

export type OscMessage = {
  address: string;
  args: unknown[];
};

export type OscOutboundArg = number | boolean | string | { type: "i" | "f"; value: number };

/** The messages in one UDP datagram (a message, or a bundle of them). Malformed parts are dropped. */
export function parseOscPacket(data: Uint8Array): OscMessage[] {
  const bundle = parseOscBundle(data);
  if (bundle) return bundle;
  const message = parseOscMessage(data);
  return message ? [message] : [];
}

function parseOscBundle(data: Uint8Array): OscMessage[] | null {
  if (data.length < 16 || new TextDecoder().decode(data.subarray(0, 7)) !== "#bundle") return null;
  const messages: OscMessage[] = [];
  let offset = 16;
  while (offset + 4 <= data.length) {
    const size = new DataView(data.buffer, data.byteOffset + offset, 4).getInt32(0, false);
    offset += 4;
    if (size <= 0 || offset + size > data.length) break;
    messages.push(...parseOscPacket(data.subarray(offset, offset + size)));
    offset += size;
  }
  return messages;
}

function parseOscMessage(data: Uint8Array): OscMessage | null {
  const decoder = new TextDecoder();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let addressEnd = 0;
  while (addressEnd < data.length && data[addressEnd] !== 0) addressEnd++;
  if (addressEnd === 0 || addressEnd >= data.length || data[0] !== 0x2f /* "/" */) return null;
  const address = decoder.decode(data.subarray(0, addressEnd));
  const typeTagStart = pad4(addressEnd + 1);
  if (typeTagStart >= data.length || data[typeTagStart] !== 0x2c /* "," */) {
    return { address, args: [] };
  }
  let typeTagEnd = typeTagStart;
  while (typeTagEnd < data.length && data[typeTagEnd] !== 0) typeTagEnd++;
  const typeTag = decoder.decode(data.subarray(typeTagStart, typeTagEnd));
  const args: unknown[] = [];
  let offset = pad4(typeTagEnd + 1);
  for (let i = 1; i < typeTag.length; i++) {
    const type = typeTag[i];
    if (type === "f" || type === "i") {
      if (offset + 4 > data.length) break;
      args.push(type === "f" ? view.getFloat32(offset, false) : view.getInt32(offset, false));
      offset += 4;
    } else if (type === "T" || type === "F") {
      args.push(type === "T");
    } else if (type === "N" || type === "I") {
      args.push(null);
    } else if (type === "s") {
      let end = offset;
      while (end < data.length && data[end] !== 0) end++;
      if (end >= data.length) break;
      args.push(decoder.decode(data.subarray(offset, end)));
      offset = pad4(end + 1);
    } else if (type === "b") {
      if (offset + 4 > data.length) break;
      const size = view.getInt32(offset, false);
      if (size < 0 || offset + 4 + size > data.length) break;
      args.push(data.slice(offset + 4, offset + 4 + size));
      offset = pad4(offset + 4 + size);
    } else {
      // An argument type we cannot size: stop rather than misread the rest.
      break;
    }
  }
  return { address, args };
}

export function encodeOscMessage(address: string, args: OscOutboundArg[]): Uint8Array {
  let typeTag = ",";
  const chunks: Uint8Array[] = [];
  for (const arg of args) {
    if (typeof arg === "boolean") {
      typeTag += arg ? "T" : "F";
      continue;
    }
    if (typeof arg === "string") {
      typeTag += "s";
      chunks.push(encodeOscString(arg));
      continue;
    }
    const typed = typeof arg === "number"
      ? ({ type: Number.isInteger(arg) ? "i" : "f", value: arg } as const)
      : arg;
    typeTag += typed.type;
    const chunk = new Uint8Array(4);
    const view = new DataView(chunk.buffer);
    if (typed.type === "i") view.setInt32(0, Math.trunc(typed.value), false);
    else view.setFloat32(0, typed.value, false);
    chunks.push(chunk);
  }
  const parts = [encodeOscString(address), encodeOscString(typeTag), ...chunks];
  const packet = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    packet.set(part, offset);
    offset += part.length;
  }
  return packet;
}

function encodeOscString(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  const out = new Uint8Array(pad4(encoded.length + 1));
  out.set(encoded, 0);
  return out;
}

function pad4(length: number): number {
  return (length + 3) & ~3;
}
