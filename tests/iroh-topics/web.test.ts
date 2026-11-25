/**
 * The browser path, run in Deno: the wasm iroh module (relay-only) as this process's carrier, a
 * native process in a child, a local dev relay. Both directions are dialed through the relay.
 *
 * Needs: `link-web/build.sh` (pkg-deno), petplay-media with `--features iroh`
 * (PETPLAY_LINK_BINARY), and iroh-relay =1.4.1 in target/tools (PETPLAY_IROH_RELAY_BINARY).
 */
import { assert, assertEquals } from "@std/assert";
import type { Carrier } from "../../submodules/stageforge/mod.ts";
import { PostalService } from "../../submodules/stageforge/mod.ts";
import type { ActorId } from "../../submodules/stageforge/src/lib/types.ts";
import { irohCarrier } from "../../classes/irohCarrier.ts";
import { irohWebCarrier, type IrohWebModule } from "../../classes/irohWebCarrier.ts";
import { startDevRelay } from "./relay.ts";

const wasm = await import(
  // @ts-ignore — built on demand by link-web/build.sh (not present in clean CI checkouts)
  "../../submodules/petplay_mediatransport/link-web/pkg-deno/petplay_link_web.js"
) as unknown as IrohWebModule;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const next = (carrier: Carrier) => new Promise<unknown>((resolve) => carrier.onmessage = resolve);

Deno.test({
  name: "the wasm carrier reaches a native link endpoint through a relay",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const relay = await startDevRelay();
    const native = irohCarrier({ relay: relay.url });
    const web = irohWebCarrier(wasm, { relay: relay.url });
    try {
      let accepted!: (carrier: Carrier) => void;
      const incoming = new Promise<Carrier>((resolve) => accepted = resolve);
      const endpoint = await native.listen((carrier) => accepted(carrier)) as {
        id: string;
        relay: string;
      };
      assert(endpoint.relay?.startsWith(relay.url), `published relay ${endpoint.relay}`);
      assert(!("addrs" in endpoint), "no addresses are published");
      const page = await web.connect(endpoint);
      page.send({ from: "page", n: 7n });
      const hub = await incoming;
      assertEquals(await next(hub), { from: "page", n: 7n });
      hub.send("back");
      assertEquals(await next(page), "back");
      const closed = new Promise<string | undefined>((resolve) => hub.onclose = resolve);
      page.close("page left");
      assertEquals(await closed, "page left");

      // And the page is reachable: the native side dials it through the page's relay.
      let pageAccepted!: (carrier: Carrier) => void;
      const toPage = new Promise<Carrier>((resolve) => pageAccepted = resolve);
      const pageEndpoint = await web.listen((carrier) => pageAccepted(carrier)) as {
        id: string;
        relay: string;
      };
      assert(pageEndpoint.relay?.startsWith(relay.url), `page relay ${pageEndpoint.relay}`);
      const dialer = await native.connect(pageEndpoint);
      dialer.send({ from: "native" });
      const atPage = await toPage;
      assertEquals(await next(atPage), { from: "native" });
      atPage.send("hello native");
      assertEquals(await next(dialer), "hello native");
      dialer.close("done");
    } finally {
      await web.stop();
      await native.stop();
      await relay.stop();
    }
  },
});

Deno.test({
  name: "a page finds an earlier topic member, which dials it through the relay",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
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
    const server = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", new URL("./serverChild.ts", import.meta.url).href, topicUrl, relay.url],
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    const web = irohWebCarrier(wasm, { relay: relay.url });
    const postal = new PostalService();
    try {
      // Wait until the server has joined: the page must not hear its record, so the server
      // only meets the page by hearing the page's join and dialing it.
      const reader = server.stdout.getReader();
      let text = "";
      while (!text.includes("SERVER_JOINED")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("server process exited");
        text += new TextDecoder().decode(value);
      }
      reader.releaseLock();
      await sleep(300);

      postal.registerRemoteCarrier(web);
      postal.initSignalingClient(topicUrl);
      const page = await postal.add(
        "../../submodules/stageforge/test/actors/topicPeer.ts",
        import.meta.url,
      );
      const call = <T>(target: ActorId, type: string, payload: unknown = null) =>
        postal.PostMessage({ target, type, payload }, true) as Promise<T>;
      await call(page, "JOIN", "t");
      let contacts: ActorId[] = [];
      for (let i = 0; i < 200 && contacts.length === 0; i++) {
        await sleep(100);
        contacts = await call<ActorId[]>(page, "CONTACTS");
      }
      assertEquals(contacts.length, 1, "the page learns the server's member");
      const remote = contacts[0];
      assertEquals(await call(page, "ASK", remote), remote, "and reaches it over the relay");
    } finally {
      postal.closeRemote("test done");
      server.kill();
      await server.status;
      await server.stdout.cancel().catch(() => {});
      await web.stop();
      for (const client of clients) client.close();
      await topics.shutdown();
      await relay.stop();
    }
  },
});
