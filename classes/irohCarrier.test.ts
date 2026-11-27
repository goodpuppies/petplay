/**
 * Needs `petplay-media` built with `--features iroh` (PETPLAY_LINK_BINARY, else the release
 * build). Runs loopback-only (`local`), so no relay or network is involved.
 */
import { assert, assertEquals } from "@std/assert";
import type { Carrier } from "../submodules/stageforge/mod.ts";
import { irohCarrier } from "./irohCarrier.ts";
import { hasPetplayMediaBinary } from "./petplayMediaPath.ts";

function nextMessage(carrier: Carrier): Promise<unknown> {
  return new Promise((resolve) => carrier.onmessage = resolve);
}

Deno.test({
  name: "two iroh endpoints carry frames both ways and report a close",
  ignore: !hasPetplayMediaBinary({ forLink: true }),
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const a = irohCarrier({ local: true });
    const b = irohCarrier({ local: true });
    try {
      let accepted!: (carrier: Carrier) => void;
      const incoming = new Promise<Carrier>((resolve) => accepted = resolve);
      const endpoint = await a.listen((carrier) => accepted(carrier));
      const dialed = await b.connect(endpoint);
      dialed.send({ hello: "from b", big: 2n ** 70n });
      const server = await incoming;
      const first = await nextMessage(server) as { hello: string; big: bigint };
      assertEquals(first.hello, "from b");
      assertEquals(first.big, 2n ** 70n);
      server.send(["reply", 1]);
      assertEquals(await nextMessage(dialed), ["reply", 1]);
      const closed = new Promise<string | undefined>((resolve) => server.onclose = resolve);
      dialed.close("done here");
      const reason = await closed;
      assert(reason?.includes("done here"), `close reason: ${reason}`);
    } finally {
      await a.stop();
      await b.stop();
    }
  },
});

Deno.test({
  name: "a direct-tier link reports its network path, and its offer carries IP candidates",
  ignore: !hasPetplayMediaBinary({ forLink: true }),
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const a = irohCarrier({ local: true });
    const b = irohCarrier({ local: true });
    try {
      await a.listen(() => {});
      await b.listen(() => {});
      const offer = await a.directEndpoint();
      assert((offer.addrs ?? []).length > 0, `direct offer without addresses: ${JSON.stringify(offer)}`);
      a.allowDirect((await b.directEndpoint()).id);
      await b.connectDirect(offer);
      let path = null;
      for (let i = 0; i < 50 && path == null; i++) {
        path = b.connections().find((c) => c.tier === "direct")?.path ?? null;
        if (path == null) await new Promise((r) => setTimeout(r, 100));
      }
      assert(path, "no path event within 5 s");
      assertEquals(path.path, "direct");
      assert(path.remote.startsWith("ip:127.0.0.1:"), path.remote);
      assert(path.open.includes(path.remote), path.open.join(" "));
    } finally {
      await a.stop();
      await b.stop();
    }
  },
});
