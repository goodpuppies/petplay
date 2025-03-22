import { PostalService } from "../submodules/stageforge/mod.ts"
import { IrohWebWorker, setupIrohDebugMode } from "../submodules/irohworker/IrohWorker.ts"
import { wait } from "../classes/utils.ts";

// Enable debug mode for Iroh WebWorker
setupIrohDebugMode(false);

// Initialize the postal service with IrohWebWorker
const postalservice = new PostalService(IrohWebWorker);
// Enable debug mode for PostalService
PostalService.debugMode = true;
postalservice.initSignalingClient("ws://petplay.ddns.net:8080");

// Start the main actor
const mainAddress = await postalservice.add("./main.ts");


await wait(2000)

console.log("mainAddress", mainAddress);


await wait(1000)

postalservice.PostMessage({
  address: { fm: "system", to: mainAddress },
  type: "MAIN",
  payload: null,
});
