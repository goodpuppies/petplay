import { PostalService } from "./stageforge/mod.ts"
import "./actors/main.ts";
//import { IrohWebWorker, setupIrohDebugMode } from "https://raw.githubusercontent.com/mommysgoodpuppy/IrohWorker/refs/heads/main/IrohWorker.ts"
import { IrohWebWorker, setupIrohDebugMode } from "../IrohWorker/IrohWorker.ts"

import { wait } from "./classes/utils.ts";
// Enable debug mode for Iroh WebWorker
setupIrohDebugMode(false);
const postalservice = new PostalService(IrohWebWorker);
// Enable debug mode for PostalService
PostalService.debugMode = true;
postalservice.initSignalingClient("ws://petplay.ddns.net:8080");

const mainAddress = await postalservice.add("./dogdemo/main.ts");
//const mainAddress = await postalservice.add("./netTest/actor1.ts");

await wait(2000)



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
