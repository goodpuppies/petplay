/**
 * A worker asking the server process for its normal shutdown. Actors run in
 * workers and cannot run the host's teardown or call `Deno.exit` for it, and
 * stageforge swallows their uncaught errors. A `BroadcastChannel` reaches the
 * server's main thread from any worker in the process, on every platform.
 */
const CHANNEL = "petplay-process-exit";
const RESTART_PREFIX = "restart:";

/**
 * The exit code that asks the logging parent (classes/runLog.ts) to start PetPlay again, from the
 * executable an update just replaced. 75 is `EX_TEMPFAIL`: "try again".
 */
export const RESTART_EXIT_CODE = 75;

export function requestProcessExit(reason: string): void {
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage(reason);
  channel.close();
}

/** Like {@link requestProcessExit}, then start PetPlay again (after an update). */
export function requestProcessRestart(reason: string): void {
  requestProcessExit(`${RESTART_PREFIX}${reason}`);
}

/** Server side: `onRequest` runs with the reason for each request, and whether to restart. */
export function listenForProcessExitRequests(
  onRequest: (reason: string, restart: boolean) => void,
): void {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event) => {
    const data = String(event.data);
    const restart = data.startsWith(RESTART_PREFIX);
    onRequest(restart ? data.slice(RESTART_PREFIX.length) : data, restart);
  };
}
