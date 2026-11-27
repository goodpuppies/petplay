/**
 * Per-run diagnostic log for the compiled release, the binary testers run on hardware we do not
 * have. The process a user starts becomes a thin logging parent: it runs PetPlay as its child,
 * mirrors all output (every worker and child process inherits the child's stdout/stderr) to the
 * terminal and to `logs/current.log` in the state directory (classes/appPaths.ts; earlier runs are
 * kept as `petplay-<start time>.log`, `--logs` prints where), and adds what a bug report
 * needs: the system, session and portal environment up front, CPU per PetPlay process and thermal
 * zone temperatures every 30 s, and how PetPlay exited (a native crash included).
 *
 * The parent stays in the terminal's process group, so Ctrl-C reaches PetPlay directly; it forwards
 * only SIGTERM, which is sent to it alone. PetPlay exits when its parent disappears
 * ([watchLogParent]), so killing the parent never leaves PetPlay running. Checkouts get the same
 * mirroring from `utils/dev-runner.ts`; `--no-log-file` turns this off.
 */
import { join } from "@std/path";
import { configDir, logsDir } from "./appPaths.ts";
import { describeBuild } from "./buildInfo.ts";
import { RESTART_EXIT_CODE } from "./processExitRequest.ts";

const CHILD_ENV = "PETPLAY_LOG_PARENT_PID";
const KEEP_LOGS = 10;
const HEALTH_INTERVAL_MS = 30_000;

/** The compiled binary starting normally, not already under a logging parent. */
export function shouldRunLogParent(args: readonly string[]): boolean {
  return Deno.build.standalone && Deno.env.get(CHILD_ENV) == null &&
    !args.includes("--no-log-file");
}

function logDirectory(): string {
  return logsDir();
}

const CURRENT_LOG = "current.log";

function stampOf(time: Date): string {
  return time.toISOString().replaceAll(":", "-").replace(".", "-");
}

/**
 * The running (or last) PetPlay logs to `current.log`. Before a new run takes it, the previous one
 * is renamed to `petplay-<its start time>.log`. If it cannot be (another PetPlay is still writing
 * it, on Windows), this run gets a timestamped name instead.
 * @returns the path this run logs to.
 */
export function archiveCurrentLog(directory: string): string {
  const current = join(directory, CURRENT_LOG);
  let previous: Deno.FileInfo;
  try {
    previous = Deno.statSync(current);
  } catch {
    return current;
  }
  const started = read(current)?.match(/^started (\S+)$/m)?.[1];
  const time = started != null && !Number.isNaN(Date.parse(started))
    ? new Date(started)
    : previous.mtime ?? new Date();
  try {
    Deno.renameSync(current, join(directory, `petplay-${stampOf(time)}.log`));
    return current;
  } catch {
    return join(directory, `petplay-${stampOf(new Date())}.log`);
  }
}

function pruneLogs(directory: string): void {
  try {
    const logs = [...Deno.readDirSync(directory)]
      .filter((entry) => entry.isFile && /^petplay-.*\.log$/.test(entry.name))
      .map((entry) => entry.name).sort();
    for (const name of logs.slice(0, Math.max(0, logs.length - KEEP_LOGS + 1))) {
      Deno.removeSync(join(directory, name));
    }
  } catch {
    // Old logs are a convenience; never fail a start over them.
  }
}

function read(path: string): string | null {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return null;
  }
}

type ProcessInfo = {
  pid: number;
  ppid: number;
  comm: string;
  cmd: string;
  ticks: number;
  rssKb: number;
};

function processes(): ProcessInfo[] {
  if (Deno.build.os !== "linux") return [];
  const out: ProcessInfo[] = [];
  for (const entry of Deno.readDirSync("/proc")) {
    if (!/^\d+$/.test(entry.name)) continue;
    const stat = read(`/proc/${entry.name}/stat`);
    if (stat == null) continue;
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    const cmd = (read(`/proc/${entry.name}/cmdline`) ?? "").replaceAll("\0", " ").trim();
    out.push({
      pid: Number(entry.name),
      ppid: Number(fields[1]),
      comm: stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")),
      cmd,
      ticks: Number(fields[11]) + Number(fields[12]),
      rssKb: Number(fields[21]) * 4,
    });
  }
  return out;
}

/** What a PetPlay process is: the dispatched module's file name, or its executable. */
function role(info: ProcessInfo): string {
  const module = info.cmd.match(/--petplay-run-module=\S*\/([^/\s]+?)\.tsx?\b/)?.[1];
  if (module === "WebSocketWorkerHost") {
    return info.cmd.match(/--script=\S*\/([^/\s]+?)\.tsx?\b/)?.[1] ?? module;
  }
  return module ?? info.comm;
}

