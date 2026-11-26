import { assert, assertEquals } from "@std/assert";
import { type BrowsedService, Mdns } from "./mdns.ts";
import { encodeOscMessage, type OscMessage, parseOscPacket } from "./osc.ts";
import { findNode, OSCJSON_TYPE, VrchatOscQueryLink } from "./vrchatLink.ts";

/**
 * The whole handshake over real mDNS on this machine, with an in-process peer playing VRChat
 * under a name no other OSC app will mistake for VRChat. CI runners may have no multicast route,
 * so it runs locally only.
 */
Deno.test({
  name: "vrchatLink: discovers the peer, advertises, connects, receives, and says goodbye",
  ignore: Deno.env.get("CI") != null,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tag = crypto.randomUUID().slice(0, 6).toUpperCase();
    const peer = await FakeVrchat.start(`PetPlayLinkTestPeer-${tag}`);
    const received: OscMessage[] = [];
    const link = new VrchatOscQueryLink({
      serviceBase: `PetPlayLinkTest${tag}`,
      contents: { usercamera: { FULL_PATH: "/usercamera", ACCESS: 0 } },
      onMessage: (message) => received.push(message),
      vrchatPattern: new RegExp(`PetPlayLinkTestPeer-${tag}`),
    });
    try {
      await link.start();
      await waitFor(() => link.status().connected, 10_000, "link connected to the peer");
      const status = link.status();
      assertEquals(
        status.vrchatOscPort,
        peer.oscPort,
        "VRChat's OSC port comes from its HOST_INFO",
      );
      assert(status.serviceName?.startsWith(`PetPlayLinkTest${tag}-`));

      // The peer finds us the way VRChat does: mDNS, then our HOST_INFO.
      const us = await waitFor(
        () => peer.found(`PetPlayLinkTest${tag}-`),
        10_000,
        "peer found the link",
      );
      const hostInfo = await (await fetch(`http://127.0.0.1:${us.port}/?HOST_INFO`)).json();
      assertEquals([hostInfo.OSC_IP, hostInfo.OSC_PORT, hostInfo.OSC_TRANSPORT], [
        "127.0.0.1",
        status.oscPort,
        "UDP",
      ]);
      const tree = await (await fetch(`http://127.0.0.1:${us.port}/`)).json();
      assert(
        findNode(tree, "/avatar/change"),
        "the tree lists /avatar/change, so VRChat streams parameters",
      );
      assert(findNode(tree, "/usercamera"), "extra contents are served");
      assertEquals((await fetch(`http://127.0.0.1:${us.port}/nope`)).status, 404);

      // Handshake ping from our listener's socket, then data both ways.
      await waitFor(
        () => peer.messages.some((m) => m.address === `/PetPlayLinkTest${tag}/ping`),
        5_000,
        "ping",
      );
      await peer.send(hostInfo.OSC_PORT, "/avatar/parameters/PetPlay/Origin/PosXPos", 0.5);
      await waitFor(
        () => received.some((m) => m.address.endsWith("/PosXPos")),
        5_000,
        "link received OSC",
      );
      await waitFor(() => link.status().receiving, 1_000, "status says receiving");

      // VRChat quitting cleanly (mDNS goodbye) disconnects.
      await peer.mdns.unpublish();
      await waitFor(() => !link.status().connected, 5_000, "link disconnected on goodbye");

      // Our own goodbye reaches the peer.
      await link.stop();
      await waitFor(
        () => peer.found(`PetPlayLinkTest${tag}-`) == null,
        5_000,
        "peer saw our goodbye",
      );
    } finally {
      await link.stop();
      await peer.stop();
    }
  },
});

/** Just enough of VRChat: an OSCQuery record, a HOST_INFO, a UDP port, and a browser. */
class FakeVrchat {
  readonly messages: OscMessage[] = [];
  private readonly services = new Map<string, BrowsedService>();

  private constructor(
    readonly mdns: Mdns,
    private readonly udp: Deno.DatagramConn,
    private readonly http: Deno.HttpServer<Deno.NetAddr>,
  ) {}

  get oscPort(): number {
    return (this.udp.addr as Deno.NetAddr).port;
  }

  static async start(name: string): Promise<FakeVrchat> {
    const udp = Deno.listenDatagram({ hostname: "127.0.0.1", port: 0, transport: "udp" });
    const oscPort = (udp.addr as Deno.NetAddr).port;
    const http = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (request) => {
      const body = new URL(request.url).search.includes("HOST_INFO")
        ? { NAME: name, OSC_IP: "127.0.0.1", OSC_PORT: oscPort, OSC_TRANSPORT: "UDP" }
        : { FULL_PATH: "/", CONTENTS: {} };
      return Response.json(body);
    });
    const mdns = new Mdns();
    await mdns.start();
    const peer = new FakeVrchat(mdns, udp, http);
    void (async () => {
      try {
        for await (const [data] of udp) peer.messages.push(...parseOscPacket(data));
      } catch { /* closed */ }
    })();
    mdns.browse(OSCJSON_TYPE, (event) => {
      if (event.kind === "removed") peer.services.delete(event.service.fullName);
      else peer.services.set(event.service.fullName, event.service);
    });
    await mdns.publish([{
      instance: name,
      type: OSCJSON_TYPE,
      port: http.addr.port,
      host: `${name}.local`,
      address: "127.0.0.1",
    }]);
    return peer;
  }

  found(prefix: string): BrowsedService | undefined {
    return [...this.services.values()].find((service) => service.instance.startsWith(prefix));
  }

  async send(port: number, address: string, value: number): Promise<void> {
    await this.udp.send(encodeOscMessage(address, [{ type: "f", value }]), {
      hostname: "127.0.0.1",
      port,
      transport: "udp",
    });
  }

  async stop(): Promise<void> {
    await this.mdns.stop();
    try {
      this.udp.close();
    } catch { /* closed */ }
    await this.http.shutdown().catch(() => {});
  }
}

async function waitFor<T>(
  probe: () => T | null | undefined | false,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}
