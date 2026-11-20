/** A "server" process: native iroh through the relay in args[1], topic relay in args[0]. */
import { PostalService } from "../../submodules/stageforge/mod.ts";
import { irohCarrier } from "../../classes/irohCarrier.ts";

const postal = new PostalService();
postal.registerRemoteCarrier(irohCarrier({ relay: Deno.args[1] }));
postal.initSignalingClient(Deno.args[0]);
const actor = await postal.add(
  "../../submodules/stageforge/test/actors/topicPeer.ts",
  import.meta.url,
);
await postal.PostMessage({ target: actor, type: "JOIN", payload: "t" }, true);
console.log(`SERVER_JOINED ${actor}`);
setInterval(() => {}, 1 << 30);
