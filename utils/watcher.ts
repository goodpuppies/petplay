import { debounce } from "jsr:@std/async"

interface WatcherArgs {
  watchPaths: string[];
  extensions: string[];
  execCommand: string;
  signal: Deno.Signal;
  killTimeout: number;
  verbose: boolean;
  waitDelay: number; // New property
}

let currentProcess: Deno.ChildProcess | null = null;
const DEFAULT_KILL_TIMEOUT = 15000; // 5 seconds
const DEFAULT_WAIT_DELAY = 100; // 1 second

function log(verbose: boolean, ...args: unknown[]) {
  if (verbose) {
    console.log("[Watcher]", ...args);
  }
}

async function runCommand(config: WatcherArgs) {
  if (currentProcess) {
    log(config.verbose, `Terminating previous process (PID: ${currentProcess.pid}) with ${config.signal}...`);
    try {
      currentProcess.kill()

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Graceful shutdown timeout (${config.killTimeout}ms)`)), config.killTimeout)
      );
      await Promise.race([currentProcess.status, timeoutPromise]);
      log(config.verbose, "Previous process terminated gracefully or status resolved.");
    } catch (e) {
      log(config.verbose, `Failed to gracefully terminate or timeout: ${(e as Error).message}. Attempting SIGKILL.`);
      try {
        currentProcess.kill(); // Force kill
      } catch (killError) {
        console.error(`[Watcher] Failed to SIGKILL process PID ${currentProcess.pid}:`, (killError as Error).message);
      }
    }
    currentProcess = null;
  }

  // Basic command parsing (handles simple quoted arguments)
  const parts = config.execCommand.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  if (parts.length === 0) {
    console.error("[Watcher] Cannot execute empty command.");
    return;
  }
  const cmd = parts[0]!.replace(/^["']|["']$/g, "");
  const args = parts.slice(1).map(arg => arg.replace(/^["']|["']$/g, ""));

  console.log(`[Watcher] Executing: ${cmd} ${args.join(" ")}`);
  try {
    currentProcess = new Deno.Command(cmd, {
      args,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit", // Allow child process to read from stdin
    }).spawn();
    log(config.verbose, `Process started (PID: ${currentProcess.pid}).`);

    // Asynchronously wait for the process to exit to log its status
    (async () => {
      if (!currentProcess) return;
      const processToWatch = currentProcess;
      try {
        const status = await processToWatch.status;
        log(config.verbose, `Process PID ${processToWatch.pid} exited with code: ${status.code}, signal: ${status.signal}`);
        if (currentProcess === processToWatch) {
          currentProcess = null;
        }
      } catch (err) {
        console.error(`[Watcher] Error waiting for process PID ${processToWatch.pid} status:`, (err as Error).message);
        if (currentProcess === processToWatch) {
          currentProcess = null;
        }
      }
    })();

  } catch (error) {
    console.error(`[Watcher] Failed to start command "${config.execCommand}":`, (error as Error).message);
    currentProcess = null;
  }
}

function parseWatcherArgs(args: string[]): WatcherArgs {
  const parsed: WatcherArgs = {
    watchPaths: [],
    extensions: [],
    execCommand: "",
    signal: "SIGINT",
    killTimeout: DEFAULT_KILL_TIMEOUT,
    verbose: false,
    waitDelay: DEFAULT_WAIT_DELAY, // Initialize with default
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--watch":
        if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
          parsed.watchPaths.push(args[++i]);
        } else {
          throw new Error("--watch requires a path argument");
        }
        break;
      case "--ext":
        if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
          parsed.extensions = args[++i].split(',').map(ext => ext.trim().startsWith('.') ? ext.trim() : `.${ext.trim()}`);
        } else {
          throw new Error("--ext requires a comma-separated list of extensions");
        }
        break;
      case "--exec":
        if (i + 1 < args.length) {
          parsed.execCommand = args.slice(++i).join(" ");
          i = args.length; // Consumed the rest of the arguments
        } else {
          throw new Error("--exec requires a command string");
        }
        break;
      case "--signal":
        if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
          parsed.signal = args[++i] as Deno.Signal; // Basic type assertion
        } else {
          throw new Error("--signal requires a signal name (e.g., SIGINT, SIGTERM)");
        }
        break;
      case "--kill-timeout":
        if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
          parsed.killTimeout = parseInt(args[++i], 10);
          if (isNaN(parsed.killTimeout) || parsed.killTimeout <= 0) {
            throw new Error("--kill-timeout requires a positive number (milliseconds)");
          }
        } else {
          throw new Error("--kill-timeout requires a milliseconds value");
        }
        break;
      case "-w":
      case "--wait":
        if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
          parsed.waitDelay = parseInt(args[++i], 10);
          if (isNaN(parsed.waitDelay) || parsed.waitDelay < 0) { // Allow 0 for immediate
            throw new Error("--wait requires a non-negative number (milliseconds)");
          }
        } else {
          throw new Error("--wait requires a milliseconds value");
        }
        break;
      case "-V":
      case "--verbose":
        parsed.verbose = true;
        break;
      default:
        if (arg.startsWith("--exec=") || arg.startsWith("--watch=") || arg.startsWith("--ext=") || arg.startsWith("--signal=") || arg.startsWith("--kill-timeout=") || arg.startsWith("--wait=")) {
          const [key, ...valueParts] = arg.split("=");
          const value = valueParts.join("=");
          if (key === "--exec") { parsed.execCommand = value; i = args.length; } // Consumed
          else if (key === "--watch") parsed.watchPaths.push(value);
          else if (key === "--ext") parsed.extensions = value.split(',').map(ext => ext.trim().startsWith('.') ? ext.trim() : `.${ext.trim()}`);
          else if (key === "--signal") parsed.signal = value as Deno.Signal;
          else if (key === "--kill-timeout") {
            parsed.killTimeout = parseInt(value, 10);
            if (isNaN(parsed.killTimeout) || parsed.killTimeout <= 0) throw new Error("--kill-timeout requires a positive number");
          } else if (key === "--wait") {
            parsed.waitDelay = parseInt(value, 10);
            if (isNaN(parsed.waitDelay) || parsed.waitDelay < 0) throw new Error("--wait requires a non-negative number");
          }
        } else {
          console.warn(`[Watcher] Unknown argument: ${arg}`);
        }
    }
    i++;
  }

  if (!parsed.execCommand) {
    throw new Error("--exec <command> is required.");
  }
  if (parsed.watchPaths.length === 0) {
    parsed.watchPaths.push(".");
    log(parsed.verbose, "No --watch path specified, defaulting to '.'");
  }
  if (parsed.extensions.length === 0) {
    parsed.extensions.push(".ts", ".js", ".json");
    log(parsed.verbose, "No --ext specified, defaulting to .ts, .js, .json");
  }
  return parsed;
}

async function main() {
  if (Deno.args.includes("-h") || Deno.args.includes("--help")) {
    console.log(`
Custom Deno File Watcher & Runner
---------------------------------
Usage:
  deno run -A scripts/custom-watch.ts [options] --exec "<command_string>"

Options:
  --watch <path>         Path to watch (can be used multiple times). Defaults to ".".
  --ext <ext1,ext2>      Comma-separated file extensions to watch. Defaults to "ts,js,json".
  --exec "<command>"     (Required) The command string to execute.
  --signal <NAME>        Signal to send to the process for termination. Defaults to "SIGINT".
                         Examples: SIGINT, SIGTERM.
  --kill-timeout <ms>    Milliseconds to wait for graceful shutdown before sending SIGKILL.
                         Defaults to ${DEFAULT_KILL_TIMEOUT}ms.
  -w, --wait <ms>        Milliseconds to wait after a file change before re-running the command.
                         Defaults to ${DEFAULT_WAIT_DELAY}ms.
  -V, --verbose          Enable verbose logging from the watcher.
  -h, --help             Show this help message.

Example:
  deno run -A scripts/custom-watch.ts --watch ./src --ext ts --exec "deno run -A main.ts"
  deno run -A scripts/custom-watch.ts --watch ./petplay --ext ts --verbose --wait 500 --exec "deno run -A petplay/petplay.ts dev"
    `);
    return;
  }

  try {
    const config = parseWatcherArgs(Deno.args);
    log(config.verbose, "Configuration:", config);

    const debouncedRunCommand = debounce(() => runCommand(config), config.waitDelay);

    console.log("[Watcher] Initial command run...");
    await runCommand(config); // Initial run

    for (const path of config.watchPaths) {
      (async () => {
        log(config.verbose, `Watching path: "${path}" for extensions: ${config.extensions.join(", ")}`);
        try {
          const watcher = Deno.watchFs(path, { recursive: true });
          for await (const event of watcher) {
            log(config.verbose, "FS Event:", event);
            if (["modify", "create", "remove"].includes(event.kind)) {
              if (event.paths.some(p => config.extensions.some(ext => p.endsWith(ext)))) {
                console.log(`[Watcher] Change detected in ${event.paths.join(", ")}. Triggering restart.`);
                debouncedRunCommand();
              }
            }
          }
        } catch (err) {
          console.error(`[Watcher] Error watching path "${path}":`, (err as Error).message);
          // Optionally, decide if the watcher should exit or try to recover.
          // For now, it just logs and that specific path won't be watched.
        }
      })();
    }
    console.log("[Watcher] File watcher(s) started. Press Ctrl-C to exit the watcher.");
  } catch (error) {
    console.error("[Watcher] Error:", (error as Error).message);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}