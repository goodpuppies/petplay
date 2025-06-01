import { PostalService } from "../submodules/stageforge/mod.ts"
import { IrohWebWorker, setupIrohDebugMode } from "../submodules/irohworker/IrohWorker.ts"
import { asyncPrompt, createTemp, destroyTemp, wait, ensuredenodir } from "../classes/utils.ts";

ensuredenodir()
createTemp(import.meta.dirname!)
console.log("Press Ctrl-C to close");
Deno.addSignalListener("SIGINT", async () => {
  await wait(3000)
  destroyTemp()
  console.log("exit! WOOF~");
  Deno.exit();
});

setupIrohDebugMode(false);
const postalservice = new PostalService(IrohWebWorker);

PostalService.debugMode = false;
PostalService.performanceLoggingActive = false;
postalservice.initSignalingClient("ws://petplay.ddns.net:8080");

const mainAddress = await postalservice.add("./main.ts", import.meta.url);

postalservice.PostMessage({
  target:  mainAddress,
  type: "MAIN",
  payload: null,
});

if (import.meta.main) {
  while (true) {
    const msgD = await asyncPrompt() ?? "";
    const msg = msgD.replace(/\r/g, "");
    postalservice.PostMessage({
      target: mainAddress,
      type: "STDIN",
      payload: msg,
    });
    await wait(10)
  }
}
