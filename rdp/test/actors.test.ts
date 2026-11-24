/**
 * rdp actors with stand-in helpers: a script records what the actor runs and writes, so nothing
 * is injected into the real desktop and no portal opens. desktopSource uses the real encoder
 * (petplay-media; PETPLAY_MEDIA_BINARY) on a loopback port.
 */
import { assert, assertEquals } from "@std/assert";
import { PostalService } from "../../submodules/stageforge/mod.ts";
import type { ActorId } from "../../submodules/stageforge/src/lib/types.ts";
import { FrameReceiver } from "../../classes/ScreenCapturer/frameReceiver.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function standIn(dir: string): Promise<string> {
  const script = `${dir}/helper.sh`;
  await Deno.writeTextFile(
    script,
    // Says what the real helper says once its capture session is up.
    `#!/bin/sh\necho "$@" >> "${dir}/args"\necho "🎥 Started capture. Press Enter to stop..."\nexec cat >> "${dir}/stdin"\n`,
  );
  await Deno.chmod(script, 0o755);
  return script;
}

async function eventually(read: () => Promise<boolean>, what: string, ms = 10_000) {
  const until = Date.now() + ms;
  while (!(await read())) {
    if (Date.now() > until) throw new Error(what);
    await sleep(50);
  }
}

const lines = async (path: string) =>
  (await Deno.readTextFile(path).catch(() => "")).split("\n").filter(Boolean);