const SESSION_ENV = [
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_TYPE",
  "DESKTOP_SESSION",
  "WAYLAND_DISPLAY",
  "DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "XDG_DESKTOP_PORTAL_DIR",
  "GAMESCOPE_WAYLAND_DISPLAY",
  "SteamAppId",
  "SteamGameId",
  "STEAM_COMPAT_APP_ID",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_ENV",
  "DENO_CONDITIONS",
  "VR_OVERRIDE",
  "VR_CONFIG_PATH",
  "VR_PATHREG_OVERRIDE",
];
const SESSION_PROCESSES =
  /xdg-desktop-portal|kwin|plasmashell|gamescope|vrserver|vrcompositor|vrmonitor|^steam$|steamwebhelper|pipewire|wireplumber/;

function header(logPath: string): string {
  const lines = [`[petplay log] ${logPath}`, `started ${new Date().toISOString()}`];
  lines.push(`build ${describeBuild()}`);
  lines.push(`exe ${Deno.execPath()} args ${JSON.stringify(Deno.args)} cwd ${Deno.cwd()}`);
  const osRelease = read("/etc/os-release");
  const pretty = osRelease?.match(/^PRETTY_NAME="?([^"\n]*)/m)?.[1];
  const version = osRelease?.match(/^VERSION_ID="?([^"\n]*)/m)?.[1];
  lines.push(
    `os ${pretty ?? Deno.build.os} ${
      version ?? ""
    } kernel ${Deno.osRelease()} arch ${Deno.build.arch} deno ${Deno.version.deno}`,
  );
  const cpu = read("/proc/cpuinfo");
  const model = cpu?.match(/^(model name|Hardware|Processor)\s*:\s*(.+)$/m)?.[2];
  const memory = (() => {
    try {
      return `${Math.round(Deno.systemMemoryInfo().total / 2 ** 30)} GiB`;
    } catch {
      return "?";
    }
  })();
  lines.push(`cpu ${model ?? "?"} cores ${navigator.hardwareConcurrency} memory ${memory}`);
  for (const name of SESSION_ENV) {
    const value = Deno.env.get(name);
    if (value != null) lines.push(`env ${name}=${value}`);
  }
  for (const info of processes()) {
    if (SESSION_PROCESSES.test(info.comm)) {
      lines.push(`process ${info.pid} ${info.comm}: ${info.cmd.slice(0, 160)}`);
    }
  }
  for (const dir of [Deno.env.get("XDG_DESKTOP_PORTAL_DIR"), "/usr/share/xdg-desktop-portal"]) {
    if (!dir) continue;
    try {
      const configs = [...Deno.readDirSync(dir)].map((entry) => entry.name).sort();
      lines.push(`portal dir ${dir}: ${configs.join(" ")}`);
      for (const name of configs.filter((n) => n.endsWith(".conf"))) {
        const text = read(join(dir, name))?.replace(/\s+/g, " ").trim();
        if (text) lines.push(`portal ${name}: ${text.slice(0, 300)}`);
      }
    } catch {
      // Not every system has both.
    }
  }
  const token = read(join(configDir(), "screencast-restore-token"));
  lines.push(`capture restore token ${token == null ? "none" : "present"}`);
  return lines.join("\n") + "\n";
}

function thermal(): string {
  if (Deno.build.os !== "linux") return "";
  const zones: string[] = [];
  try {
    for (const entry of Deno.readDirSync("/sys/class/thermal")) {
      if (!entry.name.startsWith("thermal_zone")) continue;
      const temp = Number(read(`/sys/class/thermal/${entry.name}/temp`));
      const type = read(`/sys/class/thermal/${entry.name}/type`)?.trim() ?? entry.name;
      if (Number.isFinite(temp) && temp > 0) zones.push(`${type}=${(temp / 1000).toFixed(0)}C`);
    }
  } catch {
    // No thermal sysfs.
  }
  return zones.sort().join(" ");
}

/** One line per interval: CPU cores used per PetPlay process, total RSS and temperatures. */
function healthSampler(root: number): () => string {
  let last = new Map<number, number>();
  let lastAt = performance.now();
  const ticksPerSecond = 100;
  return () => {
    const all = processes();
    const tree = new Set([root]);
    for (let grew = true; grew;) {
      grew = false;
      for (const info of all) {
        if (!tree.has(info.pid) && tree.has(info.ppid)) {
          tree.add(info.pid);
          grew = true;
        }
      }
    }
    const now = performance.now();
    const seconds = (now - lastAt) / 1000;
    const next = new Map<number, number>();
    const parts: string[] = [];
    let total = 0;
    let rss = 0;
    for (const info of all) {
      if (!tree.has(info.pid)) continue;
      next.set(info.pid, info.ticks);
      rss += info.rssKb;
      const previous = last.get(info.pid);
      if (previous == null) continue;
      const cores = (info.ticks - previous) / ticksPerSecond / seconds;
      total += cores;
      if (cores >= 0.05) parts.push(`${role(info)}:${cores.toFixed(2)}`);
    }
    last = next;
    lastAt = now;
    return `[petplay health] cpu ${total.toFixed(2)} cores (${parts.join(" ")}) rss ${
      Math.round(rss / 1024)
    } MiB procs ${tree.size} ${thermal()}\n`;
  };
}

