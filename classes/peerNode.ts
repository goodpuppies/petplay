/**
 * `petplay --peer-node=NAME --peer-with=OTHER[,…]`: PetPlay's coop side without VR. It runs the
 * same peer networking a full PetPlay runs (real iroh, the real topic server, `vrcPeers` with its
 * handshake, trust store and remote policy) plus the agent REPL, and nothing else: no SteamVR, no
 * GPU, no window. So a coop feature's networking, `deno task peer …`, `peer-patch`, `peer-build`
 * and `coop:verify` can be checked against a real second machine over a real network from an SSH
 * session, with nobody in VR.
 *
 * VRChat is synthesized: the node writes a VRChat log in which NAME is in a private test instance
 * (`--peer-instance=WORD`, default `petplay-peer-node`) together with every `--peer-with` name,
 * so vrcPeers on two nodes started as `--peer-node=a --peer-with=b` and `--peer-node=b
 * --peer-with=a` find each other. Trust them once through the REPL (`vrcPeers` `TRUST
 * {displayName}`) on both sides; the trust store persists.
 *
 * Everything it writes (identity, trust, settings with Peer Code Patches on, the VRChat log) lives
 * in `<state dir>/peer-node/NAME`, never in the real PetPlay's files. A compiled build run this
 * way logs and restarts like any release run (classes/runLog.ts), so a `peer-build` sent to it
 * installs over the executable it runs from and comes back up as the new build.
 */
import { join } from "@std/path";
import { stateDir } from "./appPaths.ts";
import { listenForProcessExitRequests, RESTART_EXIT_CODE } from "./processExitRequest.ts";

export const PEER_NODE_FLAG = "--peer-node=";

export type PeerNodeOptions = {
  name: string;
  peers: string[];
  instance: string;
  replPort: number;
  topicUrl: string;
};

function argValue(args: readonly string[], prefix: string): string | undefined {
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

/** `null` unless the arguments ask for a peer node. */
export function parsePeerNodeArgs(args: readonly string[]): PeerNodeOptions | null {
  const name = argValue(args, PEER_NODE_FLAG);
  if (name == null) return null;
  if (!/^[\w-]{1,32}$/.test(name)) {
    throw new Error(`--peer-node name must be [A-Za-z0-9_-]: ${name}`);
  }
  return {
    name,
    peers: (argValue(args, "--peer-with=") ?? "").split(",").map((p) => p.trim()).filter(Boolean),
    instance: argValue(args, "--peer-instance=") ?? "petplay-peer-node",
    replPort: Number(argValue(args, "--agent-repl-port=") ?? 3987),
    topicUrl: Deno.env.get("PETPLAY_TOPIC_URL") ?? "wss://topic.petplay.fi",
  };
}

/** A stable VRChat-shaped user id for a node name, the same on every machine. */
export async function peerNodeUserId(name: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`petplay-peer-node:${name}`)),
  );
  const hex = [...digest.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `usr_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
    hex.slice(20, 32)
  }`;
}

/**
 * The VRChat log of `self` in an instance with all of `players` (self included). The instance id
 * depends only on `instance` and the players, so every node of one test computes the same one.
 */
export async function synthesizedVrcLog(
  self: string,
  players: readonly string[],
  instance: string,
  at = new Date(),
): Promise<string> {
  const pad = (n: number) => String(n).padStart(2, "0");
  const t = `${at.getFullYear()}.${pad(at.getMonth() + 1)}.${pad(at.getDate())} ${
    at.toTimeString().slice(0, 8)
  }`;
  const everyone = [...new Set([self, ...players])].sort();
  const owner = await peerNodeUserId(everyone[0]!);
  const instanceId =
    `wrld_00000000-0000-4000-8000-000000000000:${instance}~private(${owner})~region(eu)`;
  const lines = [
    `${t} Debug      -  [Authentication - X] Preforming post login checks for ${self} (${await peerNodeUserId(
      self,
    )})`,
    `${t} Debug      -  [Behaviour] Entering Room: PetPlay peer node`,
    `${t} Debug      -  [Behaviour] Joining ${instanceId}`,
  ];
  for (const name of everyone) {
    lines.push(
      `${t} Debug      -  [Behaviour] OnPlayerJoined ${name} (${await peerNodeUserId(name)})`,
    );
  }
  return lines.join("\n") + "\n";
}

