/**
 * Second-process peer helper for `tests/vrc/vrcPeers.test.ts`.
 * Runs a PostalService with loopback iroh + the test topic relay and one `vrcPeers` actor.
 */
import { PostalService } from "../../submodules/stageforge/mod.ts";
import { irohCarrier } from "../../classes/irohCarrier.ts";

const [relayUrl, logDir, identityPath, trustPath] = Deno.args;
const postal = new PostalService();
const iroh = irohCarrier({ local: true });
postal.registerRemoteCarrier(iroh);
postal.initSignalingClient(relayUrl);

const peer = await postal.add("../../petplay/vrcPeers.ts", import.meta.url);
await postal.PostMessage({
  target: peer,
  type: "CONFIGURE",
  payload: { logDir, identityPath, trustPath, pollIntervalMs: 50 },
}, true);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.addSignalListener("SIGTERM", async () => {
  await postal.shutdown(peer, { timeoutMs: 2000, bestEffort: true });
  // Let the hub process TOPICUPDATE and flush the leave record over the topic WebSocket.
  await sleep(150);
  postal.closeRemote("child done");
  await Promise.race([iroh.stop().catch(() => {}), sleep(2000)]);
  Deno.exit(0);
});

await new Promise(() => {});
