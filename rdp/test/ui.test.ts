/**
 * The UI actor end to end, with a test actor in the browser's place: the tab opens its WebSocket
 * transport, receives the app as scene deltas, and its DOM events drive the desktop through the
 * real desktopInput (on a stand-in helper, so nothing reaches the real desktop).
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { PostalService } from "../../submodules/stageforge/mod.ts";
import type { ActorId } from "../../submodules/stageforge/src/lib/types.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string) {
  const until = Date.now() + 20_000;
  let value = await read();
  while (!ok(value)) {
    if (Date.now() > until) throw new Error(`${what}: last ${JSON.stringify(value)}`);
    await sleep(50);
    value = await read();
  }
  return value;
}

type TabState = {
  kind: string;
  deltas: number;
  texts: string[];
  uiQuads: number;
  videos: Array<{ feed: string; transform: number[] }>;
  camera: { projection: number[]; world: number[] } | null;
  feeds: Record<string, unknown> | null;
};

const pointer = (type: string, x: number, y: number, button = 0) => ({
  type,
  offsetX: x,
  offsetY: y,
  pointerId: 1,
  pointerType: "mouse",
  button,
  buttons: type === "pointerdown" ? 1 : 0,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
});
const key = (type: string, code: string) => ({
  type,
  code,
  key: code,
  repeat: false,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
});

Deno.test({
  name: "the UI actor serves its app to a tab and turns the tab's events into desktop input",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "pp-rdp-ui-" });
    const helper = `${dir}/helper.sh`;
    await Deno.writeTextFile(helper, `#!/bin/sh\nexec cat >> "${dir}/stdin"\n`);
    await Deno.chmod(helper, 0o755);
    Deno.env.set("PETPLAY_SCREEN_STREAMER", helper);
    PostalService.actors.clear();
    const postal = new PostalService();
    const call = <T>(target: ActorId, type: string, payload: unknown = null) =>
      postal.PostMessage({ target, type, payload }, true) as Promise<T>;
    const input = await postal.add("../desktopInput.ts", import.meta.url);
    const source = await postal.add("./fakeSource.ts", import.meta.url);
    const ui = await postal.add("../ui.tsx", import.meta.url);
    const tab = await postal.add("./tabClient.ts", import.meta.url);
    const stranger = await postal.add("./tabClient.ts", import.meta.url);
    const lines = async () =>
      (await Deno.readTextFile(`${dir}/stdin`).catch(() => "")).split("\n").filter(Boolean);
    try {
      await call(ui, "START", { secret: "rdp-test-session-secret", source, input });
      // Without the session's secret a tab gets nothing.
      await call(stranger, "OPEN", {
        ui,
        viewport: { width: 800, height: 600, dpr: 1 },
        secret: "rdp-a-wrong-guess-at-it",
      });
      await sleep(300);
      assertEquals((await call<TabState>(stranger, "STATE")).deltas, 0, "a stranger gets no deltas");
      assertEquals(
        await call(tab, "OPEN", {
          ui,
          viewport: { width: 800, height: 600, dpr: 1 },
          secret: "rdp-test-session-secret",
        }),
        "websocket",
      );
      const first = await eventually(
        () => call<TabState>(tab, "STATE"),
        (s) => s.texts.includes("Desktop") && s.videos.length === 1 && !!s.feeds?.desktop,
        "the tab receives the app, its video surface and the feed",
      );
      assert(first.uiQuads > 0, "the toolbar's panel arrives");
      assert(first.camera, "the camera arrives");

      // Until the tab knows the feed's size the video is 16:9. The tab decodes it and reports
      // 1112×556 (2:1): the video refits to 800×400 below the toolbar, spanning y 122..522.
      assertEquals(Math.round(first.videos[0].transform[5]), 450);
      await call(tab, "FEEDSIZE", { width: 1112, height: 556 });
      const fitted = await eventually(
        () => call<TabState>(tab, "STATE"),
        (s) => Math.round(s.videos[0]?.transform[5] ?? 0) === 400 && s.texts.includes("1112x556"),
        "the video is refitted to the feed's aspect",
      );
      const t = fitted.videos[0].transform;
      assertEquals([Math.round(t[0]), Math.round(t[12]), Math.round(t[13])], [800, 0, -22]);

      // Center (400, 322) is (0.5, 0.5); (200, 122) is (0.25, 0).
      await call(tab, "DOM", [
        pointer("pointermove", 400, 322),
        pointer("pointerdown", 400, 322),
        pointer("pointerup", 200, 122),
        key("keydown", "KeyA"),
        key("keyup", "KeyA"),
      ]);
      const written = await eventually(lines, (l) => l.includes("K,1e,0"), "input reaches the helper");
      assertEquals(written.filter((l) => !l.startsWith("M,")), [
        "B,left,1",
        "B,left,0",
        "K,1e,1",
        "K,1e,0",
      ]);
      assert(written.includes("M,0.5,0.5"), written.join(" "));
      assert(written.includes("M,0.25,0"), written.join(" "));
      const health = await call<{ rejected: number; domEvents: number }>(ui, "__HEALTH__");
      assertEquals(health.rejected, 1, "only the stranger was rejected");
      assertEquals(health.domEvents, 5);
    } finally {
      await call(tab, "CLOSE").catch(() => {});
      for (const actor of [ui, input]) {
        await postal.PostMessage({ target: actor, type: "SHUTDOWN", payload: null }, true)
          .catch(() => {});
      }
      for (const actor of [ui, input, source, tab, stranger]) {
        PostalService.actors.get(actor)?.worker.terminate();
      }
      PostalService.actors.clear();
      Deno.env.delete("PETPLAY_SCREEN_STREAMER");
      await Deno.remove(dir, { recursive: true });
    }
  },
});
