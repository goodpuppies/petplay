import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { DirectCameraControl } from "./directCameraControl.ts";

Deno.test("direct camera OSC sends six float32 values and releases Flying on the same endpoint", async () => {
  const receiver = Deno.listenDatagram({ hostname: "127.0.0.1", port: 0, transport: "udp" });
  const control = new DirectCameraControl({
    hostname: "127.0.0.1",
    port: (receiver.addr as Deno.NetAddr).port,
  });
  try {
    await control.sendPose({ position: [1, -2, 3], rotationDeg: [90, 180, 0] });
    const [packet] = await receiver.receive();
    assertEquals(new TextDecoder().decode(packet.subarray(0, 20)), "/usercamera/Pose\0\0\0\0");
    assertEquals(new TextDecoder().decode(packet.subarray(20, 28)), ",ffffff\0");
    const view = new DataView(packet.buffer, packet.byteOffset);
    assertEquals(Array.from({ length: 6 }, (_, i) => view.getFloat32(28 + i * 4, false)), [
      1,
      -2,
      3,
      90,
      180,
      0,
    ]);
    await control.release();
    const [release] = await receiver.receive();
    assertEquals(new TextDecoder().decode(release), "/usercamera/Flying\0\0,F\0\0");
    await assertRejects(() => control.sendPose({ position: [NaN, 0, 0], rotationDeg: [0, 0, 0] }));
  } finally {
    await control.close();
    receiver.close();
  }
});

Deno.test("player OSC uses float axes and integer trigger press/release", async () => {
  const receiver = Deno.listenDatagram({ hostname: "127.0.0.1", port: 0, transport: "udp" });
  const control = new DirectCameraControl({
    hostname: "127.0.0.1",
    port: (receiver.addr as Deno.NetAddr).port,
  });
  try {
    for (
      const [name, value, button] of [["Vertical", .5, false], ["UseRight", 1, true], [
        "UseRight",
        0,
        true,
      ]] as const
    ) {
      await control.sendPlayerInput(name, value, button);
      const [bytes] = await receiver.receive();
      const text = new TextDecoder().decode(bytes);
      assertEquals(text.startsWith(`/input/${name}\0`), true);
      assertEquals(text.includes(button ? ",i\0" : ",f\0"), true);
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      assertEquals(
        button ? view.getInt32(bytes.length - 4, false) : view.getFloat32(bytes.length - 4, false),
        value,
      );
    }
  } finally {
    await control.close();
    receiver.close();
  }
});