Deno.test({
  name: "desktopInput takes the VR scene's events: positions, taps, modifiers, virtual keys",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "pp-rdp-input-scene-" });
    Deno.env.set("PETPLAY_SCREEN_STREAMER", await standIn(dir));
    Deno.env.set("PETPLAY_INPUT_X11_WHEEL", "0");
    PostalService.actors.clear();
    const postal = new PostalService();
    const input = await postal.add("../desktopInput.ts", import.meta.url);
    const call = <T>(type: string, payload: unknown = null) =>
      postal.PostMessage({ target: input, type, payload }, true) as Promise<T>;
    try {
      const events = [
        // What classes/environment/desktopInputSink.ts sends for a display click and wheel.
        { t: "button", button: "right", down: true, x: 0.5, y: 0.25 },
        { t: "wheel", delta: 2, x: 0.5, y: 0.25 },
        // A latched shift, a tap of X, a virtual key (no scan), caps.
        { t: "modifier", modifier: "shift", active: true },
        { t: "key", scan: "2D" },
        { t: "key", key: "F1", down: true },
        { t: "modifier", modifier: "caps", active: true },
      ];
      assertEquals(await call("INPUTS", events), events.length);
      await call("RELEASEALL");
      await eventually(async () => (await lines(`${dir}/stdin`)).length >= 11, "events written");
      assertEquals(await lines(`${dir}/stdin`), [
        "M,0.5,0.25",
        "B,right,1",
        "M,0.5,0.25",
        "W,2",
        "K,2A,1",
        "K,2D,1",
        "K,2D,0",
        // F1 has no entry in the Linux virtual-key table: nothing written, as before.
        "K,3A,1",
        "K,3A,0",
        // Released: the button and the latched shift (caps is a toggle, never held).
        "B,right,0",
        "K,2A,0",
      ]);
      const health = await call<{ heldButtons: string[]; heldKeys: string[]; activeModifiers: string[] }>(
        "__HEALTH__",
      );
      assertEquals([health.heldButtons, health.heldKeys, health.activeModifiers], [[], [], []]);
    } finally {
      await postal.shutdown(input);
      PostalService.actors.clear();
      Deno.env.delete("PETPLAY_SCREEN_STREAMER");
      Deno.env.delete("PETPLAY_INPUT_X11_WHEEL");
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "desktopInput validates, injects, and releases what is held when a transport closes",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "pp-rdp-input-" });
    Deno.env.set("PETPLAY_SCREEN_STREAMER", await standIn(dir));
    PostalService.actors.clear();
    const postal = new PostalService();
    const input = await postal.add("../desktopInput.ts", import.meta.url);
    const client = await postal.add("./inputClient.ts", import.meta.url);
    const call = <T>(type: string, payload: unknown = null, target = input) =>
      postal.PostMessage({ target, type, payload }, true) as Promise<T>;
    try {
      assertEquals(await call("INPUT", { t: "pointer", x: 0.25, y: 2 }), true);
      assertEquals(await call("INPUT", { t: "key", scan: "1e; rm", down: true }), false);
      assertEquals(await call("INPUT", { t: "button", button: "back", down: true }), false);
      assertEquals(await call("OPEN", input, client), "messageport");
      await call("SEND", [
        { t: "button", button: "left", down: true },
        { t: "key", scan: "1E", down: true },
        { t: "wheel", delta: -2 },
      ], client);
      await eventually(async () => (await lines(`${dir}/stdin`)).length >= 4, "events written");
      await call("CLOSE", "client gone", client);
      await eventually(async () => (await lines(`${dir}/stdin`)).length >= 6, "releases written");
      assertEquals(await lines(`${dir}/stdin`), [
        "M,0.25,1",
        "B,left,1",
        "K,1E,1",
        "W,-2",
        "B,left,0",
        "K,1E,0",
      ]);
      assertEquals(await lines(`${dir}/args`), ["--input-only"]);
      const health = await call<{ rejected: number; heldKeys: string[] }>("__HEALTH__");
      assertEquals(health.rejected, 2);
      assertEquals(health.heldKeys, []);
    } finally {
      await postal.shutdown(input);
      await postal.shutdown(client, { bestEffort: true });
      PostalService.actors.clear();
      Deno.env.delete("PETPLAY_SCREEN_STREAMER");
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "desktopSource starts the encoder and a capture helper aimed at it, restarts, and stops",
  sanitizeResources: false,
  sanitizeOps: false,
  ignore: Deno.build.os !== "linux",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "pp-rdp-source-" });
    Deno.env.set("PETPLAY_SCREEN_STREAMER", await standIn(dir));
    PostalService.actors.clear();
    const postal = new PostalService();
    const source: ActorId = await postal.add("../desktopSource.ts", import.meta.url);
    const call = <T>(type: string, payload: unknown = null) =>
      postal.PostMessage({ target: source, type, payload }, true) as Promise<T>;
    const port = 46000 + Math.floor(Math.random() * 1000) * 2;
    try {
      const feed = await call<{ host: string; port: number; fingerprint: string }>("START", {
        host: "127.0.0.1",
        port,
        fps: 30,
      });
      assertEquals(feed.port, port);
      assert(/^[0-9a-f]{64}$/.test(feed.fingerprint), `fingerprint ${feed.fingerprint}`);
      await eventually(async () => (await lines(`${dir}/args`)).length === 1, "helper started");
      const [args] = await lines(`${dir}/args`);
      assert(args.includes("--no-frame-socket") && args.includes("--no-input"), args);
      const socket = args.match(/--media-socket=(\S+)/)?.[1];
      assert(socket && (await Deno.stat(socket)).isSocket, `encoder socket ${socket}`);
      assertEquals(await call("FEED"), feed);
      // The helper dying is restarted against the same socket.
      const { capturePid } = await call<{ capturePid: number }>("__HEALTH__");
      Deno.kill(capturePid, "SIGKILL");
      await eventually(async () => (await lines(`${dir}/args`)).length === 2, "helper restarted");
      assertEquals((await call<{ captureRestarts: number }>("__HEALTH__")).captureRestarts, 1);
      await call("STOP");
      assertEquals(await call("FEED"), null);
      await assertSocketGone(socket);
    } finally {
      await postal.shutdown(source);
      PostalService.actors.clear();
      Deno.env.delete("PETPLAY_SCREEN_STREAMER");
      await Deno.remove(dir, { recursive: true });
    }
  },
});

