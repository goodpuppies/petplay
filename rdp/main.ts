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
import { parseArgs } from "jsr:@std/cli/parse-args";
import { PostalService } from "../submodules/stageforge/mod.ts";
import { irohCarrier } from "../classes/irohCarrier.ts";
import { tailnetAddress } from "./classes/tailnet.ts";

const args = parseArgs(Deno.args, {
  string: ["host", "media-port", "site-port", "topics", "relay"],
  boolean: ["capture", "input", "site"],
  default: { capture: true, input: true, site: true },
  negatable: ["capture", "input", "site"],
});
const topics = args.topics ?? Deno.env.get("PETPLAY_TOPIC_URL") ?? "wss://topic.petplay.fi";
const host = args.host ?? await tailnetAddress() ?? "127.0.0.1";

const postal = new PostalService();
const iroh = irohCarrier({ relay: args.relay });
postal.registerRemoteCarrier(iroh);
postal.initSignalingClient(topics);
const rdp = await postal.add("./rdp.ts", import.meta.url);
const { link } = await postal.PostMessage({
  target: rdp,
  type: "START",
  payload: {
    host,
    mediaPort: args["media-port"] ? Number(args["media-port"]) : undefined,
    site: args.site ? { port: args["site-port"] ? Number(args["site-port"]) : undefined } : false,
    capture: args.capture,
    input: args.input,
  },
}, true) as { link: string };

// Options the page needs to find the same topic server and relay.
const query = new URLSearchParams();
if (args.topics) query.set("topics", args.topics);
if (args.relay) query.set("relay", args.relay);
const [base, secret] = link.split("#");
console.log(`\nOpen: ${base}${query.size ? `?${query}` : ""}#${secret}\n`);

let exiting = false;
async function exit(): Promise<void> {
  if (exiting) return;
  exiting = true;
  for (const id of [...PostalService.actors.keys()].reverse()) {
    await Promise.race([
      postal.PostMessage({ target: id, type: "SHUTDOWN", payload: null }, true).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
  postal.closeRemote("exiting");
  await iroh.stop();
  Deno.exit(0);
}
Deno.addSignalListener("SIGINT", () => void exit());
Deno.addSignalListener("SIGTERM", () => void exit());
