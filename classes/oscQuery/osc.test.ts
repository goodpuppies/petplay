import { assertAlmostEquals, assertEquals } from "@std/assert";
import { encodeOscMessage, parseOscPacket } from "./osc.ts";

Deno.test("osc: messages round-trip floats, ints, bools and strings", () => {
  const [message] = parseOscPacket(
    encodeOscMessage("/avatar/change", ["avtr_0000", { type: "f", value: 0.25 }, 7, true, false]),
  );
  assertEquals(message.address, "/avatar/change");
  assertEquals(message.args, ["avtr_0000", 0.25, 7, true, false]);
});

Deno.test("osc: a bundle yields every message in it", () => {
  const a = encodeOscMessage("/avatar/parameters/PetPlay/Origin/PosXPos", [{
    type: "f",
    value: 0.2,
  }]);
  const b = encodeOscMessage("/usercamera/Zoom", [{ type: "f", value: 45 }]);
  const bundle = new Uint8Array(16 + 4 + a.length + 4 + b.length);
  bundle.set(new TextEncoder().encode("#bundle"));
  const view = new DataView(bundle.buffer);
  view.setUint32(12, 1); // timetag "immediately"
  view.setInt32(16, a.length);
  bundle.set(a, 20);
  view.setInt32(20 + a.length, b.length);
  bundle.set(b, 24 + a.length);
  const messages = parseOscPacket(bundle);
  assertEquals(messages.map((m) => m.address), [
    "/avatar/parameters/PetPlay/Origin/PosXPos",
    "/usercamera/Zoom",
  ]);
  assertAlmostEquals(messages[0].args[0] as number, 0.2, 1e-6);
});

Deno.test("osc: garbage is dropped, not thrown", () => {
  assertEquals(parseOscPacket(new Uint8Array([1, 2, 3])), []);
  assertEquals(parseOscPacket(new TextEncoder().encode("#bundle\0")), []);
});
