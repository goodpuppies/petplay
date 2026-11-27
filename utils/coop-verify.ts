/**
 * `deno task coop:verify`: checks a coop pairing end to end from one machine, with no CI: this
 * PetPlay and each trusted peer in the VRChat instance answer a probe (classes/peerProbe.ts) over
 * the trusted link, and the two snapshots are compared: same build, link path (direct or relay)
 * and RTT on both sides, shared display poses as each side sees them, recent log errors.
 *
 *   deno task coop:verify                 # every trusted peer in the instance
 *   deno task coop:verify --peer blise    # peers whose display name matches
 *   deno task coop:verify --json          # the raw probes and checks, for an agent
 *   deno task coop:verify --watch 10      # repeat every 10 s (a soak while both people play)
 *
 * Talks to this machine's running PetPlay through its agent REPL (`--repl-port`, default 3987).
 * The peer answers only with Settings → Install → Peer Code Patches on. Exit code 1 when any
 * check fails, so an agent can gate on it.
 */
import {
  type Check,
  comparePeers,
  type PeerProbe,
  type PeerProbeReply,
} from "../classes/peerProbe.ts";

type Options = { peer?: string; json: boolean; port: number; watch: number | null };

function parseArgs(args: string[]): Options {
  const options: Options = { json: false, port: 3987, watch: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = () => {
      const next = args[++i];
      if (next == null) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--json") options.json = true;
    else if (arg === "--peer") options.peer = value();
    else if (arg === "--repl-port") options.port = Number(value());
    else if (arg === "--watch") options.watch = Number(value());
    else throw new Error(`unknown option ${arg}`);
  }
  return options;
}

type ProbeResult = {
  local: PeerProbe;
  peers: Array<{ peer: string; actorId: string; reply: PeerProbeReply }>;
};

async function probe(options: Options): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${options.port}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: "vrcPeers",
        type: "SENDPEERPROBE",
        payload: options.peer ? { peer: options.peer } : null,
        reply: true,
        timeoutMs: 45_000,
      }),
      signal: AbortSignal.timeout(50_000),
    });
  } catch (error) {
    throw new Error(
      `no PetPlay agent REPL on port ${options.port} (${
        error instanceof Error ? error.message : error
      })`,
    );
  }
  const body = await response.json() as { ok: boolean; error?: string; result?: ProbeResult };
  if (!body.ok || !body.result) {
    throw new Error(
      `vrcPeers did not answer SENDPEERPROBE (${
        body.error ?? response.status
      }); is this PetPlay new enough?`,
    );
  }
  return body.result;
}

function verify(result: ProbeResult): Array<{ peer: string; checks: Check[] }> {
  const local = result.local;
  const preflight: Check[] = [
    {
      name: "networking",
      status: local.links ? "pass" : "fail",
      detail: local.links
        ? `${local.links.length} iroh link connection(s)`
        : "Peer Networking is off here",
    },
    {
      name: "trusted peers in instance",
      status: result.peers.length > 0 ? "pass" : "fail",
      detail: result.peers.length > 0
        ? result.peers.map((p) => p.peer).join(", ")
        : `none (here: ${local.peers.length} peer record(s), ${
          local.peers.filter((p) => p.trust === "trusted").length
        } trusted)`,
    },
  ];
  const out = [{ peer: "this machine", checks: preflight }];
  for (const { peer, reply } of result.peers) {
    out.push({
      peer,
      checks: reply.ok
        ? comparePeers(local, reply.probe)
        : [{ name: "probe", status: "fail", detail: reply.error }],
    });
  }
  return out;
}

const MARK = { pass: "ok  ", warn: "WARN", fail: "FAIL" } as const;

function print(report: Array<{ peer: string; checks: Check[] }>): void {
  for (const { peer, checks } of report) {
    console.log(`\n${peer}`);
    for (const check of checks) {
      console.log(`  ${MARK[check.status]} ${check.name}: ${check.detail}`);
    }
  }
}

async function once(options: Options): Promise<boolean> {
  const result = await probe(options);
  const report = verify(result);
  if (options.json) {
    console.log(JSON.stringify({ at: new Date().toISOString(), ...result, report }));
  } else print(report);
  return report.every((r) => r.checks.every((c) => c.status !== "fail"));
}

if (import.meta.main) {
  const options = parseArgs(Deno.args);
  try {
    if (options.watch == null) Deno.exit(await once(options) ? 0 : 1);
    for (;;) {
      if (!options.json) console.log(`\n--- ${new Date().toLocaleTimeString()}`);
      await once(options).catch((error) => console.error(`${error}`));
      await new Promise((r) => setTimeout(r, Math.max(2, options.watch!) * 1000));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(2);
  }
}
