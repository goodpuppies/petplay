#!/usr/bin/env -S deno run -A
/**
 * PetPlay client CLI: talk to a running server, do not become one.
 *
 * A server is a long-lived `petplay/petplay.ts` process (`deno task server`)
 * whose actors own the scene, the XR frame loop and the supervision of
 * SteamVR. Everything a user launches from a shell — the desktop view, a
 * status readout, a SteamVR detach — is a *message* to that process over the
 * agent REPL, so no second copy of the scene is ever created:
 *
 * ```sh
 * deno task server                 # long-lived: scene + supervision + REPL
 * deno task desktop                # messages STARTDESKTOPCONTROL, prints the view status
 * deno task desktop -- --stop      # messages STOPDESKTOPCONTROL
 * deno task status                 # supervisor + overlay + desktop view readout
 * deno task dev                    # ensure a server, then start the desktop view
 * ```
 *
 * The renderer decoupling lives behind those messages: the server extracts the
 * scene to `ExtractionResult` IR and renderers (OpenVR overlay, desktop view)
 * rasterize the latest IR at their own rate. See `petplay/webxrOverlay.ts` for
 * the IR-consumer shape.
 */
import {
  DEFAULT_AGENT_REPL_PORT,
  getAgentReplBaseUrl,
  getAgentReplPort,
  wait,
} from "../classes/utils.ts";

const LOG_PREFIX = "[client]";
const SERVER_READY_TIMEOUT_MS = 90_000;
/** A one-shot preview capture waits for a child process to boot a window and draw one frame. */
const PREVIEW_CAPTURE_TIMEOUT_MS = 30_000;
/** How long a reboot waits for SIGTERM to be honoured before escalating. */
const SERVER_STOP_TIMEOUT_MS = 20_000;

type ServerHealth = {
  ok?: boolean;
  port?: number;
  actors?: Record<string, string>;
};

type SupervisorStatus = {
  running?: boolean;
  phase?: string;
  attachCount?: number;
  detachCount?: number;
  lastReason?: string | null;
  openvr?: {
    ready?: boolean;
    runtimeQuit?: boolean;
    initError?: string | null;
    initAttempts?: number;
    presence?: { libraryLoaded?: boolean; runtimeInstalled?: boolean; hmdPresent?: boolean } | null;
  } | null;
  attachment?: Record<string, unknown> | null;
};

type DesktopViewStatus = {
  running?: boolean;
  actorId?: string | null;
  details?: {
    running?: boolean;
    childPid?: number | null;
    lastError?: string | null;
    stopRequested?: boolean;
  } | null;
};

type WebXrStatus = {
  running?: boolean;
  frameCount?: number;
  xrFps?: number;
  overlayFps?: number;
  uploadedFrames?: number;
  raylib?: { expected?: boolean; overlayReady?: boolean; running?: boolean };
  views?: Array<{ label: string; sent: number; acked: number; dropped: number }>;
  keyboardLocale?: { id: string; source: string };
  presentation?: {
    watching: boolean;
    overlayVisible: boolean | null;
    stalledMs: number;
    repairs: number;
    restarts: number;
    lastRepairReason: string | null;
  };
};

type ReplReply<T> = { ok?: boolean; result?: T; error?: unknown };

function help(): string {
  return [
    "petplay client — talk to a running server",
    "",
    "usage: deno run -A petplay/client.ts <command> [--port=<n>] [--stop] [--follow]",
    "",
    "commands:",
    "  status     supervisor, scene/view and desktop readout",
    "  desktop    start the decoupled desktop view (renders the server's scene IR;",
    "             its own window and frame rate). --control selects the legacy",
    "             interactive surface, --stop tears the selected one down",
    "  capture    PNG through the desktop preview's own screen capture; uses a",
    "             running preview or starts a hidden one for one frame",
    "             (--path=<file.png>, --width=/--height= for that frame)",
    "  repair     repair the XR presentation in place (--restart restarts the stack)",
    "  reboot     stop the server, start it again with the same arguments, and",
    "             bring the desktop surface back (--no-detach skips the SteamVR",
    "             detach, --agent-repl-port=<n> picks the server)", 
    "  detach-vr  ordered SteamVR detach; the supervisor reattaches when it is back",
    "  dev        ensure a server is running, then start the desktop view",
    "",
    "port resolution matches the server: --agent-repl-port=<n>, then",
    "PETPLAY_AGENT_REPL_PORT, then 3987. An unreachable server is reported, not started,",
    "except by `dev`.",
  ].join("\n");
}

