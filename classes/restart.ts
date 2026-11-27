/**
 * Restarting PetPlay, usually to run the build an update just installed (Settings → Install →
 * RESTART). A worker asks with `requestProcessRestart` (classes/processExitRequest.ts); the server
 * shuts down as it does for Ctrl-C and then:
 *
 * - under the logging parent every release run has (classes/runLog.ts), exits with
 *   `RESTART_EXIT_CODE`, and the parent starts the new executable as its next child: same
 *   terminal, same SteamVR launch, same log file;
 * - without one (`--no-log-file`), starts the new executable itself, detached, as its last act.
 *
 * A checkout cannot restart itself this way (its executable is Deno); `canRestart()` is false.
 */
import { installedExecutablePath } from "./appPaths.ts";
import { installState } from "./install.ts";

export function canRestart(): boolean {
  return Deno.build.standalone;
}

/**
 * Which executable a restart runs: the installed copy when there is one (updates go there),
 * else the file this process was started from (an update replaced it in place).
 */
export function restartExecutable(original: string): string {
  try {
    if (installState().installed) return installedExecutablePath();
  } catch {
    // Fall through to the original path.
  }
  return original;
}

/**
 * Without a logging parent: start PetPlay again, detached, with this run's arguments.
 * @param launchedFrom `Deno.execPath()` read at startup: once an update replaced the file, Linux
 * reports the running executable as `… (deleted)`.
 */
export function spawnDetachedRestart(
  launchedFrom: string,
  args: readonly string[] = Deno.args,
): void {
  const child = new Deno.Command(restartExecutable(launchedFrom), {
    args: [...args],
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  child.unref();
}
