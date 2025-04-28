import { PostalService } from "../submodules/stageforge/mod.ts"
import { IrohWebWorker, setupIrohDebugMode } from "../submodules/irohworker/IrohWorker.ts"
import { createTemp, destroyTemp } from "../classes/utils.ts";
import { dirname, join, extname } from "jsr:@std/path";
createTemp(import.meta.dirname!)

console.log("Press Ctrl-C to close");

Deno.addSignalListener("SIGINT", () => {
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

//stdin is broken cuz of tmpfile
/* const stream = Deno.stdin.readable.values();
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
} */