function hasFlag(flag: string): boolean {
  return Deno.args.includes(flag);
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getAgentReplBaseUrl()}${path}`, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${text.slice(0, 300)}`);
  }
  return (text.length > 0 ? JSON.parse(text) : {}) as T;
}

async function serverHealth(): Promise<ServerHealth | null> {
  try {
    const health = await fetchJson<ServerHealth>("/health");
    return health.ok === true ? health : null;
  } catch {
    return null;
  }
}

async function sendMessage<T>(
  target: string,
  type: string,
  payload: unknown = null,
  timeoutMs = 30_000,
): Promise<T> {
  const body = await fetchJson<ReplReply<T>>("/message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, type, payload, reply: true, timeoutMs }),
  });
  if (body.ok !== true) {
    throw new Error(`${type} on ${target} failed: ${JSON.stringify(body.error ?? body)}`);
  }
  return body.result as T;
}

async function requireServer(): Promise<ServerHealth> {
  const health = await serverHealth();
  if (health == null) {
    throw new Error(
      `no server on ${getAgentReplBaseUrl()} — start one with \`deno task server\` (or \`deno task dev\`)`,
    );
  }
  return health;
}

async function readSupervisor(health: ServerHealth): Promise<SupervisorStatus | null> {
  const target = health.actors?.main;
  if (target == null) {
    return null;
  }
  return await sendMessage<SupervisorStatus>(target, "GETSUPERVISORSTATUS");
}

async function readWebXr(health: ServerHealth): Promise<WebXrStatus | null> {
  const target = health.actors?.webxr;
  if (target == null) return null;
  try {
    return await fetchJson<{ health?: { details?: WebXrStatus } }>(
      `/health/actor?actor=${encodeURIComponent(target)}`,
    ).then((body) => body.health?.details ?? null);
  } catch {
    return null;
  }
}

async function readDesktopView(health: ServerHealth): Promise<DesktopViewStatus | null> {
  const target = health.actors?.main;
  if (target == null) return null;
  return await sendMessage<DesktopViewStatus>(target, "DESKTOPVIEWSTATUS");
}

async function readDesktopControl(health: ServerHealth): Promise<DesktopViewStatus | null> {
  const target = health.actors?.main;
  if (target == null) return null;
  return await sendMessage<DesktopViewStatus>(target, "DESKTOPCONTROLSTATUS");
}

function formatSupervisor(status: SupervisorStatus | null): string {
  if (status == null) return "unavailable";
  const openvr = status.openvr;
  const presence = openvr?.presence;
  const steamvr = presence == null
    ? "unknown"
    : presence.libraryLoaded !== true
    ? "library missing"
    : presence.hmdPresent === true
    ? "hmd present"
    : presence.runtimeInstalled === true
    ? "runtime up, no hmd"
    : "runtime not running";
  return [
    `phase=${status.phase ?? "?"}`,
    `steamvr=${openvr?.ready === true ? "attached" : "detached"} (${steamvr})`,
    `attaches=${status.attachCount ?? 0}`,
    `detaches=${status.detachCount ?? 0}`,
    `attempts=${openvr?.initAttempts ?? 0}`,
    `lastReason=${status.lastReason ?? "-"}`,
    openvr?.initError ? `initError=${openvr.initError}` : "",
  ].filter((part) => part.length > 0).join("  ");
}

function formatWebXr(status: WebXrStatus | null): string {
  if (status == null) return "unavailable";
  const overlay = status.raylib?.running === true
    ? "overlay running"
    : status.raylib?.overlayReady === true
    ? "overlay ready, pump stopped"
    : "no overlay (no runtime)";
  const views = (status.views ?? [])
    .map((view) => `${view.label}:${view.sent}/${view.acked}${view.dropped > 0 ? `-${view.dropped}` : ""}`)
    .join(" ");
  return [
    status.running === true ? "session running" : "session stopped",
    `${status.overlayFps?.toFixed(1) ?? "-"} fps overlay`,
    `${status.uploadedFrames ?? 0} frames`,
    overlay,
    views.length > 0 ? `views=[${views}]` : "views=none",
    status.keyboardLocale
      ? `keyboard=${status.keyboardLocale.id} (${status.keyboardLocale.source})`
      : "",
    status.presentation
      ? `presentation=${status.presentation.overlayVisible === false ? "hidden" : "ok"}${
        status.presentation.repairs + status.presentation.restarts > 0
          ? ` repairs=${status.presentation.repairs}+${status.presentation.restarts}restarts (last: ${status.presentation.lastRepairReason ?? "-"})`
          : ""
      }`
      : "",
  ].filter((part) => part.length > 0).join("  ");
}

