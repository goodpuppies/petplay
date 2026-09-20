import { dispatchChildModule } from "../classes/childModule.ts";
import { startPetplayServer } from "./petplayServer.ts";

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
  await startPetplayServer({ interactive: import.meta.main });
}
