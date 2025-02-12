import { PostalService } from "./stageforge/mod.ts"
import "./actors/main.ts";
/* import "./actorsOther/exampleActor.x";
import "./actorsOther/signalingDenoServer.x"; */

import { wait } from "./classes/utils.ts";

const postalservice = new PostalService();

const mainAddress = await postalservice.add("./actors/main.ts");


console.log("mainAddress", mainAddress);


await wait(1000)

postalservice.PostMessage({
  address: { fm: "system", to: mainAddress },
  type: "MAIN",
  payload: null,
});



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
    postalservice.PostMessage({
      address: { fm: "system", to: mainAddress },
      type: "STDIN",
      payload: msg,
    });
  }
}