/** Runs PetPlay as a child, mirrors and logs it, and returns the exit code to exit with. */
export async function runLogParent(): Promise<number> {
  const directory = logDirectory();
  let logFile: Deno.FsFile | null = null;
  let logPath = "(not written)";
  try {
    Deno.mkdirSync(directory, { recursive: true });
    logPath = archiveCurrentLog(directory);
    pruneLogs(directory);
    logFile = Deno.openSync(logPath, { createNew: true, write: true });
  } catch (error) {
    console.error(`[petplay log] cannot write a log file: ${error}`);
  }
  const encoder = new TextEncoder();
  let pending = Promise.resolve();
  const toFile = (chunk: Uint8Array) => {
    if (logFile == null) return pending;
    const file = logFile;
    const copy = chunk.slice();
    pending = pending.then(async () => {
      for (let written = 0; written < copy.length;) {
        written += await file.write(copy.subarray(written));
      }
    }).catch(() => {});
    return pending;
  };
  const note = (text: string) => {
    const bytes = encoder.encode(text);
    toFile(bytes);
    return bytes;
  };
  note(header(logPath));
  console.log(`[petplay] log file: ${logPath}`);

  // Read now: after an update replaced the file, Linux reports this executable as "(deleted)".
  const launchedFrom = Deno.execPath();
  const spawnChild = (executable: string) =>
    new Deno.Command(executable, {
      args: [...Deno.args],
      env: { [CHILD_ENV]: String(Deno.pid) },
      stdin: "inherit",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  let child = spawnChild(launchedFrom);
  note(`[petplay log] child pid ${child.pid}\n`);

  const listeners: Array<[Deno.Signal, () => void]> = [];
  const listen = (signal: Deno.Signal, handler: () => void) => {
    try {
      Deno.addSignalListener(signal, handler);
      listeners.push([signal, handler]);
    } catch {
      // Not every signal exists on every platform.
    }
  };
  // The terminal's Ctrl-C already reached PetPlay (same process group); just stay to log it.
  listen("SIGINT", () => note(`[petplay log] SIGINT\n`));
  listen("SIGTERM", () => {
    note(`[petplay log] SIGTERM; forwarding to PetPlay\n`);
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  });

  const mirror = async (source: ReadableStream<Uint8Array>, sink: WritableStream<Uint8Array>) => {
    const writer = sink.getWriter();
    try {
      for await (const chunk of source) {
        toFile(chunk);
        await writer.write(chunk).catch(() => {});
      }
    } finally {
      writer.releaseLock();
    }
  };
  const restarts: number[] = [];
  let status: Deno.CommandStatus;
  for (;;) {
    const running = child;
    const mirrors = Promise.all([
      mirror(running.stdout, Deno.stdout.writable),
      mirror(running.stderr, Deno.stderr.writable),
    ]);
    const sample = healthSampler(running.pid);
    sample();
    const timer = Deno.build.os === "linux"
      ? setInterval(() => note(sample()), HEALTH_INTERVAL_MS)
      : null;
    status = await running.status;
    if (timer != null) clearInterval(timer);
    // Grandchildren may still hold the pipes; bound the drain so the parent exits with its child.
    await Promise.race([mirrors, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (status.code !== RESTART_EXIT_CODE) break;
    // Restart (classes/restart.ts): run the executable an update put in place, as the next child.
    const now = Date.now();
    restarts.push(now);
    if (restarts.filter((t) => now - t < 120_000).length > 3) {
      note(`[petplay log] restart requested again within two minutes; not restarting\n`);
      break;
    }
    // Let the old child's helpers release their ports and overlay keys.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    try {
      const { restartExecutable } = await import("./restart.ts");
      const executable = restartExecutable(launchedFrom);
      child = spawnChild(executable);
      note(
        `[petplay log] restarted ${
          new Date().toISOString()
        }: ${executable}, child pid ${child.pid}\n`,
      );
    } catch (error) {
      note(`[petplay log] restart failed: ${error}\n`);
      break;
    }
  }
  for (const [signal, handler] of listeners) Deno.removeSignalListener(signal, handler);
  const footer = note(
    `[petplay log] exited ${new Date().toISOString()} code ${status.code} signal ${
      status.signal ?? "none"
    }\n`,
  );
  await Deno.stderr.write(footer).catch(() => 0);
  await pending;
  logFile?.close();
  return status.code;
}

/** Child side: run `onOrphaned` once the logging parent is gone. */
export function watchLogParent(onOrphaned: () => void): void {
  const parent = Number(Deno.env.get(CHILD_ENV));
  if (!Number.isInteger(parent) || parent <= 0 || Deno.build.os === "windows") return;
  const timer = setInterval(() => {
    if (Deno.ppid !== parent) {
      clearInterval(timer);
      onOrphaned();
    }
  }, 2_000);
  Deno.unrefTimer(timer);
}
