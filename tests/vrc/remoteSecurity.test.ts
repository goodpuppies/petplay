/**
 * End-to-end security tests for PetPlay's two-tier iroh transport and Stageforge remote policy:
 *
 * 1. Relay-only discovery vs. allowlisted direct P2P (mitigating iroh#3535):
 *    - Discovery endpoint (non-local, via local `iroh-relay --dev`) binds zero IP transports
 *      (`addrs: []`), so untrusted peers cannot harvest direct IPs.
 *    - Direct endpoint is created lazily, rejects unlisted peers in `after_handshake`, accepts
 *      allowlisted peers, and drops active direct connections on `revokeDirect`.
 * 2. Pre-trust vs. post-trust Stageforge remote policy (`petplayRemotePolicy`):
 *    - Before Trust (discovery tier), `EVALJS`, `TRUST`, `CONFIGURE`, `GRANTPEER`, and `SHAREALL`
 *      are all rejected over iroh.
 *    - After mutual Trust, `vrcPeers` upgrades the peer onto the direct P2P connection, where
 *      `EVALJS` (shared P2P compute) succeeds while local-only admin methods remain blocked.
 *    - After Untrust, the direct connection is revoked.
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { PostalService, resolveActorId, System } from "../../submodules/stageforge/mod.ts";
import type { ActorId } from "../../submodules/stageforge/src/lib/types.ts";
import { irohCarrier } from "../../classes/irohCarrier.ts";
import { petplayRemotePolicy } from "../../classes/remotePolicy.ts";
import { hasPetplayMediaBinary } from "../../classes/petplayMediaPath.ts";
import { startDevRelay } from "../iroh-topics/relay.ts";
import type { VrcPeerInfo } from "../../petplay/vrcPeers.ts";

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

function hasDevRelayBinary(): boolean {
  try {
    const path = Deno.env.get("PETPLAY_IROH_RELAY_BINARY") ??
      new URL("../../submodules/petplay_mediatransport/target/tools/bin/iroh-relay", import.meta.url);
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test({
  name: "iroh link: discovery endpoint is relay-only (no IPs) and direct endpoint enforces peer allowlist",
  ignore: !hasPetplayMediaBinary({ forLink: true }) || !hasDevRelayBinary(),
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const devRelay = await startDevRelay();
    const alice = irohCarrier({ relay: devRelay.url });
    const bob = irohCarrier({ relay: devRelay.url });
    const mallory = irohCarrier({ relay: devRelay.url });
    try {
      const aliceIncoming: Array<{ peer?: string; tier?: string; carrier: { send(d: unknown): void; onmessage: ((d: unknown) => void) | null; onclose: ((r?: string) => void) | null } }> = [];
      await alice.listen((carrier) => {
        aliceIncoming.push({ peer: carrier.peer, tier: carrier.tier, carrier });
      });
      await bob.listen(() => {});
      await mallory.listen(() => {});

      // 1. Discovery endpoint binds NO IP transports (mitigates iroh#3535).
      const aliceDisc = await alice.endpoint();
      assertEquals(aliceDisc.addrs, [], "discovery endpoint must have zero IP addresses");
      assert(typeof aliceDisc.relay === "string" && aliceDisc.relay.length > 0);

      // 2. Direct endpoint is a separate identity and rejects unlisted peers in after_handshake.
      const aliceDirect = await alice.directEndpoint();
      assertNotEquals(aliceDirect.id, aliceDisc.id, "direct endpoint must use a separate keypair");
      const bobDirect = await bob.directEndpoint();

      // In QUIC/iroh, `after_handshake` rejection closes the connection with `untrusted peer`
      // either during connect or immediately after the handshake completes.
      let malloryRejected = false;
      try {
        const malloryConn = await mallory.connectDirect(aliceDirect);
        const closeReason = await Promise.race([
          new Promise<string | undefined>((resolve) => {
            malloryConn.onclose = resolve;
          }),
          sleep(5_000).then(() => "__timeout__"),
        ]);
        malloryRejected = closeReason !== "__timeout__";
      } catch {
        malloryRejected = true;
      }
      assert(malloryRejected, "unlisted peer must be rejected on direct endpoint");
      assertEquals(
        aliceIncoming.some((c) => c.tier === "direct"),
        false,
        "Alice must never accept an unlisted direct peer",
      );

      // 3. Allowlisted peer connects on direct endpoint and exchanges messages.
      alice.allowDirect(bobDirect.id);
      const bobConn = await bob.connectDirect(aliceDirect);
      assertEquals(bobConn.tier, "direct");
      bobConn.send({ ping: 42 });

      const accepted = await eventually(
        async () => aliceIncoming.find((c) => c.tier === "direct" && c.peer === bobDirect.id),
        (c) => c !== undefined,
        "Alice accepts allowlisted direct peer",
      );
      const got = await new Promise<unknown>((resolve) => {
        accepted!.carrier.onmessage = resolve;
      });
      assertEquals(got, { ping: 42 });

      // 4. Revoking the peer immediately closes the direct connection and blocks reconnect.
      const closed = new Promise<string | undefined>((resolve) => {
        bobConn.onclose = resolve;
      });
      alice.revokeDirect(bobDirect.id);
      const reason = await closed;
      assert(reason?.includes("untrusted"), `expected untrusted close reason, got: ${reason}`);

      let reconnectRejected = false;
      try {
        const reconn = await bob.connectDirect(aliceDirect);
        const closeReason = await Promise.race([
          new Promise<string | undefined>((resolve) => {
            reconn.onclose = resolve;
          }),
          sleep(5_000).then(() => "__timeout__"),
        ]);
        reconnectRejected = closeReason !== "__timeout__";
      } catch {
        reconnectRejected = true;
      }
      assert(reconnectRejected, "revoked peer must be rejected on reconnect");
    } finally {
      await alice.stop();
      await bob.stop();
      await mallory.stop();
      await devRelay.stop();
    }
  },
});

const INSTANCE =
  "wrld_266523e8-9161-40da-acd0-6bd82e075833:77777~friends(usr_11111111-1111-1111-1111-111111111111)~region(eu)";
const ALICE_ID = "usr_11111111-1111-1111-1111-111111111111";
const BOB_ID = "usr_22222222-2222-2222-2222-222222222222";

function makeLog(selfName: string, selfId: string, players: Array<[string, string]>): string {
  return [
    `2026.11.26 09:00:00 Debug      -  [Authentication - X] Preforming post login checks for ${selfName} (${selfId})`,
    `2026.11.26 09:00:01 Debug      -  [Behaviour] Entering Room: Security Lab`,
    `2026.11.26 09:00:01 Debug      -  [Behaviour] Joining ${INSTANCE}`,
    ...players.map(
      ([name, id]) => `2026.11.26 09:00:05 Debug      -  [Behaviour] OnPlayerJoined ${name} (${id})`,
    ),
  ].join("\n") + "\n";
}

Deno.test({
  name: "petplayRemotePolicy blocks EVALJS and admin ops before trust, upgrades to direct P2P EVALJS after trust",
  ignore: !hasPetplayMediaBinary({ forLink: true }),
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const tmp = Deno.makeTempDirSync({ prefix: "petplay-remote-sec-" });
    const aliceLogDir = join(tmp, "alice-logs");
    const bobLogDir = join(tmp, "bob-logs");
    Deno.mkdirSync(aliceLogDir);
    Deno.mkdirSync(bobLogDir);
    const players: Array<[string, string]> = [["Alice", ALICE_ID], ["Bob", BOB_ID]];
    Deno.writeTextFileSync(join(aliceLogDir, "output_log_1.txt"), makeLog("Alice", ALICE_ID, players));
    Deno.writeTextFileSync(join(bobLogDir, "output_log_1.txt"), makeLog("Bob", BOB_ID, players));

    const noSecretPath = join(tmp, "none.secret");
    const prevSecret = Deno.env.get("PETPLAY_HOUSEHOLD_SECRET");
    const prevSecretFile = Deno.env.get("PETPLAY_HOUSEHOLD_SECRET_FILE");
    Deno.env.delete("PETPLAY_HOUSEHOLD_SECRET");
    Deno.env.set("PETPLAY_HOUSEHOLD_SECRET_FILE", noSecretPath);

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
    postal.setRemotePolicy(petplayRemotePolicy());
    postal.registerRemoteCarrier(iroh);
    postal.initSignalingClient(relayUrl);

    const bobPeers = resolveActorId(await postal.add("../../petplay/vrcPeers.ts", import.meta.url));
    const bobCaller = resolveActorId(await postal.add("./actorCaller.ts", import.meta.url));
    const call = <T>(target: ActorId, type: string, payload: unknown = null) =>
      postal.PostMessage({ target, type, payload }, true) as Promise<T>;
    const callRemote = <T>(target: ActorId, type: string, payload: unknown = null) =>
      call<T>(bobCaller, "CALL", { target, type, payload });

    await call(bobPeers, "CONFIGURE", {
      logDir: bobLogDir,
      identityPath: join(tmp, "bob-id.json"),
      trustPath: join(tmp, "bob-trust.json"),
      pollIntervalMs: 50,
    });

    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--no-check",
        new URL("./shareChild.ts", import.meta.url).href,
        relayUrl,
        aliceLogDir,
        join(tmp, "alice-id.json"),
        join(tmp, "alice-trust.json"),
      ],
      env: {
        PETPLAY_HOUSEHOLD_SECRET: "",
        PETPLAY_HOUSEHOLD_SECRET_FILE: noSecretPath,
        PETPLAY_ENABLE_REMOTE_POLICY: "1",
      },
      stdin: "piped",
      stdout: "piped",
      stderr: "inherit",
    }).spawn();

    const childWriter = child.stdin.getWriter();
    const childReader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let nextCmdId = 1;
    let resolveReady!: (v: { share: ActorId; vrcPeers: ActorId }) => void;
    const childReady = new Promise<{ share: ActorId; vrcPeers: ActorId }>((r) => resolveReady = r);

    void (async () => {
      let buf = "";
      while (true) {
        const { value, done } = await childReader.read();
        if (done) break;
        buf += value;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("@@JSON ")) continue;
          const msg = JSON.parse(line.slice("@@JSON ".length));
          if (msg.ready) resolveReady(msg);
          else if (typeof msg.id === "number") {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            if (p) msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
          }
        }
      }
    })();

    const aliceCmd = <T>(op: string, payload?: unknown): Promise<T> => {
      const id = nextCmdId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        void childWriter.write(new TextEncoder().encode(JSON.stringify({ id, op, payload }) + "\n"));
      });
    };

    try {
      const { share: aliceShare, vrcPeers: alicePeers } = await childReady;

      // 1. Wait for mutual discovery on the relay-only discovery connection.
      await eventually(
        () => call<VrcPeerInfo[]>(bobPeers, "LISTPEERS"),
        (list) => list.some((p) => p.vrcUserId === ALICE_ID && p.trust === "pending"),
        "Bob discovers Alice",
      );
      await eventually(
        () => aliceCmd<VrcPeerInfo[]>("PEERS"),
        (list) => list.some((p) => p.vrcUserId === BOB_ID && p.trust === "pending"),
        "Alice discovers Bob",
      );

      // 2. BEFORE TRUST: EVALJS, GRANTPEER, SHAREALL, and TRUST must all be rejected!
      await assertRejects(
        () => callRemote(alicePeers, "EVALJS", { code: "1 + 1" }),
        Error,
        "rejected by policy",
      );
      await assertRejects(
        () => callRemote(alicePeers, "TRUST", { userId: BOB_ID }),
        Error,
        "rejected by policy",
      );
      await assertRejects(
        () => callRemote(aliceShare, "GRANTPEER", { peerKey: "attacker" }),
        Error,
        "rejected by policy",
      );
      await assertRejects(
        () => callRemote(aliceShare, "SHAREALL", null),
        Error,
        "rejected by policy",
      );

      // 3. MUTUAL TRUST -> peers automatically upgrade onto their direct P2P endpoint!
      await aliceCmd("TRUST", { userId: BOB_ID });
      await call(bobPeers, "TRUST", { userId: ALICE_ID });

      await eventually(
        async () =>
          postal.remoteConnections().some((c) =>
            c.tier === "direct" && c.routes().includes(alicePeers)
          ),
        (upgraded) => upgraded === true,
        "Bob upgrades Alice to direct P2P connection after mutual trust",
      );

      // 4. AFTER TRUST (direct P2P): EVALJS succeeds (shared compute works!) while local-only admin stays blocked.
      const evalRes = await callRemote<{ ok: boolean; inspected: string }>(
        alicePeers,
        "EVALJS",
        { code: "21 + 21" },
      );
      assertEquals(evalRes.ok, true);
      assertEquals(evalRes.inspected, "42");

      await assertRejects(
        () => callRemote(alicePeers, "TRUST", { userId: "usr_someone_else" }),
        Error,
        "rejected by policy",
      );
      await assertRejects(
        () => callRemote(aliceShare, "SHAREALL", null),
        Error,
        "rejected by policy",
      );

      // 5. UNTRUST -> direct connection is revoked.
      await aliceCmd("UNTRUST", { userId: BOB_ID });
      await eventually(
        async () => postal.remoteConnections().filter((c) => c.tier === "direct").length,
        (count) => count === 0,
        "direct connection closes when Alice untrusts Bob",
      );
    } finally {
      if (prevSecret !== undefined) Deno.env.set("PETPLAY_HOUSEHOLD_SECRET", prevSecret);
      else Deno.env.delete("PETPLAY_HOUSEHOLD_SECRET");
      if (prevSecretFile !== undefined) Deno.env.set("PETPLAY_HOUSEHOLD_SECRET_FILE", prevSecretFile);
      else Deno.env.delete("PETPLAY_HOUSEHOLD_SECRET_FILE");
      try {
        await childWriter.close();
      } catch { /* closed */ }
      child.kill("SIGTERM");
      await child.status.catch(() => {});
      await postal.shutdown(bobPeers, { bestEffort: true });
      await postal.shutdown(bobCaller, { bestEffort: true });
      postal.closeRemote("test done");
      await iroh.stop();
      for (const client of clients) client.close();
      await relay.shutdown();
      Deno.removeSync(tmp, { recursive: true });
    }
  },
});
