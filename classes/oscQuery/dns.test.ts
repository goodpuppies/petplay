import { assertEquals, assertThrows } from "@std/assert";
import {
  decodeDnsPacket,
  encodeDnsPacket,
  FLAGS_RESPONSE,
  isResponse,
  sameName,
  TYPE_A,
  TYPE_PTR,
  TYPE_SRV,
  TYPE_TXT,
} from "./dns.ts";
import { serviceRecords } from "./mdns.ts";

Deno.test("dns: a service announcement survives encode and decode", () => {
  const records = serviceRecords({
    instance: "PetPlay-AB12CD",
    type: "_oscjson._tcp.local",
    port: 51234,
    host: "PetPlay-AB12CD.local",
    address: "127.0.0.1",
  }, 120);
  const packet = decodeDnsPacket(
    encodeDnsPacket({
      flags: FLAGS_RESPONSE,
      answers: [records[0]],
      additionals: records.slice(1),
    }),
  );
  assertEquals(isResponse(packet), true);
  assertEquals(packet.answers.length, 1);
  assertEquals(packet.additionals.length, 3);
  const [ptr] = packet.answers;
  const [srv, txt, a] = packet.additionals;
  assertEquals(ptr.type, TYPE_PTR);
  assertEquals("target" in ptr && ptr.target, "PetPlay-AB12CD._oscjson._tcp.local");
  assertEquals(srv.type, TYPE_SRV);
  assertEquals("port" in srv && [srv.port, srv.target, srv.flush], [
    51234,
    "PetPlay-AB12CD.local",
    true,
  ]);
  assertEquals(txt.type, TYPE_TXT);
  assertEquals("entries" in txt && txt.entries, ["txtvers=1"]);
  assertEquals(a.type, TYPE_A);
  assertEquals("address" in a && a.address, "127.0.0.1");
  assertEquals(a.ttl, 120);
});

Deno.test("dns: compressed names decode, and the QU bit is read", () => {
  // Query: _oscjson._tcp.local PTR (QU); answer: PTR whose target points back into the question.
  const bytes = new Uint8Array([
    0x00,
    0x00,
    0x84,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    // question name at offset 12: _oscjson._tcp.local
    8,
    ...ascii("_oscjson"),
    4,
    ...ascii("_tcp"),
    5,
    ...ascii("local"),
    0,
    0x00,
    0x0c,
    0x80,
    0x01,
    // answer: name = pointer to 12; PTR, IN, ttl 120, rdata = "VRChat-Client-0A1B2C" + pointer to 12
    0xc0,
    0x0c,
    0x00,
    0x0c,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x78,
    0x00,
    23,
    20,
    ...ascii("VRChat-Client-0A1B2C"),
    0xc0,
    0x0c,
  ]);
  const packet = decodeDnsPacket(bytes);
  assertEquals(packet.questions, [{
    name: "_oscjson._tcp.local",
    type: TYPE_PTR,
    unicastResponse: true,
  }]);
  const [answer] = packet.answers;
  assertEquals(answer.name, "_oscjson._tcp.local");
  assertEquals("target" in answer && answer.target, "VRChat-Client-0A1B2C._oscjson._tcp.local");
});

Deno.test("dns: malformed packets throw instead of looping or reading past the end", () => {
  assertThrows(() => decodeDnsPacket(new Uint8Array(5)));
  // One question whose name is a pointer to itself.
  assertThrows(() =>
    decodeDnsPacket(new Uint8Array([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 0x0c, 0, 12, 0, 1]))
  );
  // Truncated record.
  assertThrows(() =>
    decodeDnsPacket(new Uint8Array([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]))
  );
});

Deno.test("dns: names compare case-insensitively, trailing dot or not", () => {
  assertEquals(sameName("_OSCJSON._tcp.local.", "_oscjson._tcp.local"), true);
  assertEquals(sameName("_osc._udp.local", "_oscjson._tcp.local"), false);
});

function ascii(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}
