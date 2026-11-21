/**
 * The household agent: offers this machine's desktop to the household's other machines, with no
 * page and no UI. Its main thread does what PetPlay's does: a PostalService with this process's
 * iroh node and the topic server, then the actors. desktopSource (capture and encoder, started
 * when someone first asks for the feed) and desktopInput join the household topic and take
 * requests only with the household proof (`classes/household.ts`).
 *
 *   deno run -A rdp/agent.ts [--host=<tailnet address>] [--media-port=4460]
 *     [--secret-file=PATH] [--topics=wss://…] [--relay=https://…] [--monitor=N]
 *
 * Windows offers every monitor, each its own feed captured and encoded on the GPU (on
 * `--media-port` + its index); `--monitor` (a `capture-wgc --list` index; default the primary) is
 * the one a request without a monitor gets.
 *
 * `--host` is where other machines' browsers reach the encoder; default this machine's tailnet
 * IPv4 (`tailscale ip -4`). Compiled for machines without a checkout by `rdp/buildAgent.ts`,
 * with the helpers next to it (PETPLAY_MEDIA_BINARY, PETPLAY_LINK_BINARY,
 * PETPLAY_SCREEN_STREAMER).
 */
import { parseArgs } from "jsr:@std/cli/parse-args";
import { PostalService, resolveActorId } from "../submodules/stageforge/mod.ts";
import { irohCarrier } from "../classes/irohCarrier.ts";
import { householdSecret, householdTopic } from "./classes/household.ts";
import { wgcMonitors } from "./classes/wgcMediaFeed.ts";

const args = parseArgs(Deno.args, {
  string: ["host", "media-port", "secret-file", "topics", "relay", "monitor"],
});

async function tailnetAddress(): Promise<string | null> {
  try {
    const { success, stdout } = await new Deno.Command("tailscale", { args: ["ip", "-4"] }).output();
    return success ? new TextDecoder().decode(stdout).trim().split("\n")[0] || null : null;
  } catch {
    return null;
  }
}

const secret = householdSecret(args["secret-file"]);
if (!secret) {
  console.error("No household secret: put one (16+ characters) in .secret or --secret-file.");
  Deno.exit(1);
}
const household = { secret, topic: await householdTopic(secret) };
const host = args.host ?? await tailnetAddress() ?? "127.0.0.1";
const port = args["media-port"] ? Number(args["media-port"]) : 4460;

const postal = new PostalService();
const iroh = irohCarrier({ relay: args.relay });
postal.registerRemoteCarrier(iroh);
postal.initSignalingClient(
  args.topics ?? Deno.env.get("PETPLAY_TOPIC_URL") ?? "wss://topic.petplay.fi",
);
const call = (target: string, type: string, payload: unknown = null) =>
  postal.PostMessage({ target, type, payload }, true);

const input = resolveActorId(await postal.add("./desktopInput.ts", import.meta.url));
const source = resolveActorId(await postal.add("./desktopSource.ts", import.meta.url));
// Windows offers each monitor as its own feed (`START {monitor}`); one without a monitor gets
// the primary, or `--monitor`. Input positions arrive already placed on the virtual desktop.
let monitor: number | undefined;
if (Deno.build.os === "windows") {
  // Feeds and input regions are physical pixels. Unaware of DPI, this process would place
  // input on a scaled virtual desktop, drifting off any monitor not at 100%.
  const user32 = Deno.dlopen("user32.dll", {
    SetProcessDpiAwarenessContext: { parameters: ["isize"], result: "i32" },
  });
  // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
  if (!user32.symbols.SetProcessDpiAwarenessContext(-4n)) {
    console.error("agent: could not become DPI aware; input may drift on scaled monitors");
  }
  const monitors = await wgcMonitors();
  const chosen = args.monitor !== undefined
    ? monitors.find((m) => m.index === Number(args.monitor))
    : monitors.find((m) => m.primary) ?? monitors[0];
  if (!chosen) {
    console.error(`No monitor ${args.monitor ?? "(primary)"}; found ${monitors.map((m) => m.index).join(", ")}`);
    Deno.exit(1);
  }
  monitor = chosen.index;
  for (const m of monitors) {
    console.log(`agent: monitor ${m.index} ${m.name} ${m.width}x${m.height}${m.primary ? " (primary)" : ""}`);
  }
}
await call(source, "CONFIGURE", { host, port, ...(monitor !== undefined ? { monitor } : {}) });
await call(source, "SETINPUT", input);
// Last: from here on only the household's proofs are accepted.
await call(input, "SETHOUSEHOLD", household);
await call(source, "SETHOUSEHOLD", household);
console.log(`agent: ${Deno.hostname()} offers its desktop (encoder on ${host}:${port})`);

let exiting = false;
async function exit(): Promise<void> {
  if (exiting) return;
  exiting = true;
  for (const id of [source, input]) {
    await Promise.race([
      call(id, "SHUTDOWN").catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
  postal.closeRemote("exiting");
  await iroh.stop();
  Deno.exit(0);
}
Deno.addSignalListener("SIGINT", () => void exit());
// Windows has SIGINT and SIGBREAK only.
if (Deno.build.os !== "windows") Deno.addSignalListener("SIGTERM", () => void exit());
else Deno.addSignalListener("SIGBREAK", () => void exit());
