/**
 * How the Settings overlay (and any other in-process front end) runs the installer: as a
 * `petplay <command> --json` child process (classes/installerCli.ts → classes/installer.ts), so
 * the same backend does the work as on the command line, and its heavy hashing and file writes
 * stay out of the scene worker.
 *
 * The child is the executable that should do the job: this build for `--install` (it installs
 * itself); for update and rollback the installed copy, else this build's own file (an update may
 * already have replaced either). The client runs only one that speaks the installer protocol
 * (`--version --json` reports `installer`): an older build would start PetPlay on flags it does
 * not know.
 */
import { INSTALLER_PROTOCOL } from "./buildInfo.ts";
import type { InstallerProgress, InstallerResult } from "./installer.ts";
import { launchedFrom } from "./launchedFrom.ts";
import { restartExecutable } from "./restart.ts";

export type InstallerCommand =
  | { command: "install" }
  | { command: "uninstall" }
  | { command: "update"; channel: string }
  | { command: "rollback" };

function argsFor(request: InstallerCommand): string[] {
  switch (request.command) {
    case "install":
      return ["--install"];
    case "uninstall":
      return ["--uninstall"];
    case "update":
      return ["--update", `--channel=${request.channel}`];
    case "rollback":
      return ["--update-rollback"];
  }
}

async function speaksInstaller(executable: string): Promise<boolean> {
  try {
    const output = await new Deno.Command(executable, {
      args: ["--version", "--json"],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(60_000),
    }).output();
    const info = JSON.parse(new TextDecoder().decode(output.stdout)) as { installer?: number };
    return output.success && (info.installer ?? 0) >= INSTALLER_PROTOCOL;
  } catch {
    return false;
  }
}

/**
 * Runs one installer command in its own process and resolves with its result (`null`: nothing
 * to do, e.g. already up to date). Rejects with the installer's own error message.
 */
export async function runInstaller(
  request: InstallerCommand,
  onProgress: (progress: InstallerProgress) => void,
): Promise<InstallerResult | null> {
  if (!Deno.build.standalone) {
    throw new Error(
      "A source checkout updates with git pull (deno task steamvr:register to register)",
    );
  }
  // `--install` installs the executable that runs it, so it must be this build. Update and
  // rollback act on the installed copy whichever PetPlay runs them: prefer the installed one,
  // then this build's own file.
  const candidates = request.command === "install"
    ? [launchedFrom]
    : [...new Set([restartExecutable(launchedFrom), launchedFrom])];
  let executable: string | null = null;
  for (const candidate of candidates) {
    if (await speaksInstaller(candidate)) {
      executable = candidate;
      break;
    }
  }
  if (executable == null) {
    throw new Error(
      `${candidates.join(" and ")} ${
        candidates.length > 1 ? "are builds" : "is a build"
      } from before this installer; update once from the command line with a newer download`,
    );
  }
  const child = new Deno.Command(executable, {
    args: [...argsFor(request), "--json"],
    stdin: "null",
    stdout: "piped",
    stderr: "inherit",
    env: { PETPLAY_LOG_PARENT_PID: "" },
  }).spawn();
  let result: InstallerResult | null = null;
  let failure: string | null = null;
  let pending = "";
  const decoder = new TextDecoder();
  for await (const bytes of child.stdout) {
    pending += decoder.decode(bytes, { stream: true });
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (!line.startsWith("{")) continue;
      try {
        const event = JSON.parse(line) as {
          event?: string;
          result?: InstallerResult | null;
          message?: string;
        };
        if (event.event === "progress") onProgress(event as unknown as InstallerProgress);
        else if (event.event === "done") result = event.result ?? null;
        else if (event.event === "error") failure = String(event.message);
      } catch {
        // Not one of ours.
      }
    }
  }
  const status = await child.status;
  if (failure != null || !status.success) {
    throw new Error(failure ?? `installer exited with code ${status.code}`);
  }
  return result;
}
