/**
 * Standalone remote desktop: this process's main thread does only what PetPlay's does. It
 * constructs the PostalService (with this process's iroh node and the topic server) and spawns
 * `rdp`, which composes the rest. Prints the link to open in a browser.
 *
 *   deno run -A --unstable-net rdp/main.ts [--host=<tailnet address>] [--media-port=4460] [--site-port=N]
 *     [--no-capture] [--no-input] [--no-site] [--topics=wss://…] [--relay=https://…]
 *
 * Needs `deno task rdp:build` (the page) and `petplay-media` built with `--features iroh`
 * (PETPLAY_LINK_BINARY, or the release build).
 */
import { parseArgs } from "@std/cli/parse-args";
import { fromFileUrl } from "@std/path";
import { type ActorId, PostalService } from "../submodules/stageforge/mod.ts";
import { irohCarrier } from "../classes/irohCarrier.ts";
import { tailnetAddress } from "./classes/tailnet.ts";

const args = parseArgs(Deno.args, {
  string: [
    "host",
    "media-port",
    "site-port",
    "repl-port",
    "password",
    "topics",
    "relay",
    "vrchat-socket",
    "vrchat-layout",
  ],
  boolean: ["capture", "input", "site", "compositor", "vrchat", "watch", "repl"],
  default: {
    capture: true,
    input: true,
    site: true,
    compositor: false,
    vrchat: false,
    watch: false,
  },
  negatable: ["capture", "input", "site", "repl"],
});
const topics = args.topics ?? Deno.env.get("PETPLAY_TOPIC_URL") ?? "wss://topic.petplay.fi";
const host = args.host ?? await tailnetAddress() ?? "127.0.0.1";
const sitePassword = args.password ?? Deno.env.get("PETPLAY_RDP_PASSWORD") ?? undefined;

const postal = new PostalService();
const iroh = irohCarrier({ relay: args.relay });
postal.registerRemoteCarrier(iroh);
postal.initSignalingClient(topics);
const rdp = await postal.add("./rdp.ts", import.meta.url);
const { link, url, actors } = await postal.PostMessage({
  target: rdp,
  type: "START",
  payload: {
    host,
    mediaPort: args["media-port"] ? Number(args["media-port"]) : undefined,
    site: args.site
      ? {
        port: args["site-port"] ? Number(args["site-port"]) : undefined,
        password: sitePassword,
      }
      : false,
    capture: args.capture,
    input: args.input,
    mode: args.compositor ? "compositor" : "classic",
    vrchat: args.vrchat || args["vrchat-socket"]
      ? {
        socketPath: args["vrchat-socket"],
        layout: args["vrchat-layout"] === "side-by-side" ? "side-by-side" : "mono",
      }
      : false,
  },
}, true) as { link: string; url: string | null; actors: Record<string, ActorId> };

// Options the page needs to find the same topic server and relay.
const query = new URLSearchParams();
if (args.topics) query.set("topics", args.topics);
if (args.relay) query.set("relay", args.relay);
if (url) {
  console.log(
    `\nOpen: ${url}${query.size ? `?${query}` : ""}${
      sitePassword ? " (password protected)" : ""
    }\n`,
  );
} else {
  const [base, secret] = link.split("#");
  console.log(`\nOpen: ${base}${query.size ? `?${query}` : ""}#${secret}\n`);
}

// parseArgs gives unset booleans `false`, so look at what was actually passed: --repl and
// --repl-port turn it on, --watch does unless --no-repl.
const enableRepl = Deno.args.includes("--repl") || Boolean(args["repl-port"]) ||
  (args.watch && !Deno.args.includes("--no-repl"));
if (enableRepl) {
  const replPort = args["repl-port"] ?? Deno.env.get("PETPLAY_RDP_REPL_PORT") ?? "3988";
  Deno.env.set("PETPLAY_AGENT_REPL_PORT", replPort);
  try {
    const repl = await postal.add("../petplay/agentRepl.ts", import.meta.url);
    await postal.PostMessage({
      target: repl,
      type: "REGISTER_ACTORS",
      payload: { rdp, ...actors },
    }, true);
    console.log(`[rdp] agent REPL listening on http://127.0.0.1:${replPort}`);
  } catch (error) {
    console.warn(`[rdp] agent REPL unavailable on port ${replPort}:`, error);
  }
}

if (args.watch) {
  // Actors reload in place when a file in their module graph changes; see stageforge HotReload.
  // Nothing reloads unless the project type-checks (tsrs, about a second).
  await postal.enableHotReload({ check: [Deno.execPath(), "task", "check"] });

  // The tab's code is a bundle: rebuild it when its sources change.
  const browserDir = fromFileUrl(new URL("./browser/", import.meta.url));
  const sceneStreamDir = fromFileUrl(new URL("../web/scene-stream/", import.meta.url));
  const liaison = fromFileUrl(new URL("./liaison.ts", import.meta.url));
  const buildScript = fromFileUrl(new URL("./build.ts", import.meta.url));
  let buildTimer: ReturnType<typeof setTimeout> | null = null;
  void (async () => {
    for await (const event of Deno.watchFs([browserDir, sceneStreamDir, liaison])) {
      if (event.kind !== "modify" && event.kind !== "create") continue;
      if (buildTimer) clearTimeout(buildTimer);
      buildTimer = setTimeout(async () => {
        const res = await new Deno.Command(Deno.execPath(), {
          args: ["run", "-A", buildScript],
          stdout: "inherit",
          stderr: "inherit",
        }).output();
        if (res.success) console.log("[rdp --watch] rebuilt dist/rdp (refresh browser tab)");
      }, 200);
    }
  })();
}

let exiting = false;
async function exit(): Promise<void> {
  if (exiting) return;
  exiting = true;
  await postal.shutdownAll({ reason: "process-exit", timeoutMs: 3000, bestEffort: true });
  postal.closeRemote("exiting");
  await iroh.stop();
  Deno.exit(0);
}
Deno.addSignalListener("SIGINT", () => void exit());
Deno.addSignalListener("SIGTERM", () => void exit());
