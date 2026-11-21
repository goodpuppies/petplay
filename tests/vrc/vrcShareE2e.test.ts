/**
 * Synthesized end-to-end VRChat display-sharing test (no VRChat dummy account, no `.secret` file):
 *
 *   1. Alice (child process) and Bob (this process) join the same synthesized VRChat instance via
 *      `output_log_*.txt` and connect over real loopback iroh + local topic relay.
 *   2. Alice shares `DISPLAY1` (view-only) and `DISPLAY2` (with input) via real `displayShare`.
 *   3. Before mutual TOFU trust, Bob's `householdDesktops` sees 0 screens.
 *   4. Alice and Bob mutually TOFU-trust each other -> `vrcPeers` grants a per-peer capability
 *      token on `displayShare` and sends `SHAREOFFER` over iroh -> Bob's `householdDesktops`
 *      automatically discovers `Alice1` (view-only) and `Alice2` (input allowed).
 *   5. Bob checks `INPUTTARGET`: `null` for `Alice1`, valid `{actor, proof, region}` for `Alice2`.
 *   6. Bob sends a pointer `INPUT` to `Alice2` with that proof -> Alice's `mockDesktopInput`
 *      receives it! Sending an `INPUT` aimed at `DISPLAY1`'s region is refused by `displayShare`.
 *   7. Alice untrusts Bob -> `REVOKEPEER` invalidates Bob's token immediately -> Bob's old proof
 *      is rejected!
 *   8. Bob leaves the VRChat room (`OnLeftRoom`) -> Bob's `householdDesktops` clears Alice's
 *      screens immediately.
 */
import { assertEquals, assertRejects } from "jsr:@std/assert";
import { join } from "@std/path";
import { PostalService, resolveActorId } from "../../submodules/stageforge/mod.ts";
import type { ActorId } from "../../submodules/stageforge/src/lib/types.ts";
import { irohCarrier } from "../../classes/irohCarrier.ts";
import type { WorkspaceOutput } from "../../classes/environment/workspaceDisplays.ts";
import type { VrcPeerInfo } from "../../petplay/vrcPeers.ts";

const INSTANCE =
  "wrld_266523e8-9161-40da-acd0-6bd82e075833:42424~friends(usr_11111111-1111-1111-1111-111111111111)~region(eu)";
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
  return [
    `2026.11.21 23:15:00 Debug      -  [Authentication - X] Preforming post login checks for ${selfName} (${selfId})`,
    `2026.11.21 23:15:01 Debug      -  [Behaviour] Entering Room: Popcorn Palace`,
    `2026.11.21 23:15:01 Debug      -  [Behaviour] Joining ${INSTANCE}`,
    ...players.map(
      ([name, id]) =>
        `2026.11.21 23:15:05 Debug      -  [Behaviour] OnPlayerJoined ${name} (${id})`,
    ),
  ].join("\n") + "\n";
}

