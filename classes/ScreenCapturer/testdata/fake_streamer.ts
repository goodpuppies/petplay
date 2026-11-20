/**
 * Stand-in for `screen-streamer` in tests: connects to `--port`, sends one 2x1 frame in the
 * helper's wire format, closes the socket and then stays alive, which is the "dropped socket,
 * live helper" case the capturer must notice on its own.
 */
const report = Deno.env.get("PETPLAY_TEST_CAPTURE_ENV_REPORT");
if (report) {
  await Deno.writeTextFile(
    report,
    JSON.stringify(Object.fromEntries(
      ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "WAYLAND_DISPLAY"].map(
        (key) => [key, Deno.env.get(key)],
      ),
    )),
  );
}
const port = Number(Deno.args.find((arg) => arg.startsWith("--port="))?.slice(7));
const conn = await Deno.connect({ hostname: "127.0.0.1", port });
console.log("🎥 Started capture. Press Enter to stop...");
const pixels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
const header = new DataView(new ArrayBuffer(20));
header.setUint32(0, 2, true); // width
header.setUint32(4, 1, true); // height
header.setUint32(8, pixels.length, true); // total size
header.setUint32(12, 1, true); // chunks
header.setUint32(16, pixels.length, true); // chunk size
await conn.write(new Uint8Array(header.buffer));
await conn.write(pixels);
conn.close();
setInterval(() => {}, 1_000);
