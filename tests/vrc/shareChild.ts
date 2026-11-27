/**
 * Second-process sharer (Alice) for `tests/vrc/vrcShareE2e.test.ts`.
 * Runs real `vrcPeers`, `displayShare`, `mockDesktopSource`, and `mockDesktopInput` over
 * loopback iroh with NO household `.secret` file.
 *
 * Reads JSON commands on stdin (one per line) so the test driver can trigger `TRUST`, `UNTRUST`,
 * `SETSHARED`, and inspect `INPUTEVENTS` live.
 */
import { PostalService, resolveActorId } from "../../submodules/stageforge/mod.ts";
import { irohCarrier } from "../../classes/irohCarrier.ts";
import { petplayRemotePolicy } from "../../classes/remotePolicy.ts";

const [relayUrl, logDir, identityPath, trustPath] = Deno.args;
const postal = new PostalService();
if (Deno.env.get("PETPLAY_ENABLE_REMOTE_POLICY") === "1") {
  postal.setRemotePolicy(petplayRemotePolicy());
}
const iroh = irohCarrier({ local: true });
postal.registerRemoteCarrier(iroh);
postal.initSignalingClient(relayUrl);

const source = resolveActorId(await postal.add("./mockDesktopSource.ts", import.meta.url));
const input = resolveActorId(await postal.add("./mockDesktopInput.ts", import.meta.url));
const share = resolveActorId(await postal.add("../../petplay/displayShare.ts", import.meta.url));
const vrcPeers = resolveActorId(await postal.add("../../petplay/vrcPeers.ts", import.meta.url));

const call = (target: string, type: string, payload: unknown = null) =>
  postal.PostMessage({ target, type, payload }, true);

await call(share, "SETUP", { source, input });
await call(share, "SETSHARED", {
  screens: [
    { name: "DISPLAY1", input: false },
    { name: "DISPLAY2", input: true },
  ],
});
await call(vrcPeers, "ASSIGNSHARING", { displayShare: share });
await call(vrcPeers, "CONFIGURE", { logDir, identityPath, trustPath, pollIntervalMs: 50 });

const writeLine = (obj: unknown) =>
  Deno.stdout.writeSync(new TextEncoder().encode("@@JSON " + JSON.stringify(obj) + "\n"));

writeLine({ ready: true, share, vrcPeers });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function shutdown(): Promise<void> {
  await postal.shutdown(vrcPeers, { timeoutMs: 2000, bestEffort: true });
  await sleep(150);
  postal.closeRemote("child done");
  await Promise.race([iroh.stop().catch(() => {}), sleep(2000)]);
  Deno.exit(0);
}
Deno.addSignalListener("SIGTERM", () => void shutdown());

const reader = Deno.stdin.readable.pipeThrough(new TextDecoderStream()).getReader();
let buf = "";
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += value;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const cmd = JSON.parse(line) as { id: number; op: string; payload?: unknown };
    try {
      let result: unknown;
      if (cmd.op === "TRUST") result = await call(vrcPeers, "TRUST", cmd.payload);
      else if (cmd.op === "UNTRUST") result = await call(vrcPeers, "UNTRUST", cmd.payload);
      else if (cmd.op === "SETSHARED") result = await call(share, "SETSHARED", cmd.payload);
      else if (cmd.op === "INPUTEVENTS") result = await call(input, "EVENTS");
      else if (cmd.op === "PEERS") result = await call(vrcPeers, "LISTPEERS");
      else throw new Error(`unknown op ${cmd.op}`);
      writeLine({ id: cmd.id, ok: true, result });
    } catch (error) {
      writeLine({
        id: cmd.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
await shutdown();
