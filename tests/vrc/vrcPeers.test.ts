/**
 * End-to-end two-process test for VRChat instance discovery + TOFU trust over Stageforge iroh:
 *   1. Alice and Bob both enter the same VRChat instance in their respective logs.
 *   2. Both auto-join the hashed instance topic and complete mutual Ed25519 handshakes over iroh.
 *   3. Alice sees Bob as `pending`, runs `TRUST`, and Bob becomes `trusted`.
 *   4. Bob restarts with the same persisted identity -> Alice auto-trusts Bob with zero prompt.
 *   5. Mallory joins the same instance claiming Bob's `usr_...` with a different key -> Alice flags
 *      Mallory as `key_mismatch`.
 */
import { assertEquals } from "jsr:@std/assert";
import { join } from "@std/path";
import { PostalService } from "../../submodules/stageforge/mod.ts";
import type { ActorId } from "../../submodules/stageforge/src/lib/types.ts";
import { irohCarrier } from "../../classes/irohCarrier.ts";
import type { VrcPeerInfo } from "../../petplay/vrcPeers.ts";

const INSTANCE =
  "wrld_266523e8-9161-40da-acd0-6bd82e075833:93162~hidden(usr_alice)~region(eu)";
const ALICE_ID = "usr_11111111-1111-1111-1111-111111111111";
const BOB_ID = "usr_22222222-2222-2222-2222-222222222222";

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

function makeLog(selfName: string, selfId: string, players: Array<[string, string]>): string {
  const lines = [
    `2026.11.20 19:30:00 Debug      -  [Authentication - X] Preforming post login checks for ${selfName} (${selfId})`,
    `2026.11.20 19:30:01 Debug      -  [Behaviour] Entering Room: Popcorn Palace`,
    `2026.11.20 19:30:01 Debug      -  [Behaviour] Joining ${INSTANCE}`,
    ...players.map(
      ([name, id]) => `2026.11.20 19:30:05 Debug      -  [Behaviour] OnPlayerJoined ${name} (${id})`,
    ),
  ];
  return lines.join("\n") + "\n";
}

function spawnPeer(relayUrl: string, logDir: string, identityPath: string, trustPath: string) {
  return new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--no-check",
      new URL("./peerChild.ts", import.meta.url).href,
      relayUrl,
      logDir,
      identityPath,
      trustPath,
    ],
    stdout: "null",
    stderr: "inherit",
  }).spawn();
}

