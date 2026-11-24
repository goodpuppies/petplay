/**
 * Two machines' worth of processes on this one: the household agent (`rdp/agent.ts`, a stand-in
 * capture helper, the real encoder) and, in this process, the rdp UI actor with the same
 * household secret. Through a local topic server and dev relay, the UI finds the agent's desktop,
 * learns its machine and input, and starts its video; the agent's actors take guarded requests
 * only.
 *
 * Needs PETPLAY_LINK_BINARY and PETPLAY_MEDIA_BINARY pointing at a `petplay-media` with the
 * encoder and the iroh link (`cargo build --release --features iroh`), and iroh-relay
 * (target/tools).
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { PostalService } from "../../submodules/stageforge/mod.ts";
import type { ActorId } from "../../submodules/stageforge/src/lib/types.ts";
import { irohCarrier } from "../../classes/irohCarrier.ts";
import { startDevRelay } from "../../tests/iroh-topics/relay.ts";
import { householdProof, householdTopic } from "../classes/household.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 60_000) {
  const until = Date.now() + ms;
  let value = await read();
  while (!ok(value)) {
    if (Date.now() > until) throw new Error(`${what}: last ${JSON.stringify(value)}`);
    await sleep(250);
    value = await read();
  }
  return value;
}

Deno.test({
  name: "the UI finds another machine's desktop through the household, and only proofs reach it",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "pp-rdp-home-" });
    const helper = `${dir}/helper.sh`;
    await Deno.writeTextFile(
      helper,
      `#!/bin/sh\necho "$@" >> "${dir}/args"\necho "🎥 Started capture. Press Enter to stop..."\nexec cat >> "${dir}/stdin"\n`,
    );
    await Deno.chmod(helper, 0o755);
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
    const secret = "household-test-secret-0123456789";
    const mediaPort = 47600 + Math.floor(Math.random() * 200) * 2;

    const agent = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--no-check",
        new URL("../agent.ts", import.meta.url).pathname,
        "--host=127.0.0.1",
        `--media-port=${mediaPort}`,
        `--topics=${topicUrl}`,
        `--relay=${relay.url}`,
      ],
      env: {
        PETPLAY_HOUSEHOLD_SECRET: secret,
        PETPLAY_SCREEN_STREAMER: helper,
        PETPLAY_INPUT_X11_WHEEL: "0",
      },
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const agentLog: string[] = [];
    for (const stream of [agent.stdout, agent.stderr]) {
      void (async () => {
        for await (const chunk of stream.pipeThrough(new TextDecoderStream())) agentLog.push(chunk);
      })().catch(() => {});
    }

    PostalService.actors.clear();
    const postal = new PostalService();
    const iroh = irohCarrier({ relay: relay.url });
    postal.registerRemoteCarrier(iroh);
    postal.initSignalingClient(topicUrl);
    const call = <T>(target: ActorId, type: string, payload: unknown = null) =>
      postal.PostMessage({ target, type, payload }, true) as Promise<T>;
    try {
      const ui = await postal.add("../ui.tsx", import.meta.url);
      await call(ui, "START", {
        secret: "session-secret-0123456789abcdef",
        webtransport: false,
        household: { secret, topic: await householdTopic(secret) },
      });
      type Health = {
        desktops: Array<{ source: string; machine: string; local: boolean; feed: boolean }>;
        selected: string | null;
        feed: { host: string; port: number; fingerprint: string } | null;
      };
      const health = await eventually(
        () => call<Health>(ui, "__HEALTH__"),
        (h) => h.feed != null,
        `the agent's desktop is found and its video started (agent: ${agentLog.join("").slice(-400)})`,
      );
      assertEquals(health.desktops.length, 1);
      assertEquals(health.desktops[0].machine, Deno.hostname());
      assertEquals(health.desktops[0].local, false);
      assertEquals(health.feed!.port, mediaPort);
      assert(/^[0-9a-f]{64}$/.test(health.feed!.fingerprint), health.feed!.fingerprint);

      // The agent's actors, as the UI knows them; the test talks to them through a probe actor.
      const probe = await postal.add("./probe.ts", import.meta.url);
      const remote = async <T>(target: ActorId, type: string, payload: unknown = null) => {
        const reply = await call<{ ok: boolean; value?: T; error?: string }>(probe, "CALL", {
          target,
          type,
          payload,
        });
        if (!reply.ok) throw new Error(reply.error);
        return reply.value as T;
      };
      const source = health.desktops[0].source as ActorId;
      const { input } = await remote<{ input: ActorId }>(source, "GUARDED", {
        proof: await householdProof(secret, source),
        type: "DESCRIBE",
      });
      await assertRejects(() => remote(input, "INPUT", { t: "key", scan: "1e", down: true }));
      await assertRejects(() =>
        remote(input, "GUARDED", {
          proof: "0".repeat(64),
          type: "INPUT",
          payload: { t: "key", scan: "1e", down: true },
        })
      );
      // A proof made for another actor (the source) does not open the input.
      await assertRejects(async () =>
        remote(input, "GUARDED", {
          proof: await householdProof(secret, source),
          type: "INPUT",
          payload: { t: "key", scan: "1e", down: true },
        })
      );
      assertEquals(
        await remote(input, "GUARDED", {
          proof: await householdProof(secret, input),
          type: "INPUT",
          payload: { t: "key", scan: "1e", down: true },
        }),
        true,
      );
      await eventually(lines, (l) => l.includes("K,1E,1"), "the guarded key reaches the helper");
      assertEquals(await lines(), ["K,1E,1"], "nothing unguarded got through");
      const args = (await Deno.readTextFile(`${dir}/args`)).trim().split("\n");
      assert(args.some((a) => a.includes("--media-socket=")), args.join(" | "));
    } finally {
      await postal.shutdownAll({ timeoutMs: 2000, bestEffort: true });
      postal.closeRemote("test done");
      await iroh.stop();
      try {
        agent.kill("SIGTERM");
      } catch { /* gone */ }
      await Promise.race([agent.status, sleep(8000)]);
      for (const client of clients) client.close();
      await topics.shutdown();
      await relay.stop();
      PostalService.actors.clear();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
