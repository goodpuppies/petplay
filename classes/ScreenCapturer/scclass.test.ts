import { assertEquals } from "@std/assert";
import { ScreenCapturer } from "./scclass.ts";

Deno.test("a dropped frame socket stops a live helper so its owner can restart it", async () => {
  const dir = Deno.makeTempDirSync();
  const helper = `${dir}/fake-streamer`;
  const script = new URL("./testdata/fake_streamer.ts", import.meta.url).pathname;
  Deno.writeTextFileSync(helper, `#!/bin/sh\nexec "${Deno.execPath()}" run -A "${script}" "$@"\n`);
  Deno.chmodSync(helper, 0o755);
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();

  let notifyExit!: (status: Deno.CommandStatus) => void;
  const exited = new Promise<Deno.CommandStatus>((resolve) => notifyExit = resolve);
  const capturer = new ScreenCapturer({ port, executablePath: helper, onExit: notifyExit });
  try {
    const frame = await capturer.getNextFrame(null, 10_000);
    assertEquals([frame?.width, frame?.height], [2, 1]);
    const status = await Promise.race([
      exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
    ]);
    assertEquals(status?.success, false, "the helper should have been stopped");
  } finally {
    await capturer.dispose();
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("capture session overrides reach the helper without changing the OpenVR environment", async () => {
  const dir = Deno.makeTempDirSync();
  const report = `${dir}/environment.json`;
  const script = new URL("./testdata/fake_streamer.ts", import.meta.url).pathname;
  const helper = `${dir}/fake-streamer`;
  Deno.writeTextFileSync(helper, `#!/bin/sh\nexec "${Deno.execPath()}" run -A "${script}" "$@"\n`);
  Deno.chmodSync(helper, 0o755);
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const values = {
    DBUS_SESSION_BUS_ADDRESS: "parent-vr-session",
    XDG_RUNTIME_DIR: "/parent-vr-runtime",
    WAYLAND_DISPLAY: "parent-vr-display",
    PETPLAY_CAPTURE_DBUS_SESSION_BUS_ADDRESS: "capture-session",
    PETPLAY_CAPTURE_XDG_RUNTIME_DIR: "/capture-runtime",
    PETPLAY_CAPTURE_WAYLAND_DISPLAY: "capture-display",
    PETPLAY_TEST_CAPTURE_ENV_REPORT: report,
  };
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, Deno.env.get(key)]));
  for (const [key, value] of Object.entries(values)) Deno.env.set(key, value);
  const capturer = new ScreenCapturer({ port, executablePath: helper });
  try {
    const frame = await capturer.getNextFrame(null, 10_000);
    assertEquals(frame?.width, 2);
    assertEquals(JSON.parse(await Deno.readTextFile(report)), {
      DBUS_SESSION_BUS_ADDRESS: "capture-session",
      XDG_RUNTIME_DIR: "/capture-runtime",
      WAYLAND_DISPLAY: "capture-display",
    });
    assertEquals(Deno.env.get("DBUS_SESSION_BUS_ADDRESS"), "parent-vr-session");
    assertEquals(Deno.env.get("XDG_RUNTIME_DIR"), "/parent-vr-runtime");
    assertEquals(Deno.env.get("WAYLAND_DISPLAY"), "parent-vr-display");
  } finally {
    await capturer.dispose();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("a helper refused by the portal reports why, and a disposed capturer never respawns it", async () => {
  const dir = Deno.makeTempDirSync();
  const helper = `${dir}/refused-streamer`;
  const starts = `${dir}/starts`;
  // Mirrors KDE's portal ending the request: an error line on stderr, exit 1, no frame.
  Deno.writeTextFileSync(
    helper,
    `#!/bin/sh\necho start >> "${starts}"\necho 'Error: Backend("The user interaction was ended in some other way")' >&2\nexit 1\n`,
  );
  Deno.chmodSync(helper, 0o755);
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();

  let notifyExit!: (status: Deno.CommandStatus) => void;
  const exited = new Promise<Deno.CommandStatus>((resolve) => notifyExit = resolve);
  const capturer = new ScreenCapturer({ port, executablePath: helper, onExit: notifyExit });
  try {
    await capturer.start();
    assertEquals((await exited).code, 1);
    await new Promise((resolve) => setTimeout(resolve, 100)); // let stderr drain
    assertEquals(capturer.hasReceivedFrame(), false);
    assertEquals(
      capturer.getLastError(),
      'Error: Backend("The user interaction was ended in some other way")',
    );
    await capturer.dispose();
    // The desktop loop keeps polling; each poll used to start a new helper and portal dialog.
    for (let i = 0; i < 3; i++) await capturer.getNextFrame(null, 50).catch(() => null);
    assertEquals(Deno.readTextFileSync(starts).trim().split("\n").length, 1);
  } finally {
    await capturer.dispose();
    Deno.removeSync(dir, { recursive: true });
  }
});
