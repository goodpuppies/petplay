import { PostalService } from "../submodules/stageforge/mod.ts"
import { IrohWebWorker, setupIrohDebugMode } from "../submodules/irohworker/IrohWorker.ts"
import { asyncPrompt, createTemp, destroyTemp, wait } from "../classes/utils.ts";

createTemp(import.meta.dirname!)
console.log("Press Ctrl-C to close");
Deno.addSignalListener("SIGINT", async () => {
  await wait(3000)
  destroyTemp()
  console.log("exit!");
  Deno.exit();
});

setupIrohDebugMode(false);
const postalservice = new PostalService(IrohWebWorker);

PostalService.debugMode = false;
postalservice.initSignalingClient("ws://petplay.ddns.net:8080");

const mainAddress = await postalservice.add("./main.ts", import.meta.url);

postalservice.PostMessage({
  address: { fm: "system", to: mainAddress },
  type: "MAIN",
  payload: null,
});

if (import.meta.main) {
  while (true) {
    const msgD = await asyncPrompt() ?? "";
    const msg = msgD.replace(/\r/g, "");
    postalservice.PostMessage({
      address: { fm: "system", to: mainAddress },
      type: "STDIN",
      payload: msg,
    });
    await wait(1)
  }
}
