/**
 * Phase 2b end to end: two hubs in two processes meet through a topic relay, link over iroh
 * (loopback, no relay server), message each other's actors, then move the link to a negotiated
 * WebSocket. Needs `petplay-media` with `--features iroh` (PETPLAY_LINK_BINARY).
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { PostalService } from "../../submodules/stageforge/mod.ts";
import type { ActorId } from "../../submodules/stageforge/src/lib/types.ts";
import { irohLinkCarrier } from "../../classes/irohLinkCarrier.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string) {
  const until = Date.now() + 20_000;
  let value = await read();
  while (!ok(value)) {
    if (Date.now() > until) throw new Error(`${what}: last ${JSON.stringify(value)}`);
    await sleep(100);
    value = await read();
  }
  return value;
}

Deno.test({
  name: "hubs meet through a topic, link over iroh, and upgrade the link to a websocket",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const clients = new Set<WebSocket>();
    const relay = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onopen = () => clients.add(socket);
      socket.onclose = () => clients.delete(socket);
      socket.onmessage = (event) => {
        for (const client of clients) client.send(event.data);
      };
      return response;
    });
    const relayUrl = `ws://127.0.0.1:${relay.addr.port}/`;
    const iroh = irohLinkCarrier({ local: true });
    const postal = new PostalService();
    postal.registerLinkCarrier(iroh);
    postal.initSignalingClient(relayUrl);
    const local = await postal.add(
      "../../submodules/stageforge/test/actors/topicPeer.ts",
      import.meta.url,
    );
    const call = <T>(target: ActorId, type: string, payload: unknown = null) =>
      postal.PostMessage({ target, type, payload }, true) as Promise<T>;
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", new URL("./child.ts", import.meta.url).href, relayUrl],
      stdout: "null",
      stderr: "inherit",
    }).spawn();
    try {
      await call(local, "JOIN", "t");
      const [remote] = await eventually(
        () => call<ActorId[]>(local, "CONTACTS"),
        (c) => c.length === 1,
        "local actor learns the remote member",
      );
      const [link] = postal.links();
      assert(link, "a link exists");
      assertEquals(await call(local, "ASK", remote), remote, "remote answers over iroh");
      await eventually(
        () => call<ActorId[]>(remote, "CONTACTS"),
        (c) => c.includes(local),
        "remote member learns the local one",
      );
      await link.upgrade({ kinds: ["websocket"] });
      assertEquals(link.epoch, 1);
      assertEquals(await call(local, "ASK", remote), remote, "remote answers after the upgrade");
    } finally {
      for (const link of postal.links()) link.close("test done");
      child.kill();
      await child.status;
      await iroh.stop();
      for (const client of clients) client.close();
      await relay.shutdown();
    }
  },
});
