import { initializeLinuxScheduling } from "../classes/linuxScheduling.ts";
import { acquireWindowsHighResTimer } from "../classes/windowsTimer.ts";
import { dispatchChildModule } from "../classes/childModule.ts";
import { startPetplayServer } from "./petplayServer.ts";
import { installNativeCrashTrace } from "../classes/nativeCrashTrace.ts";
import { runLogParent, shouldRunLogParent } from "../classes/runLog.ts";
import { runCliCommand } from "../classes/cli.ts";
import { migrateLegacyWindowsConfig } from "../classes/appPaths.ts";
import { reopenInOwnConsoleWindow } from "../classes/windowsOwnConsole.ts";

installNativeCrashTrace();
initializeLinuxScheduling();
acquireWindowsHighResTimer();
// IPC render workers inherit environment, rather than the server's command-line arguments.
const textRenderer = Deno.args.find((arg) => arg.startsWith("--text-renderer="))?.split("=")[1];
if (textRenderer != null) Deno.env.set("PETPLAY_TEXT_RENDERER", textRenderer);

/**
 * PetPlay's process entry: either this process *is* a dispatched child module, or it is the server.
 *
 * A compiled build cannot run another module through a Deno CLI, so children re-exec this binary
 * with `--petplay-run-module=`; see [childModule](../classes/childModule.ts). The dispatched module
 * owns the process from there — it keeps its own event loop alive and must not see the server
 * bootstrap — and a module cannot skip the rest of its own top level, so the two paths live in
 * separate modules rather than behind an early exit.
 */
if (await dispatchChildModule(Deno.args) == null) {
  // `--reset`, `--logs`, `--version`… do their job and exit without starting PetPlay.
  const cliExit = await runCliCommand(Deno.args);
  if (cliExit != null) Deno.exit(cliExit);
  migrateLegacyWindowsConfig();
  // Double-clicked on Windows 11, the console went to Windows Terminal, whose taskbar button is
  // the terminal's; PetPlay reopens in its own console window, which shows PetPlay's icon.
  if (reopenInOwnConsoleWindow(Deno.args)) Deno.exit(0);
  // A release run while a different build is installed asks whether to update it, and stops.
  if (Deno.build.standalone) {
    const { offerUpdate } = await import("../classes/install.ts");
    const updateExit = await offerUpdate(Deno.args);
    if (updateExit != null) Deno.exit(updateExit);
  }
  // The compiled release logs each run to a file through a thin parent; see runLog.
  if (shouldRunLogParent(Deno.args)) Deno.exit(await runLogParent());
  await startPetplayServer({ interactive: import.meta.main });
}
