import { PostalService } from "../submodules/stageforge/mod.ts"
import { IrohWebWorker, setupIrohDebugMode } from "../submodules/irohworker/IrohWorker.ts"
import { asyncPrompt, createTemp, destroyTemp, wait, ensuredenodir } from "../classes/utils.ts";
import { releaseWindowsSyntheticKeyboardState } from "../classes/environment/keyboard/win32SystemKeyboard.ts";

ensuredenodir()
createTemp(import.meta.dirname!);
console.log("Press Ctrl-C to close");

const EXIT_STABILIZE_MS = 3000;

let petplayExiting = false;

function tryBeginExit(): boolean {
  if (petplayExiting) {
    return false;
  }
  petplayExiting = true;
  return true;
}

/**
 * Shared teardown: keyboard reset, stabilization delay, temp cleanup.
 * Used by both clean and fatal exit; does not log or `Deno.exit`.
 */
async function petplaySharedShutdown(): Promise<void> {
  if (Deno.build.os === "windows") {
    await releaseWindowsSyntheticKeyboardState();
  }
  await wait(EXIT_STABILIZE_MS);
  destroyTemp();
}

/** Normal shutdown (e.g. Ctrl+C): shared teardown, WOOF, `Deno.exit(0)`. */
async function petplayDefaultExit(): Promise<void> {
  if (!tryBeginExit()) {
    Deno.exit(0);
  }
  try {
    await petplaySharedShutdown();
    console.log("exit! WOOF~");
  } catch (e) {
    console.error("petplay: default exit error:", e);
  }
  Deno.exit(0);
}

/**
 * Worker or unrecoverable host error: log, then shared teardown; extend here later
 * (subprocess teardown, extra diagnostics, crash reports, etc.).
 */
async function petplayFatalExit(reason: unknown): Promise<void> {
  if (!tryBeginExit()) {
    Deno.exit(1);
  }
  try {
    console.error("petplay: fatal exit:", reason);
    // Future: subprocess / child actor teardown, extended logging, …
    await petplaySharedShutdown();
  } catch (e) {
    console.error("petplay: fatal exit cleanup error:", e);
  }
  Deno.exit(1);
}

Deno.addSignalListener("SIGINT", () => {
  void petplayDefaultExit();
});

PostalService.onActorWorkerError = (ev) => {
  void petplayFatalExit(ev.error ?? ev.message);
};

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
