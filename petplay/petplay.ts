import { PostalService } from "../submodules/stageforge/mod.ts";
import { asyncPrompt, createTemp, destroyTemp, ensuredenodir, wait } from "../classes/utils.ts";
import { releaseWindowsSyntheticDisplayMouseState } from "../classes/environment/displayInstance/mouse.ts";
import { releaseWindowsSyntheticKeyboardState } from "../classes/environment/keyboard/win32SystemKeyboard.ts";

ensuredenodir();
createTemp(import.meta.dirname!);
console.log("Press Ctrl-C to close");

const EXIT_STABILIZE_MS = 3000;
const STAGEFORGE_SIGNALING_URL = "ws://petplay.ddns.net:8080";

function isStageforgeNetworkingEnabled(): boolean {
  return Deno.args.includes("--stageforge-networking") ||
    Deno.env.get("PETPLAY_STAGEFORGE_NETWORKING") === "1";
}

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
    await releaseWindowsSyntheticDisplayMouseState();
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

function isRecoverableDisplayInstanceWorkerError(ev: ErrorEvent): boolean {
  const message = String(ev.error ?? ev.message ?? "");
  const lower = message.toLowerCase();
  if (lower.includes("in worker \"./displayinstance.ts\"")) {
    return true;
  }
  if (lower.includes("displayinstance.ts")) {
    return true;
  }
  if (lower.includes("failed to initialize glfw")) {
    return true;
  }
  if (lower.includes("glfw3_v3-4-0.dll") && lower.includes("access is denied")) {
    return true;
  }
  return false;
}

PostalService.onActorWorkerError = (ev) => {
  if (isRecoverableDisplayInstanceWorkerError(ev)) {
    console.warn("petplay: recoverable worker error ignored:", ev.error ?? ev.message);
    return;
  }
  void petplayFatalExit(ev.error ?? ev.message);
};

const stageforgeNetworkingEnabled = isStageforgeNetworkingEnabled();
const postalservice = stageforgeNetworkingEnabled
  ? await createNetworkedPostalService()
  : new PostalService();

PostalService.debugMode = false;
PostalService.performanceLoggingActive = false;
if (stageforgeNetworkingEnabled) {
  console.log(`Stageforge networking enabled (${STAGEFORGE_SIGNALING_URL})`);
  postalservice.initSignalingClient(STAGEFORGE_SIGNALING_URL);
} else {
  console.log(
    "Stageforge networking disabled. Enable it with --stageforge-networking or PETPLAY_STAGEFORGE_NETWORKING=1.",
  );
}

/**
 * Iroh is only needed when Stageforge is allowed to create remote actor proxies.
 * Keeping the import and worker wrapper behind this opt-in keeps local actors on
 * Deno's native Worker implementation.
 */
async function createNetworkedPostalService(): Promise<PostalService> {
  const { IrohWebWorker, setupIrohDebugMode } = await import(
    "../submodules/irohworker/IrohWorker.ts"
  );
  setupIrohDebugMode(false);
  return new PostalService(IrohWebWorker);
}

const mainAddress = await postalservice.add("./main.ts", import.meta.url);
postalservice.setRootActor(mainAddress, "MAIN", null);

postalservice.PostMessage({
  target: mainAddress,
  type: "MAIN",
  payload: null,
});

if (import.meta.main) {
  while (true) {
    const msgD = await asyncPrompt() ?? "";
    const msg = msgD.replace(/\r/g, "");
    const currentMainAddress = postalservice.getRootActorId() ?? mainAddress;
    postalservice.PostMessage({
      target: currentMainAddress,
      type: "STDIN",
      payload: msg,
    });
    await wait(10);
  }
}