Deno.test({
  name: "vrcPeers discovers instance peer over iroh, pins TOFU trust, auto-trusts on reconnect, and catches key mismatch",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const tmp = Deno.makeTempDirSync({ prefix: "petplay-vrcpeers-e2e-" });
    const aliceLogDir = join(tmp, "alice-logs");
    const bobLogDir = join(tmp, "bob-logs");
    const malloryLogDir = join(tmp, "mallory-logs");
    Deno.mkdirSync(aliceLogDir);
    Deno.mkdirSync(bobLogDir);
    Deno.mkdirSync(malloryLogDir);

    const players: Array<[string, string]> = [["Alice", ALICE_ID], ["Bob", BOB_ID]];
    Deno.writeTextFileSync(
      join(aliceLogDir, "output_log_2026-11-20_19-30-00.txt"),
      makeLog("Alice", ALICE_ID, players),
    );
    Deno.writeTextFileSync(
      join(bobLogDir, "output_log_2026-11-20_19-30-00.txt"),
      makeLog("Bob", BOB_ID, players),
    );
    Deno.writeTextFileSync(
      join(malloryLogDir, "output_log_2026-11-20_19-30-00.txt"),
      makeLog("Bob", BOB_ID, players),
    );

    const clients = new Set<WebSocket>();
    const relay = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onopen = () => clients.add(socket);
      socket.onclose = () => clients.delete(socket);
      socket.onmessage = (event) => {
        for (const client of clients) {
          if (client.readyState === WebSocket.OPEN) client.send(event.data);
        }
      };
      return response;
    });
    const relayUrl = `ws://127.0.0.1:${relay.addr.port}/`;

    const iroh = irohCarrier({ local: true });
    const postal = new PostalService();
    postal.registerRemoteCarrier(iroh);
    postal.initSignalingClient(relayUrl);
    const alice = await postal.add("../../petplay/vrcPeers.ts", import.meta.url);
    const call = <T>(target: ActorId, type: string, payload: unknown = null) =>
      postal.PostMessage({ target, type, payload }, true) as Promise<T>;

    await call(alice, "CONFIGURE", {
      logDir: aliceLogDir,
      identityPath: join(tmp, "alice-id.json"),
      trustPath: join(tmp, "alice-trust.json"),
      pollIntervalMs: 50,
    });

    const bobIdPath = join(tmp, "bob-id.json");
    const bobTrustPath = join(tmp, "bob-trust.json");
    let bobChild: Deno.ChildProcess | null = spawnPeer(relayUrl, bobLogDir, bobIdPath, bobTrustPath);
    let malloryChild: Deno.ChildProcess | null = null;

    try {
      // 1. Alice discovers Bob as `pending`.
      const [bob1] = await eventually(
        () => call<VrcPeerInfo[]>(alice, "LISTPEERS"),
        (list) => list.some((p) => p.vrcUserId === BOB_ID),
        "Alice discovers Bob on the instance topic",
      );
      assertEquals(bob1.displayName, "Bob");
      assertEquals(bob1.inInstance, true);
      assertEquals(bob1.trust, "pending");

      // 2. Alice trusts Bob (TOFU).
      await call(alice, "TRUST", { userId: BOB_ID });
      const peersAfterTrust = await call<VrcPeerInfo[]>(alice, "LISTPEERS");
      assertEquals(peersAfterTrust.find((p) => p.vrcUserId === BOB_ID)?.trust, "trusted");

      // 3. Bob leaves and restarts with the same persisted identity -> auto-trusted.
      bobChild.kill("SIGTERM");
      await bobChild.status;
      bobChild = null;
      await eventually(
        () => call<VrcPeerInfo[]>(alice, "LISTPEERS"),
        (list) => list.length === 0,
        "Alice sees Bob leave",
      );

      bobChild = spawnPeer(relayUrl, bobLogDir, bobIdPath, bobTrustPath);
      const [bob2] = await eventually(
        () => call<VrcPeerInfo[]>(alice, "LISTPEERS"),
        (list) => list.some((p) => p.vrcUserId === BOB_ID),
        "Alice rediscovers Bob after restart",
      );
      assertEquals(bob2.publicKey, bob1.publicKey);
      assertEquals(bob2.trust, "trusted");

      // 4. Mallory joins claiming Bob's userId with a different key -> flagged `key_mismatch`.
      bobChild.kill("SIGTERM");
      await bobChild.status;
      bobChild = null;
      await eventually(
        () => call<VrcPeerInfo[]>(alice, "LISTPEERS"),
        (list) => list.length === 0,
        "Alice sees Bob leave before Mallory joins",
      );

      malloryChild = spawnPeer(
        relayUrl,
        malloryLogDir,
        join(tmp, "mallory-id.json"),
        join(tmp, "mallory-trust.json"),
      );
      const [mallory] = await eventually(
        () => call<VrcPeerInfo[]>(alice, "LISTPEERS"),
        (list) => list.some((p) => p.vrcUserId === BOB_ID),
        "Alice sees Mallory claiming Bob's userId",
      );
      assertEquals(mallory.trust, "key_mismatch");
    } finally {
      if (bobChild) {
        bobChild.kill("SIGTERM");
        await bobChild.status.catch(() => {});
      }
      if (malloryChild) {
        malloryChild.kill("SIGTERM");
        await malloryChild.status.catch(() => {});
      }
      await call(alice, "SHUTDOWN").catch(() => {});
      postal.closeRemote("test done");
      await iroh.stop();
      for (const client of clients) client.close();
      await relay.shutdown();
      Deno.removeSync(tmp, { recursive: true });
    }
  },
});
