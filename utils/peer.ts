/**
 * `deno task peer`: an agent's (or a person's) access to a trusted coop peer's running PetPlay
 * over the trusted link, through this machine's agent REPL — enough to develop and debug a feature
 * on both machines without CI. The peer answers only with Peer Code Patches on.
 *
 *   deno task peer list                          # peers this PetPlay knows, and their trust
 *   deno task peer blise status                  # build, channel, link path, actors (a probe)
 *   deno task peer blise log [--lines 300] [--grep RE]
 *   deno task peer blise actors
 *   deno task peer blise eval webxr 'return Object.keys(globalThis).length'
 *   deno task peer blise health displayShare
 *
 * `eval` runs JavaScript inside one of the peer's actors (stageforge EVALJS), which the peer allows
 * a trusted direct-tier connection only while it has Peer Code Patches on (classes/remotePolicy.ts). Code changes go with
 * `deno task peer-patch` (function bodies, live) and `deno task peer-build` (anything, restart).
 */
import type { PeerProbe, PeerProbeReply } from "../classes/peerProbe.ts";
import { DEFAULT_REPL_PORT, peerCall, replPost, unwrap } from "./peerRepl.ts";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function probe(port: number, peer: string): Promise<{ peer: string; probe: PeerProbe }> {
  const call = await peerCall<PeerProbeReply>(port, peer, "PEERPROBE");
  return { peer: call.peer, probe: unwrap(call.peer, call.reply).probe };
}

async function actorId(port: number, peer: string, actor: string): Promise<string> {
  if (actor.includes("@")) return actor;
  const { probe: p } = await probe(port, peer);
  const matches = (p.actors ?? []).filter((a) => a.name === actor);
  if (matches.length === 0) {
    throw new Error(
      `${peer} has no actor ${actor}: ${(p.actors ?? []).map((a) => a.name).join(", ")}`,
    );
  }
  return matches[0]!.actorId;
}

async function main(args: string[]): Promise<void> {
  const port = Number(flag(args, "--repl-port") ?? DEFAULT_REPL_PORT);
  const [peer, command = "status", ...rest] = args.filter((a, i) =>
    a !== "--repl-port" && args[i - 1] !== "--repl-port"
  );
  if (!peer) throw new Error("usage: deno task peer list | <peer> status|log|actors|eval|health …");
  if (peer === "list") {
    const peers = await replPost<
      Array<{ displayName: string; trust: string; inInstance: boolean; actorId: string }>
    >(
      port,
      "/message",
      { target: "vrcPeers", type: "LISTPEERS", reply: true },
      5_000,
    );
    for (const p of peers) {
      console.log(
        `${p.displayName}\t${p.trust}\t${p.inInstance ? "in instance" : "elsewhere"}\t${p.actorId}`,
      );
    }
    return;
  }
  switch (command) {
    case "status": {
      const { peer: name, probe: p } = await probe(port, peer);
      console.log(
        `${name}: ${p.build.version} (${
          p.build.target ?? "?"
        }, ${p.build.mode}, channel ${p.updateChannel})`,
      );
      console.log(`peer code patches: ${p.acceptPeerPatches ? "on" : "off"}`);
      for (const link of p.links ?? []) {
        console.log(
          `link ${link.tier} ${link.peer.slice(0, 10)}: ${
            link.path
              ? `${link.path.path} via ${link.path.remote}, ${link.path.rttMs} ms`
              : "path unknown"
          }`,
        );
      }
      console.log(
        `shares: ${(p.sharing?.shared ?? []).map((s) => s.name).join(", ") || "nothing"}`,
      );
      console.log(`shows: ${(p.viewing ?? []).map((v) => v.name).join(", ") || "nothing"}`);
      console.log(`actors: ${(p.actors ?? []).map((a) => a.name).join(", ")}`);
      for (const line of p.logErrors.slice(-5)) console.log(`recent error: ${line}`);
      return;
    }
    case "actors": {
      const { probe: p } = await probe(port, peer);
      for (const a of p.actors ?? []) console.log(`${a.name}\t${a.actorId}`);
      return;
    }
    case "log": {
      const lines = Number(flag(rest, "--lines") ?? 200);
      const grep = flag(rest, "--grep");
      const call = await peerCall<{ ok: boolean; error?: string; lines?: string[] }>(
        port,
        peer,
        "PEERLOG",
        { lines, grep },
        30_000,
      );
      for (const line of unwrap(call.peer, call.reply).lines ?? []) console.log(line);
      return;
    }
    case "eval": {
      const [actor, ...code] = rest;
      if (!actor || code.length === 0) {
        throw new Error("usage: deno task peer <peer> eval <actor> <code>");
      }
      const target = await actorId(port, peer, actor);
      const result = await replPost(port, "/eval", {
        target,
        code: code.join(" "),
        timeoutMs: 20_000,
      }, 20_000);
      console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
      return;
    }
    case "health": {
      const [actor] = rest;
      if (!actor) throw new Error("usage: deno task peer <peer> health <actor>");
      const target = await actorId(port, peer, actor);
      const result = await replPost(
        port,
        "/message",
        { target, type: "HEALTH", reply: true, timeoutMs: 10_000 },
        10_000,
      );
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    default:
      throw new Error(`unknown command ${command}`);
  }
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