function formatDesktopView(status: DesktopViewStatus | null): string {
  if (status == null) return "unavailable";
  const details = status.details;
  if (status.actorId == null) return "not started";
  const decoupled = details as {
    running?: boolean;
    framesReceived?: number;
    framesRendered?: number;
    framesAcked?: number;
    windowFps?: number;
    renderLagFrames?: number;
    offset?: number[];
    childPid?: number | null;
    lastError?: string | null;
  } | null;
  if (decoupled?.framesReceived != null) {
    const offset = decoupled.offset ?? [0, 0, 0];
    return [
      decoupled.running === true ? "window running" : "stopped",
      `${decoupled.windowFps ?? 0} fps window`,
      `ir=${decoupled.framesReceived} rendered=${decoupled.framesRendered} acked=${decoupled.framesAcked}`,
      `lag=${decoupled.renderLagFrames ?? 0}`,
      `offset=[${offset.map((value) => value.toFixed(2)).join(", ")}]`,
    ].join("  ");
  }
  return [
    decoupled?.running === true ? "window running" : "stopped",
    `pid=${decoupled?.childPid ?? "-"}`,
    decoupled?.lastError ? `lastError=${decoupled.lastError}` : "",
  ].filter((part) => part.length > 0).join("  ");
}

async function cmdStatus(): Promise<number> {
  const health = await requireServer();
  const [supervisor, webxr, desktopView, desktopControl] = await Promise.all([
    readSupervisor(health),
    readWebXr(health),
    readDesktopView(health),
    readDesktopControl(health),
  ]);
  console.log(`server    ${getAgentReplBaseUrl()}  actors=${Object.keys(health.actors ?? {}).length}`);
  console.log(`steamvr   ${formatSupervisor(supervisor)}`);
  console.log(`scene     ${formatWebXr(webxr)}`);
  console.log(`desktop   ${formatDesktopView(desktopView)}`);
  console.log(`control   ${formatDesktopView(desktopControl)}`);
  return 0;
}

async function cmdDesktop(): Promise<number> {
  const health = await requireServer();
  return await desktopCommand(health, {
    stopping: hasFlag("--stop"),
    interactive: hasFlag("--control"),
  });
}

/**
 * `desktop` drives the decoupled view actor: a window that renders the scene's IR
 * from the server (same scene as VR, its own render rate). `--control` selects the
 * legacy interactive surface, which mounts its own scene and can grab things.
 */
async function desktopCommand(
  health: ServerHealth,
  options: { stopping: boolean; interactive: boolean },
): Promise<number> {
  const target = health.actors?.main;
  if (target == null) {
    throw new Error("server has no `main` actor registered");
  }
  const verb = options.interactive
    ? options.stopping ? "STOPDESKTOPCONTROL" : "STARTDESKTOPCONTROL"
    : options.stopping ? "STOPDESKTOPVIEW" : "STARTDESKTOPVIEW";
  const status = await sendMessage<DesktopViewStatus>(target, verb);
  console.log(
    `desktop view ${options.interactive ? "control" : "decoupled"} ${
      options.stopping ? "stop" : "start"
    } -> ${formatDesktopView(status)}`,
  );
  if (hasFlag("--follow")) {
    while (true) {
      await wait(2_000);
      const current = await readDesktopView(await requireServer());
      console.log(`desktop   ${formatDesktopView(current)}`);
    }
  }
  return 0;
}