/** Runs until Ctrl-C, or until a peer build asks for a restart. */
export async function runPeerNode(options: PeerNodeOptions): Promise<number> {
  const dir = join(stateDir(), "peer-node", options.name);
  const logDir = join(dir, "vrc-logs");
  await Deno.mkdir(logDir, { recursive: true });
  // Its own settings: Peer Code Patches on (the opt-in for probes, patches, builds, eval).
  const settingsPath = join(dir, "settings.json");
  try {
    await Deno.stat(settingsPath);
  } catch {
    await Deno.writeTextFile(settingsPath, JSON.stringify({ acceptPeerPatches: true }, null, 2));
  }
  // A checkout has no logging parent (classes/runLog.ts): run the node as a child and keep its
  // output in the node's own log, which `deno task peer NAME log` and the probe read.
  if (!Deno.build.standalone && !Deno.env.get("PETPLAY_PROBE_LOG")) {
    return await runLogged(join(dir, "node.log"));
  }
  Deno.env.set("PETPLAY_SETTINGS_PATH", settingsPath);
  Deno.env.set("PETPLAY_VRC_TRUST_PATH", join(dir, "trust.json"));
  Deno.env.set("PETPLAY_AGENT_REPL_PORT", String(options.replPort));
  const log = await synthesizedVrcLog(options.name, options.peers, options.instance);
  for (const entry of Deno.readDirSync(logDir)) Deno.removeSync(join(logDir, entry.name));
  await Deno.writeTextFile(join(logDir, "output_log_2026-01-01_00-00-00.txt"), log);

  const { PostalService, resolveActorId } = await import("../submodules/stageforge/mod.ts");
  const { launchedFrom } = await import("./launchedFrom.ts");
  const { irohCarrier } = await import("./irohCarrier.ts");
  const { petplayRemotePolicy } = await import("./remotePolicy.ts");
  const { getBuildInfo, describeBuild } = await import("./buildInfo.ts");

  const postal = new PostalService();
  PostalService.performanceLoggingActive = false;
  const carrier = irohCarrier();
  postal.setRemotePolicy(petplayRemotePolicy());
  postal.registerRemoteCarrier(carrier);
  postal.functions = {
    ...postal.functions,
    IROH_CONNECTIONS: () => carrier.connections(),
  };
  postal.initSignalingClient(options.topicUrl);

  const vrcPeers = resolveActorId(await postal.add("../petplay/vrcPeers.ts", import.meta.url));
  const repl = resolveActorId(await postal.add("../petplay/agentRepl.ts", import.meta.url));
  const call = (target: string, type: string, payload: unknown = null) =>
    postal.PostMessage({ target, type, payload }, true);
  await call(vrcPeers, "CONFIGURE", {
    logDir,
    identityPath: join(dir, "identity.json"),
    trustPath: join(dir, "trust.json"),
    pollIntervalMs: 500,
  });
  postal.PostMessage({
    target: repl,
    type: "REGISTER_ACTORS",
    payload: { vrcPeers, agentRepl: repl },
  });

  const userId = await peerNodeUserId(options.name);
  console.log(
    `peer node ${options.name} (${userId}) on ${describeBuild()} [${getBuildInfo().target}]; ` +
      `instance ${options.instance} with ${options.peers.join(", ") || "nobody"}; ` +
      `agent REPL http://127.0.0.1:${options.replPort}; state ${dir}`,
  );

  return await new Promise<number>((resolve) => {
    let stopping = false;
    const stop = async (code: number, reason: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`peer node stopping: ${reason}`);
      postal.closeRemote(reason);
      await Promise.race([carrier.stop().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
      resolve(code);
    };
    listenForProcessExitRequests(async (reason, restart) => {
      if (!restart) return void stop(0, reason);
      // Under the logging parent, 75 makes it start the (now replaced) executable again.
      if (Deno.env.get("PETPLAY_LOG_PARENT_PID")) return void stop(RESTART_EXIT_CODE, reason);
      const { spawnDetachedRestart } = await import("./restart.ts");
      await stop(0, reason);
      if (Deno.build.standalone) spawnDetachedRestart(launchedFrom);
    });
    Deno.addSignalListener("SIGINT", () => void stop(0, "Ctrl-C"));
  });
}

async function runLogged(logPath: string): Promise<number> {
  const log = await Deno.open(logPath, { write: true, create: true, truncate: true });
  const entry = new URL("../petplay/petplay.ts", import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/,
    "$1",
  );
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--no-check", entry, ...Deno.args],
    env: { PETPLAY_PROBE_LOG: logPath },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const pump = async (
    from: ReadableStream<Uint8Array>,
    to: { write(p: Uint8Array): Promise<number> },
  ) => {
    for await (const chunk of from) {
      await log.write(chunk);
      await to.write(chunk);
    }
  };
  Deno.addSignalListener("SIGINT", () => {
    try {
      child.kill("SIGINT");
    } catch {
      // Already gone.
    }
  });
  await Promise.all([pump(child.stdout, Deno.stdout), pump(child.stderr, Deno.stderr)]);
  const status = await child.status;
  log.close();
  return status.code;
}