Deno.test({
  name: "synthesized E2E: VRC instance discovery + TOFU trust -> per-display sharing, input gating, and revocation without .secret",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const tmp = Deno.makeTempDirSync({ prefix: "petplay-vrcshare-e2e-" });
    const aliceLogDir = join(tmp, "alice-logs");
    const bobLogDir = join(tmp, "bob-logs");
    Deno.mkdirSync(aliceLogDir);
    Deno.mkdirSync(bobLogDir);

    const players: Array<[string, string]> = [["Alice", ALICE_ID], ["Bob", BOB_ID]];
    const bobLogFile = join(bobLogDir, "output_log_2026-11-21_23-15-00.txt");
    Deno.writeTextFileSync(
      join(aliceLogDir, "output_log_2026-11-21_23-15-00.txt"),
      makeLog("Alice", ALICE_ID, players),
    );
    Deno.writeTextFileSync(bobLogFile, makeLog("Bob", BOB_ID, players));

    // Prove no household `.secret` is used in either process.
    const noSecretPath = join(tmp, "does-not-exist.secret");
    const prevSecretEnv = Deno.env.get("PETPLAY_HOUSEHOLD_SECRET");
    const prevSecretFileEnv = Deno.env.get("PETPLAY_HOUSEHOLD_SECRET_FILE");
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
    postal.registerRemoteCarrier(iroh);
    postal.initSignalingClient(relayUrl);

    const bobDesktops = resolveActorId(
      await postal.add("../../petplay/householdDesktops.ts", import.meta.url),
    );
    const bobPeers = resolveActorId(
      await postal.add("../../petplay/vrcPeers.ts", import.meta.url),
    );
    const bobCaller = resolveActorId(
      await postal.add("./actorCaller.ts", import.meta.url),
    );
    const call = <T>(target: ActorId, type: string, payload: unknown = null) =>
      postal.PostMessage({ target, type, payload }, true) as Promise<T>;
    /** Sends from a local actor (`bobCaller`), since `System` messages never cross RemoteConnection. */
    const callRemote = <T>(target: ActorId, type: string, payload: unknown = null) =>
      call<T>(bobCaller, "CALL", { target, type, payload });

    await call(bobPeers, "ASSIGNSHARING", { householdDesktops: bobDesktops });
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
          if (msg.ready) {
            resolveReady(msg);
          } else if (typeof msg.id === "number") {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            if (p) {
              if (msg.ok) p.resolve(msg.result);
              else p.reject(new Error(msg.error));
            }
          }
        }
      }
    })();

    const aliceCmd = <T>(op: string, payload?: unknown): Promise<T> => {
      const id = nextCmdId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        void childWriter.write(
          new TextEncoder().encode(JSON.stringify({ id, op, payload }) + "\n"),
        );
      });
    };

    try {
      await childReady;

      // 1. Both sides discover each other on the hashed VRChat instance topic.
      await eventually(
        () => call<VrcPeerInfo[]>(bobPeers, "LISTPEERS"),
        (list) => list.some((p) => p.vrcUserId === ALICE_ID && p.trust === "pending"),
        "Bob discovers Alice as pending",
      );
      await eventually(
        () => aliceCmd<VrcPeerInfo[]>("PEERS"),
        (list) => list.some((p) => p.vrcUserId === BOB_ID && p.trust === "pending"),
        "Alice discovers Bob as pending",
      );

      // 2. Before trust, Bob sees no displays from Alice.
      assertEquals((await call<WorkspaceOutput[]>(bobDesktops, "LIST")).length, 0);

      // 3. Mutual TOFU trust -> Alice grants Bob a per-peer token and sends SHAREOFFER over iroh.
      await aliceCmd("TRUST", { userId: BOB_ID });
      await call(bobPeers, "TRUST", { userId: ALICE_ID });

      // 4. Bob's householdDesktops automatically lists Alice1 (view-only) and Alice2 (with input).
      const outputs = await eventually(
        () => call<WorkspaceOutput[]>(bobDesktops, "LIST"),
        (list) => list.length === 2,
        "Bob sees Alice1 and Alice2 after mutual TOFU trust",
      );
      assertEquals(outputs.map((o) => o.name).sort(), ["Alice1", "Alice2"]);

      // 5. Input gating: DISPLAY1 (Alice:0) has no input target; DISPLAY2 (Alice:1) has one.
      const target1 = await call<unknown>(bobDesktops, "INPUTTARGET", { desktop: "Alice:0" });
      assertEquals(target1, null);
      const target2 = await call<{ actor: ActorId; proof: string; region?: unknown } | null>(
        bobDesktops,
        "INPUTTARGET",
        { desktop: "Alice:1" },
      );
      assertEquals(target2 !== null, true);

      // 6. Bob sends INPUT into DISPLAY2's region (x=0.75) -> delivered to Alice's mockDesktopInput!
      const accepted = await callRemote<boolean>(target2!.actor, "GUARDED", {
        proof: target2!.proof,
        type: "INPUT",
        payload: { t: "pointer", x: 0.75, y: 0.5 },
      });
      assertEquals(accepted, true);
      // Sending INPUT into DISPLAY1's region (x=0.25) is refused even with a valid token.
      const refused = await callRemote<boolean>(target2!.actor, "GUARDED", {
        proof: target2!.proof,
        type: "INPUT",
        payload: { t: "pointer", x: 0.25, y: 0.5 },
      });
      assertEquals(refused, false);
      const events = await aliceCmd<unknown[]>("INPUTEVENTS");
      assertEquals(events.length, 1);

      // 7. Alice untrusts Bob -> token revoked immediately on Alice's displayShare!
      await aliceCmd("UNTRUST", { userId: BOB_ID });
      await assertRejects(
        () =>
          callRemote(target2!.actor, "GUARDED", {
            proof: target2!.proof,
            type: "DESCRIBE",
            payload: null,
          }),
        Error,
        "not authorized",
      );

      // 8. Bob leaves the VRChat room -> householdDesktops clears Alice's screens immediately.
      Deno.writeTextFileSync(
        bobLogFile,
        "2026.11.21 23:16:00 Debug      -  [Behaviour] OnLeftRoom\n",
        { append: true },
      );
      await eventually(
        () => call<WorkspaceOutput[]>(bobDesktops, "LIST"),
        (list) => list.length === 0,
        "Bob clears Alice's screens after OnLeftRoom",
      );
    } finally {
      if (prevSecretEnv !== undefined) Deno.env.set("PETPLAY_HOUSEHOLD_SECRET", prevSecretEnv);
      else Deno.env.delete("PETPLAY_HOUSEHOLD_SECRET");
      if (prevSecretFileEnv !== undefined) {
        Deno.env.set("PETPLAY_HOUSEHOLD_SECRET_FILE", prevSecretFileEnv);
      } else {
        Deno.env.delete("PETPLAY_HOUSEHOLD_SECRET_FILE");
      }
      try {
        await childWriter.close();
      } catch { /* already closed */ }
      child.kill("SIGTERM");
      await child.status.catch(() => {});
      await call(bobPeers, "SHUTDOWN").catch(() => {});
      await call(bobDesktops, "SHUTDOWN").catch(() => {});
      postal.closeRemote("test done");
      await iroh.stop();
      for (const client of clients) client.close();
      await relay.shutdown();
      Deno.removeSync(tmp, { recursive: true });
    }
  },
});