async function assertSocketGone(path: string) {
  try {
    await Deno.stat(path);
    throw new Error(`socket still exists: ${path}`);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/** A helper that sends one frame to `--port` (if any), like screen-streamer, then stays up. */
async function frameHelper(dir: string): Promise<string> {
  const script = new URL("../../classes/ScreenCapturer/testdata/fake_streamer.ts", import.meta.url)
    .pathname;
  const helper = `${dir}/frame-helper.sh`;
  await Deno.writeTextFile(
    helper,
    `#!/bin/sh\necho "$@" >> "${dir}/args"\nexec "${Deno.execPath()}" run -A "${script}" "$@"\n`,
  );
  await Deno.chmod(helper, 0o755);
  return helper;
}

async function withSource(
  helper: (dir: string) => Promise<string>,
  run: (call: <T>(type: string, payload?: unknown) => Promise<T>, dir: string) => Promise<void>,
) {
  const dir = await Deno.makeTempDir({ prefix: "pp-rdp-capture-" });
  Deno.env.set("PETPLAY_SCREEN_STREAMER", await helper(dir));
  PostalService.actors.clear();
  const postal = new PostalService();
  const source: ActorId = await postal.add("../desktopSource.ts", import.meta.url);
  const call = <T>(type: string, payload: unknown = null) =>
    postal.PostMessage({ target: source, type, payload }, true) as Promise<T>;
  try {
    await run(call, dir);
  } finally {
    await postal.shutdown(source);
    PostalService.actors.clear();
    Deno.env.delete("PETPLAY_SCREEN_STREAMER");
    await Deno.remove(dir, { recursive: true });
  }
}

type SourceHealth = { capturing: boolean; captureStarted: boolean; refused: boolean; capturePid: number | null };

Deno.test({
  name: "desktopSource streams frames to a sink, restarts on fps changes, and stops with it",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withSource(frameHelper, async (call, dir) => {
      const receiver = await FrameReceiver.start();
      try {
        await call("ADDFRAMESINK", { port: receiver.port, fps: 45 });
        const frame = await receiver.nextFrame(null, 15_000);
        assertEquals([frame?.width, frame?.height], [2, 1]);
        const [first] = await lines(`${dir}/args`);
        assert(first.includes(`--port=${receiver.port}`) && first.includes("--fps=45"), first);
        assert(first.includes("--no-input") && !first.includes("--media-socket"), first);
        // A new rate is a new helper, reaching the same receiver.
        await call("ADDFRAMESINK", { port: receiver.port, fps: 20 });
        await eventually(async () => (await lines(`${dir}/args`)).length === 2, "restarted");
        assert((await lines(`${dir}/args`))[1].includes("--fps=20"));
        const again = await receiver.nextFrame(frame, 15_000);
        assert(again && again !== frame, "the receiver takes the new helper's frames");
        await call("REMOVEFRAMESINK", { port: receiver.port });
        const health = await call<SourceHealth>("__HEALTH__");
        assertEquals([health.capturing, health.capturePid], [false, null]);
      } finally {
        receiver.dispose();
      }
    });
  },
});

Deno.test({
  name: "desktopSource does not reopen a refused capture until a consumer asks again",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const refused = async (dir: string) => {
      const helper = `${dir}/refused.sh`;
      await Deno.writeTextFile(
        helper,
        `#!/bin/sh\necho "$@" >> "${dir}/args"\necho 'Error: Backend("The user interaction was ended")' >&2\nexit 1\n`,
      );
      await Deno.chmod(helper, 0o755);
      return helper;
    };
    await withSource(refused, async (call, dir) => {
      await call("ADDFRAMESINK", { port: 45999 });
      await eventually(async () => (await call<SourceHealth>("__HEALTH__")).refused, "refused");
      await sleep(1500); // past the first restart delay
      assertEquals((await lines(`${dir}/args`)).length, 1, "no new picker on its own");
      await call("ADDFRAMESINK", { port: 45999 }); // the user opens the desktop again
      await eventually(async () => (await lines(`${dir}/args`)).length === 2, "retried");
    });
  },
});

Deno.test({
  name: "desktopSource runs one helper for a frame sink and the encoder together",
  sanitizeResources: false,
  sanitizeOps: false,
  ignore: Deno.build.os !== "linux",
  async fn() {
    await withSource(standIn, async (call, dir) => {
      await call("ADDFRAMESINK", { port: 45998, fps: 30 });
      await eventually(async () => (await lines(`${dir}/args`)).length === 1, "sink helper");
      const port = 47000 + Math.floor(Math.random() * 500) * 2;
      await call("START", { host: "127.0.0.1", port });
      await eventually(async () => (await lines(`${dir}/args`)).length === 2, "one helper, both");
      const both = (await lines(`${dir}/args`))[1];
      assert(both.includes("--port=45998") && both.includes("--media-socket="), both);
      assertEquals((await call<SourceHealth>("__HEALTH__")).capturing, true);
      await call("STOP"); // the feed goes; the sink keeps capturing, without the socket
      await eventually(async () => (await lines(`${dir}/args`)).length === 3, "sink only again");
      assert(!(await lines(`${dir}/args`))[2].includes("--media-socket"));
    });
  },
});