/** Repairs the scene's presentation in place — no process restart. */
async function cmdRepair(): Promise<number> {
  const health = await requireServer();
  const target = health.actors?.webxr;
  if (target == null) {
    throw new Error("server has no `webxr` actor registered");
  }
  const restart = hasFlag("--restart");
  const result = await sendMessage<Record<string, unknown>>(target, "REPAIRWEBXR", {
    reason: "client request",
    restart,
  });
  console.log(`${restart ? "restart" : "repair"} -> ${JSON.stringify(result)}`);
  return 0;
}

/**
 * PNG through the desktop preview's own screen-capture path. Uses a running
 * preview when there is one; otherwise starts a hidden one for a single frame
 * and stops it again, so no window has to be left running.
 */
async function cmdCapture(): Promise<number> {
  const health = await requireServer();
  const mainActor = health.actors?.main;
  if (mainActor == null) {
    throw new Error("server has no `main` actor registered");
  }
  const explicitPath = Deno.args.find((arg) => arg.startsWith("--path="))?.split("=", 2)[1];
  const path = explicitPath ?? `${Deno.cwd()}/desktop-view.png`;

  // A one-shot capture leaves its actor behind with the window already closed,
  // so the question is whether a view is *running*, not whether one exists.
  const viewActor = health.actors?.desktopView;
  if (viewActor != null && await previewIsRunning(mainActor)) {
    const result = await sendMessage<{ ok?: boolean; path?: string; error?: string }>(
      viewActor,
      "REQUESTCAPTURE",
      { path },
    );
    if (result.ok !== true) {
      throw new Error(`capture failed: ${result.error ?? "unknown error"}`);
    }
    console.log(`captured ${result.path}`);
    return 0;
  }

  const width = numberFlag("--width");
  const height = numberFlag("--height");
  await sendMessage(
    mainActor,
    "STARTDESKTOPVIEW",
    {
      capturePath: path,
      hidden: true,
      ...(width == null ? {} : { width }),
      ...(height == null ? {} : { height }),
    },
    // Starting a view may have to retire a stale actor and boot a child process.
    PREVIEW_CAPTURE_TIMEOUT_MS,
  );
  const written = await waitForPreviewCapture(mainActor, path, PREVIEW_CAPTURE_TIMEOUT_MS);
  // The one-shot window stops itself once the PNG is written; this releases the
  // child process the server keeps for it.
  await sendMessage(mainActor, "STOPDESKTOPVIEW").catch((error) =>
    console.warn(
      `[client] stopping the capture view: ${error instanceof Error ? error.message : String(error)}`,
    )
  );
  if (written == null) {
    throw new Error(`desktop view wrote no capture within ${PREVIEW_CAPTURE_TIMEOUT_MS}ms`);
  }
  console.log(`captured ${written}`);
  return 0;
}

/** Whether the server's decoupled view has a live window loop. */
async function previewIsRunning(mainActor: string): Promise<boolean> {
  const status = await sendMessage<{ details?: { running?: boolean } }>(
    mainActor,
    "DESKTOPVIEWSTATUS",
  ).catch(() => null);
  return status?.details?.running === true;
}

/** `--name=value` as a number, or null when absent/not a number. */
function numberFlag(name: string): number | null {
  const raw = Deno.args.find((arg) => arg.startsWith(`${name}=`))?.split("=", 2)[1];
  const parsed = raw == null ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Waits for a one-shot preview capture. Polls the server's view status rather
 * than the filesystem: the status is what knows whether the window failed.
 */
async function waitForPreviewCapture(
  mainActor: string,
  path: string,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    await wait(250);
    const status = await sendMessage<
      { details?: { captureWritten?: string | null; lastError?: string | null; running?: boolean } }
    >(mainActor, "DESKTOPVIEWSTATUS").catch(() => null);
    const written = status?.details?.captureWritten ?? null;
    if (written != null && written.length > 0) {
      return written;
    }
    const error = status?.details?.lastError;
    if (error != null && error.length > 0) {
      throw new Error(`desktop view capture failed: ${error}`);
    }
    if (status?.details?.running === false && written == null) {
      return null;
    }
  }
  console.warn(`[client] timed out waiting for ${path}`);
  return null;
}

async function cmdDetachVr(): Promise<number> {
  const health = await requireServer();
  const target = health.actors?.main;
  if (target == null) {
    throw new Error("server has no `main` actor registered");
  }
  const result = await sendMessage<Record<string, unknown> | SupervisorStatus>(
    target,
    "DETACHOPENVR",
  );
  console.log(`detach -> ${JSON.stringify(result)}`);
  return 0;
}

