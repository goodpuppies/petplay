/** A hub that joins topic "t" with one actor, reachable over a local iroh link carrier. */
import { PostalService } from "../../submodules/stageforge/mod.ts";
import { irohLinkCarrier } from "../../classes/irohLinkCarrier.ts";

const postal = new PostalService();
postal.registerLinkCarrier(irohLinkCarrier({ local: true }));
postal.initSignalingClient(Deno.args[0]);
const actor = await postal.add(
  "../../submodules/stageforge/test/actors/topicPeer.ts",
  import.meta.url,
);
await postal.PostMessage({ target: actor, type: "JOIN", payload: "t" }, true);
console.log(`CHILD_ACTOR ${actor}`);
setInterval(() => {}, 1 << 30);
