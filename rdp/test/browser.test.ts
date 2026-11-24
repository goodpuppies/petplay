/**
 * The whole path in a real browser (headless Chromium, its own window-less instance): the built
 * page (`deno task rdp:build`) finds the UI actor through a topic, over iroh through a local dev
 * relay, opens the rdp.ui WebTransport (pinned self-signed certificate), draws the app, and a click and a key in the page reach
 * desktopInput (on a stand-in helper; nothing reaches the real desktop). The video is a stand-in
 * feed nothing serves, so it shows as an empty surface.
 *
 * Needs: dist/rdp, PETPLAY_LINK_BINARY (petplay-media --features iroh), iroh-relay in
 * target/tools, and Playwright's Chromium (PETPLAY_CHROMIUM or ~/.cache/ms-playwright).
 * Run with --unstable-net. Leaves a screenshot of the page in $RDP_SCREENSHOT if set.
 */
import { assert, assertEquals } from "@std/assert";
import { chromium } from "playwright";
import { PostalService } from "../../submodules/stageforge/mod.ts";
import type { ActorId } from "../../submodules/stageforge/src/lib/types.ts";
import { irohCarrier } from "../../classes/irohCarrier.ts";
import { startDevRelay } from "../../tests/iroh-topics/relay.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 60_000) {
  const until = Date.now() + ms;
  let value = await read();
  while (!ok(value)) {
    if (Date.now() > until) throw new Error(`${what}: last ${JSON.stringify(value)}`);
    await sleep(200);
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
  name: "a browser tab finds the desktop through a topic, draws the app, and drives the desktop",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "pp-rdp-browser-" });
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
    const source = await postal.add("./fakeSource.ts", import.meta.url);
    const input = await postal.add("../desktopInput.ts", import.meta.url);
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
        { actors: { source, input } },
      );
      const [base, secret] = link.split("#");
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      const logs: string[] = [];
      page.on("console", (message) => logs.push(`${message.type()}: ${message.text()}`));
      page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));
      await page.goto(
        `${base}?topics=${encodeURIComponent(topicUrl)}&relay=${encodeURIComponent(relay.url)}#${secret}`,
      );

      const ui = actors.ui;
      const health = await eventually(
        () => call<{ tabConnected: boolean; tabKind: string; deltasSent: number; viewport: unknown }>(
            ui,
            "__HEALTH__",
          ),
        (h) => h.tabConnected && h.deltasSent >= 2,
        `the tab connects and receives the app (page log: ${logs.slice(-5).join(" | ")})`,
      );
      assertEquals(health.viewport, { width: 800, height: 600, dpr: 1 });
      assertEquals(health.tabKind, "webtransport");
      await eventually(
        () => page.locator("#status").textContent(),
        (text) => text === "",
        "the page reports connected",
      );

      // 16:9 until the feed's size is known: the video spans x 0..800, y 97..547.
      await page.mouse.click(400, 322);
      await page.keyboard.press("KeyA");
      const written = await eventually(lines, (l) => l.includes("K,1E,0"), "input reaches the helper");
      assert(written.includes("B,left,1") && written.includes("B,left,0"), written.join(" "));
      assert(written.some((l) => l === "M,0.5,0.5"), written.join(" "));

      const shot = Deno.env.get("RDP_SCREENSHOT");
      if (shot) await page.screenshot({ path: shot });
      assert(!logs.some((l) => l.startsWith("pageerror")), logs.join("\n"));
    } finally {
      await browser.close();
      await postal.shutdownAll({ timeoutMs: 2000, bestEffort: true });
      postal.closeRemote("test done");
      await iroh.stop();
      for (const client of clients) client.close();
      await topics.shutdown();
      await relay.stop();
      PostalService.actors.clear();
      Deno.env.delete("PETPLAY_SCREEN_STREAMER");
      await Deno.remove(dir, { recursive: true });
    }
  },
});