/**
 * Reboot the server in place: ordered SteamVR detach, stop the process, start a
 * fresh one with the same arguments, then bring back the desktop surface that
 * was running. Reloading individual actors (`/reload`) is the cheap path; this is
 * for when the server's own code changed.
 */
async function cmdReboot(): Promise<number> {
  const port = getAgentReplPort();
  const health = await serverHealth();
  let desktopWasRunning = false;
  let controlWasRunning = false;
  if (health != null) {
    const [view, control] = await Promise.all([
      readDesktopView(health),
      readDesktopControl(health),
    ]);
    desktopWasRunning = view?.details?.running === true;
    controlWasRunning = control?.details?.running === true;
    const mainActor = health.actors?.main;
    if (mainActor != null && !hasFlag("--no-detach")) {
      // Ordered detach while the old process is still alive: SteamVR sees a
      // clean detach and the new server reattaches, instead of an overlay left
      // behind by a killed process.
      const detached = await sendMessage<unknown>(mainActor, "DETACHOPENVR").catch((error) => error);
      console.log(`${LOG_PREFIX} steamvr detach -> ${formatValue(detached)}`);
    }
  }

  const serverProcess = findServerProcess(port);
  if (serverProcess == null) {
    console.log(`${LOG_PREFIX} no server process found for port ${port}`);
  } else {
    console.log(
      `${LOG_PREFIX} stopping pid=${serverProcess.pid}` +
        `${serverProcess.viaLauncher ? " (launcher; forwards one signal, then waits for teardown)" : ""}`,
    );
    await stopServerProcess(serverProcess.pid);
  }

  await startServer(serverProcess?.args ?? []);
  if (controlWasRunning) {
    await startDesktopSurface("STARTDESKTOPCONTROL");
  } else if (desktopWasRunning) {
    await startDesktopSurface("STARTDESKTOPVIEW");
  }
  return await cmdStatus();
}

/** `undefined`/`Error`/objects printed as one readable line. */
function formatValue(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value === undefined) return "(no reply)";
  return JSON.stringify(value)?.slice(0, 160) ?? String(value);
}

/** A running server, found through `/proc` because the REPL health carries no pid. */
type ServerProcess = { pid: number; args: string[]; viaLauncher: boolean };

/**
 * Finds the server for `port`. Prefers the `utils/dev-runner.ts` launcher, which
 * turns one SIGTERM into a cooperative shutdown of the server it spawned; falls
 * back to a directly launched server. `args` are the launcher's own extra
 * arguments, so a reboot keeps `--novr`, debug flags, locale overrides and the
 * like.
 */
function findServerProcess(port: number): ServerProcess | null {
  if (Deno.build.os !== "linux") {
    return null;
  }
  // A server is ours if it was told this port, or if neither side names one and
  // both therefore run on the default.
  const portOf = (args: string[]): number | null => {
    const flag = args.find((arg) => arg.startsWith("--agent-repl-port="));
    const parsed = flag == null ? NaN : Number(flag.split("=", 2)[1]);
    return Number.isFinite(parsed) ? parsed : null;
  };
  let launcher: ServerProcess | null = null;
  let direct: ServerProcess | null = null;
  for (const entry of Deno.readDirSync("/proc")) {
    if (!/^\d+$/.test(entry.name)) {
      continue;
    }
    const pid = Number(entry.name);
    if (pid === Deno.pid) {
      continue;
    }
    let raw: Uint8Array;
    try {
      raw = Deno.readFileSync(`/proc/${pid}/cmdline`);
    } catch {
      continue;
    }
    const args = new TextDecoder().decode(raw).split("\0").filter((arg) => arg.length > 0);
    const explicitPort = portOf(args);
    if (explicitPort !== port && !(explicitPort == null && port === DEFAULT_AGENT_REPL_PORT)) {
      continue;
    }
    const scriptIndex = args.findIndex((arg) =>
      arg.endsWith("utils/dev-runner.ts") || arg.endsWith("petplay/petplay.ts")
    );
    if (scriptIndex < 0) {
      continue;
    }
    const viaLauncher = args[scriptIndex]!.endsWith("dev-runner.ts");
    // Everything after the script is forwarded to PetPlay; the REPL flags are
    // re-added by the launcher, so they are dropped to avoid duplicating them.
    const extra = args.slice(scriptIndex + 1).filter((arg) =>
      arg !== "--agent-repl" && !arg.startsWith("--agent-repl-port")
    );
    const found: ServerProcess = { pid, args: extra, viaLauncher };
    if (viaLauncher) {
      launcher ??= found;
    } else {
      direct ??= found;
    }
  }
  return launcher ?? direct;
}

