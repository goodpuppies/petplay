/** A process with one actor that joins topic "t", reachable over a local iroh carrier. */
import { PostalService } from "../../submodules/stageforge/mod.ts";
import { irohCarrier } from "../../classes/irohCarrier.ts";

const postal = new PostalService();
postal.registerRemoteCarrier(irohCarrier({ local: true }));
postal.initSignalingClient(Deno.args[0]);
const actor = await postal.add(
  "../../submodules/stageforge/test/actors/topicPeer.ts",
  import.meta.url,
);
await postal.PostMessage({ target: actor, type: "JOIN", payload: "t" }, true);
console.log(`CHILD_ACTOR ${actor}`);
setInterval(() => {}, 1 << 30);
