import { PostalService } from "./actorsystem/PostalService.ts";
import "./actors3/main.ts";
import "./actorsOther/exampleActor.ts";
import "./actorsOther/signalingDenoServer.ts";
import type { Message } from "./actorsystem/types.ts";
import { wait } from "./actorsystem/utils.ts";

const postalservice = new PostalService();

const mainAddress = await postalservice.add("mainE.ts");
const portal = await postalservice.add("IrohActor.ts")

postalservice.portal = portal

console.log("mainAddress", mainAddress);

postalservice.Post({
  address: { fm: "system", to: portal },
  type: "INITNETWORK",
  payload: null,
});

await wait(1000)

postalservice.Post({
  address: { fm: "system", to: mainAddress },
  type: "MAIN",
  payload: null,
} satisfies Message );



const stream = Deno.stdin.readable.values();
async function asyncPrompt(): Promise<string> {
  const next = await stream.next();
  if ("done" in next && next.done) {
    return "";
  } else {
    return new TextDecoder().decode(next.value).slice(0, -1);
  }
}

if (import.meta.main) {
  while (true) {
    const msgD = await asyncPrompt() ?? "";
    const msg = msgD.replace(/\r/g, "");
    postalservice.Post({
      address: { fm: "system", to: mainAddress },
      type: "STDIN",
      payload: msg,
    });
  }
}
