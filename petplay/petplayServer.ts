import { IPCWorker, PostalService, setWorkerChildArgs } from "../submodules/stageforge/mod.ts";
import { childProcessArgs } from "../classes/childModule.ts";
import { asyncPrompt, createTemp, destroyTemp, ensuredenodir, wait } from "../classes/utils.ts";
import { listenForProcessExitRequests } from "../classes/processExitRequest.ts";
import { watchLogParent } from "../classes/runLog.ts";
import { releaseWindowsSyntheticDisplayMouseState } from "../classes/environment/displayInstance/mouse.ts";
import { releaseWindowsSyntheticKeyboardState } from "../classes/environment/keyboard/win32SystemKeyboard.ts";
import { householdSecret } from "../rdp/classes/household.ts";

const EXIT_STABILIZE_MS = 3000;
/** Topic server (submodules/petplayserver), deployed on ldeploy; override with PETPLAY_TOPIC_URL. */
const STAGEFORGE_SIGNALING_URL = Deno.env.get("PETPLAY_TOPIC_URL") ?? "wss://topic.petplay.fi";

/**
 * Boots the server: temp dir, supervision, actors, and the optional stdin bridge.
 *
 * `interactive` is the entry's `import.meta.main`, so only a directly started process reads stdin.
 */
export async function startPetplayServer(
  options: { interactive: boolean },
): Promise<void> {
  if (
    Deno.build.os === "linux" && Deno.build.arch === "aarch64" &&
    !Deno.env.get("DENO_GLFW_PATH")
  ) {
    // @gfx/dwm bundles x86-64 GLFW. Let the loader find native GLFW on
    // both Frame (/usr/lib) and multiarch distributions such as Ubuntu.
    Deno.env.set("DENO_GLFW_PATH", "libglfw.so.3");
  }
  ensuredenodir();
  createTemp();
  console.log("Press Ctrl-C to close");

  /**
   * On with the flag or PETPLAY_STAGEFORGE_NETWORKING=1, and by default on a machine with a
   * household secret (`.secret`): the household's other desktops are found through it
   * (`petplay/householdDesktops.ts`). PETPLAY_STAGEFORGE_NETWORKING=0 keeps it off.
   */
  function isStageforgeNetworkingEnabled(): boolean {
    const env = Deno.env.get("PETPLAY_STAGEFORGE_NETWORKING");
    if (Deno.args.includes("--stageforge-networking") || env === "1") return true;
    if (env === "0") return false;
    try {
      return householdSecret() !== null;
    } catch {
      return false;
    }
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
    // Stop the root's supervision loop first: it would otherwise start another
    // OpenVR attach/detach pass against actors that are being torn down.
    const rootActorId = postalservice.getRootActorId();
    if (rootActorId != null) {
      try {
        await Promise.race([
          postalservice.PostMessage({
            target: rootActorId,
            type: "PREPARESHUTDOWN",
            payload: null,
          }, true),
          wait(3_000),
        ]);
      } catch {
        // Best effort: teardown must not depend on a live root.
      }
    }
    // Run native teardown sequentially, but keep each worker alive after its hook.
    // SHUTDOWN_AND_CLOSE acknowledges before its scheduled globalThis.close(),
    // allowing the worker's native destructors to race the next actor's cleanup.
    // The final Deno.exit terminates these already-cleaned, idle workers together.
    const actorIds = [...PostalService.actors.keys()].reverse();
    for (const actorId of actorIds) {
      const actor = PostalService.actors.get(actorId);
      try {
        console.log(`[petplay] shutting down actor ${actorId}`);
        // Bounded: a worker whose transport is already gone (a VR-facing child
        // that died with SteamVR) never answers, and an unbounded await here
        // hangs Ctrl-C and the fatal path for the life of the process.
        await Promise.race([
          postalservice.PostMessage({
            target: actorId,
            type: "SHUTDOWN",
            payload: { reason: "process-exit" },
          }, true),
          wait(5_000),
        ]);
        console.log(`[petplay] actor shutdown complete ${actorId}`);
      } catch (error) {
        console.warn(`petplay: actor shutdown failed (${actorId}):`, error);
      }
      if (actor?.worker instanceof IPCWorker) {
        actor.worker.terminate();
        await Promise.race([
          actor.worker.finished.catch(() => undefined),
          wait(2_500),
        ]);
      }
    }
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
      return;
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
      return;
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

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(signal, () => {
        console.log(`[petplay] received ${signal}; shutting down`);
        void petplayDefaultExit();
      });
    } catch {
      // SIGTERM is not available on every supported platform.
    }
  }

  watchLogParent(() => {
    console.log("[petplay] logging parent exited; shutting down");
    void petplayDefaultExit();
  });
  listenForProcessExitRequests((reason) => {
    console.log(`[petplay] exit requested: ${reason}; shutting down`);
    void petplayDefaultExit();
  });

  const devExitAfterArg = Deno.args.find((arg) => arg.startsWith("--dev-exit-after-ms="));
  if (devExitAfterArg) {
    const delayMs = Number(devExitAfterArg.split("=", 2)[1]);
    if (!Number.isFinite(delayMs) || delayMs < 1_000) {
      throw new Error(`Invalid ${devExitAfterArg}; expected at least 1000ms`);
    }
    console.log(`[petplay profile] clean exit scheduled in ${delayMs}ms`);
    setTimeout(() => void petplayDefaultExit(), delayMs);
  }

  function isRecoverableDisplayOverlayHostWorkerError(ev: ErrorEvent): boolean {
    const message = String(ev.error ?? ev.message ?? "");
    const lower = message.toLowerCase();
    if (lower.includes('in worker "./displayoverlayhost.ts"')) {
      return true;
    }
    if (lower.includes("displayoverlayhost.ts")) {
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

  /**
   * SteamVR-facing workers in supervised mode. `main` keeps the process alive
   * across SteamVR coming and going, so a death among these is a detach/reattach
   * for the supervisor rather than a reason to take the whole session down. The
   * `--novr` path never creates them, so it keeps the fatal policy.
   */
  const OPENVR_FACING_WORKER_MARKERS = [
    "./openvr.ts",
    "./hmd.ts",
    "./vrcorigin.ts",
    "./vrcorigincamera.ts",
    "./displayoverlayhost.ts",
    // `IPCWorker` child exits (the display overlay host) surface twice: the
    // transport that carried the actor dies first, then the exit itself. Carries
    // no script name either way.
    "transport failed",
    "ipcworker child exited",
  ];

  function isRecoverableSupervisedOpenVrWorkerError(ev: ErrorEvent): boolean {
    if (Deno.args.includes("--novr")) {
      return false;
    }
    const message = String(ev.error ?? ev.message ?? "").toLowerCase();
    return OPENVR_FACING_WORKER_MARKERS.some((marker) => message.includes(marker));
  }

  PostalService.onActorWorkerError = (ev) => {
    if (isRecoverableDisplayOverlayHostWorkerError(ev)) {
      console.warn("petplay: recoverable worker error ignored:", ev.error ?? ev.message);
      return;
    }
    if (isRecoverableSupervisedOpenVrWorkerError(ev)) {
      console.warn(
        "petplay: SteamVR worker error ignored (supervisor will reattach):",
        ev.error ?? ev.message,
      );
      return;
    }
    void petplayFatalExit(ev.error ?? ev.message);
  };

  const stageforgeNetworkingEnabled = isStageforgeNetworkingEnabled();
  const postalservice = new PostalService();
  postalservice.registerWorker("process", IPCWorker);
  // `{ worker: "process" }` actors (the display overlay host, the decoupled desktop view) are
  // separate processes: a compiled build reaches them by dispatching itself, a checkout through the
  // Deno CLI. See [childModule](../classes/childModule.ts).
  setWorkerChildArgs(childProcessArgs);

  PostalService.performanceLoggingActive = false;
  if (stageforgeNetworkingEnabled) {
    // Actors in other processes reach the ones here through iroh: `petplay-media link`
    // (built with --features iroh) publishes this process's endpoint id and relay in topic
    // records. See markdown/rdp/README.md.
    console.log(`Stageforge networking enabled (${STAGEFORGE_SIGNALING_URL})`);
    const { irohCarrier } = await import("../classes/irohCarrier.ts");
    postalservice.registerRemoteCarrier(irohCarrier());
    postalservice.initSignalingClient(STAGEFORGE_SIGNALING_URL);
  } else {
    console.log(
      "Stageforge networking disabled. Enable it with --stageforge-networking or PETPLAY_STAGEFORGE_NETWORKING=1.",
    );
  }

  const mainAddress = await postalservice.add("./main.ts", import.meta.url);
  postalservice.setRootActor(mainAddress, "MAIN", null);

  postalservice.PostMessage({
    target: mainAddress,
    type: "MAIN",
    payload: null,
  });

  if (options.interactive) {
    while (true) {
      // A launch without a terminal has stdin at its end: stop reading rather than
      // post an empty line to main every 10 ms for the life of the process.
      const msgD = await asyncPrompt();
      if (msgD == null) break;
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
}
