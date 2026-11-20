/**
 * rdp actors with stand-in helpers: a script records what the actor runs and writes, so nothing
 * is injected into the real desktop and no portal opens. desktopSource uses the real encoder
 * (petplay-media; PETPLAY_MEDIA_BINARY) on a loopback port.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { PostalService } from "../../submodules/stageforge/mod.ts";
import type { ActorId } from "../../submodules/stageforge/src/lib/types.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function standIn(dir: string): Promise<string> {
  const script = `${dir}/helper.sh`;
  await Deno.writeTextFile(
    script,
    `#!/bin/sh\necho "$@" >> "${dir}/args"\nexec cat >> "${dir}/stdin"\n`,
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
      await postal.PostMessage({ target: input, type: "SHUTDOWN", payload: null }, true);
      PostalService.actors.get(input)?.worker.terminate();
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
      await postal.PostMessage({ target: input, type: "SHUTDOWN", payload: null }, true);
      PostalService.actors.get(input)?.worker.terminate();
      PostalService.actors.get(client)?.worker.terminate();
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
      await postal.PostMessage({ target: source, type: "SHUTDOWN", payload: null }, true);
      PostalService.actors.get(source)?.worker.terminate();
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