/** SIGTERM, then SIGKILL if the REPL has not gone away, and wait for both. */
async function stopServerProcess(pid: number): Promise<void> {
  try {
    Deno.kill(pid, "SIGTERM");
  } catch (error) {
    console.warn(`${LOG_PREFIX} SIGTERM ${pid}: ${formatValue(error)}`);
    return;
  }
  if (await waitForServerDown(SERVER_STOP_TIMEOUT_MS)) {
    return;
  }
  console.warn(`${LOG_PREFIX} pid=${pid} did not exit within ${SERVER_STOP_TIMEOUT_MS}ms; SIGKILL`);
  try {
    Deno.kill(pid, "SIGKILL");
  } catch (error) {
    console.warn(`${LOG_PREFIX} SIGKILL ${pid}: ${formatValue(error)}`);
  }
  await waitForServerDown(5_000);
}

/** Waits until the REPL stops answering, i.e. the server is gone. */
async function waitForServerDown(timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await serverHealth() == null) {
      return true;
    }
    await wait(250);
  }
  return false;
}

/** Brings a desktop surface back on the freshly booted server. */
async function startDesktopSurface(verb: "STARTDESKTOPVIEW" | "STARTDESKTOPCONTROL"): Promise<void> {
  const health = await serverHealth();
  const mainActor = health?.actors?.main;
  if (mainActor == null) {
    return;
  }
  const status = await sendMessage<DesktopViewStatus>(mainActor, verb).catch((error) => error);
  console.log(
    `${LOG_PREFIX} ${verb === "STARTDESKTOPVIEW" ? "desktop view" : "control surface"} restored -> ${
      status instanceof Error ? status.message : formatDesktopView(status as DesktopViewStatus)
    }`,
  );
}

/** Starts a detached server (`deno task server` equivalent) and waits for its REPL. */
async function startServer(extraArgs: string[] = []): Promise<void> {
  const port = getAgentReplPort();
  // Through `utils/dev-runner.ts`: it mirrors the server's output to `logs/`
  // (which is what survives a native FFI crash) and gives it its own process
  // group, so the client can exit without taking the server down.
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "utils/dev-runner.ts",
      "--agent-repl",
      `--agent-repl-port=${port}`,
      ...extraArgs,
    ],
    cwd: Deno.cwd(),
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  child.unref();
  console.log(
    `${LOG_PREFIX} started server pid=${child.pid} port=${port} (log in ./logs)` +
      (extraArgs.length > 0 ? ` args=[${extraArgs.join(" ")}]` : ""),
  );
  const deadline = performance.now() + SERVER_READY_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (await serverHealth() != null) return;
    await wait(500);
  }
  console.warn(`${LOG_PREFIX} server did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}

async function cmdDev(): Promise<number> {
  if (await serverHealth() == null) {
    await startServer();
  }
  const status = await cmdDesktop();
  if (status !== 0) {
    return status;
  }
  await cmdStatus();
  return 0;
}

async function main(): Promise<number> {
  const command = Deno.args.find((arg) => !arg.startsWith("-")) ?? "status";
  switch (command) {
    case "status":
      return await cmdStatus();
    case "desktop":
      return await cmdDesktop();
    case "capture":
      return await cmdCapture();
    case "repair":
      return await cmdRepair();
    case "reboot":
      return await cmdReboot();
    case "detach-vr":
      return await cmdDetachVr();
    case "dev":
      return await cmdDev();
    case "help":
    case "--help":
      console.log(help());
      return 0;
    default:
      console.error(`${LOG_PREFIX} unknown command "${command}"\n`);
      console.error(help());
      return 2;
  }
}

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (error) {
    console.error(`${LOG_PREFIX} ${error instanceof Error ? error.message : error}`);
    Deno.exit(1);
  }
}
