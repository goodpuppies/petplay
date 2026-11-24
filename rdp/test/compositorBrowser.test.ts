/**
 * End-to-end Chromium test for `mode: "compositor"`:
 * - `rdp.ts` spawns `rdp-liaison`, `mediaMux`, `inputRouter`, `compositor`, and `site`.
 * - Real headless Chromium loads `dist/rdp/` (`page.js`, `liaison.js`, `client.js`), connects
 *   through `rdp-liaison` + `ADDCONTACT` + WebTransport, renders `WallpaperFeed` +
 *   `FloatingWindow` + `Taskbar`, and sends a click + key inside a floating window through
 *   `inputRouter` -> `desktopInput` (mapped through the window's `region`).
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { chromium } from "npm:playwright@1.55.0";
import { PostalService } from "../../submodules/stageforge/mod.ts";
import type { ActorId } from "../../submodules/stageforge/src/lib/types.ts";
import { irohCarrier } from "../../classes/irohCarrier.ts";
import { startDevRelay } from "../../tests/iroh-topics/relay.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 25_000) {
  const until = Date.now() + ms;
  let value = await read();
  while (!ok(value)) {
    if (Date.now() > until) throw new Error(`${what}: last ${JSON.stringify(value)}`);
    await sleep(150);
    value = await read();
  }
  return value;
}

function chromiumPath(): string {
  const configured = Deno.env.get("PETPLAY_CHROMIUM");
  if (configured) return configured;
  const root = `${Deno.env.get("HOME")}/.cache/ms-playwright`;
  const builds = [...Deno.readDirSync(root)].map((e) => e.name).filter((n) => /^chromium-\d+$/.test(n))
    .sort();
  if (!builds.length) throw new Error("no Playwright Chromium; set PETPLAY_CHROMIUM");
  return `${root}/${builds.at(-1)}/chrome-linux64/chrome`;
}

Deno.test({
  name: "compositor mode in Chromium: liaison -> compositor -> FloatingWindow input -> desktopInput",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "pp-rdp-comp-browser-" });
    const helper = `${dir}/helper.sh`;
    await Deno.writeTextFile(helper, `#!/bin/sh\nexec cat >> "${dir}/stdin"\n`);
    await Deno.chmod(helper, 0o755);
    Deno.env.set("PETPLAY_SCREEN_STREAMER", helper);
    const lines = async () =>
      (await Deno.readTextFile(`${dir}/stdin`).catch(() => "")).split("\n").filter(Boolean);

    const relay = await startDevRelay();
    const clients = new Set<WebSocket>();
    const topics = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onopen = () => clients.add(socket);
      socket.onclose = () => clients.delete(socket);
      socket.onmessage = (event) => {
        for (const client of clients) client.send(event.data);
      };
      return response;
    });
    const topicUrl = `ws://127.0.0.1:${topics.addr.port}/`;

    PostalService.actors.clear();
    const postal = new PostalService();
    const iroh = irohCarrier({ relay: relay.url });
    postal.registerRemoteCarrier(iroh);
    postal.initSignalingClient(topicUrl);
    const call = <T>(target: ActorId, type: string, payload: unknown = null) =>
      postal.PostMessage({ target, type, payload }, true) as Promise<T>;

    const source = await postal.add("./fakeMuxSource.ts", import.meta.url);
    const input = await postal.add("../desktopInput.ts", import.meta.url);
    await call(source, "CONFIGURE", { machine: "homepc", kind: "desktop", input });
    const rdp = await postal.add("../rdp.ts", import.meta.url);

    const browser = await chromium.launch({
      executablePath: chromiumPath(),
      headless: true,
      args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
    });
    try {
      const { link, actors } = await call<{ link: string; actors: Record<string, ActorId> }>(
        rdp,
        "START",
        { mode: "compositor", actors: { source, input } },
      );
      const [base, secret] = link.split("#");
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      const logs: string[] = [];
      page.on("console", (message) => logs.push(`${message.type()}: ${message.text()}`));
      page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));
      await page.goto(
        `${base}?topics=${encodeURIComponent(topicUrl)}&relay=${encodeURIComponent(relay.url)}#${secret}`,
      );

      const comp = actors.ui;
      await eventually(
        () => call<{ viewers: number; frames: number; viewport: unknown }>(comp, "__HEALTH__"),
        (h) => h.viewers === 1 && h.frames >= 2,
        `compositor accepts browser tab (logs: ${logs.slice(-5).join(" | ")})`,
        8000,
      );
      await eventually(
        () => page.locator("#status").textContent(),
        (text) => text === "",
        "page reports connected",
        4000,
      );

      // Open a FloatingWindow at known coordinates (100, 50, 400x332 -> content 400x300 at y=82..382).
      const windows = await call<Array<{ id: string; title: string; app: string; width: number; height: number; region?: { x: number; y: number; width: number; height: number } }>>(
        actors.mediaMux,
        "LISTWINDOWS",
        { source },
      );
      assertEquals(windows.length, 1);
      await call(comp, "OPEN_WINDOW", {
        source,
        window: windows[0],
        x: 100,
        y: 50,
        width: 400,
        height: 332,
      });
      await sleep(150);

      // Click the exact center of the window's content area: x = 100 + 200 = 300, y = 50 + 32 + 150 = 232.
      // Window's region is { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } -> center maps to (0.35, 0.35).
      await page.mouse.click(300, 232);
      await page.keyboard.press("KeyA");

      const written = await eventually(
        lines,
        (l) => l.includes("K,1E,0"),
        `input reaches desktopInput helper (written: ${JSON.stringify(await lines())}, router: ${JSON.stringify(await call(actors.inputRouter, "__HEALTH__"))}, comp: ${JSON.stringify(await call(comp, "__HEALTH__"))}, logs: ${logs.slice(-5).join(" | ")})`,
        5000,
      );
      assert(written.includes("B,left,1") && written.includes("B,left,0"), written.join(" "));
      assert(written.includes("M,0.35,0.35"), `expected M,0.35,0.35 in: ${written.join(" ")}`);
    } finally {
      await browser.close();
      for (const id of [rdp, source, input]) {
        await postal.shutdown(id, { timeoutMs: 500, bestEffort: true });
      }
      postal.closeRemote("test done");
      await iroh.stop();
      for (const c of clients) c.close();
      await topics.shutdown();
      await relay.stop();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
