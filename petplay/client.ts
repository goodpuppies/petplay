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
  fetchAgentReplJson,
  getAgentReplBaseUrl,
  getAgentReplPort,
  wait,
} from "../classes/utils.ts";
import {
  findServerProcess,
  SERVER_READY_TIMEOUT_MS,
  SERVER_STOP_TIMEOUT_MS,
  serverHealth,
  startServer,
  stopServerProcess,
  type ServerHealth,
} from "./serverProcess.ts";
import { OPENVR_REATTACH_ARG } from "../classes/steamVrProcess.ts";

const LOG_PREFIX = "[client]";
/** A one-shot preview capture waits for a child process to boot a window and draw one frame. */
const PREVIEW_CAPTURE_TIMEOUT_MS = 30_000;

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
    "  camera     transparent window rendered from the VRChat camera, for OBS to",
    "             stack over VRChat's stream output (--width=/--height= to match it,",
    "             --fov=<deg> until VRChat reports its zoom, --diagnostics, --stop)",
    "             `camera calibrate [--seconds=10]`: hold the VRChat camera and turn",
    "             it slowly; redo after locomotion. `camera status` reads both",
    "  vrcdepth   VRChat depth sync from the debug avatar's block in VRChat's window:",
    "             `vrcdepth start [--grid=128]`, `vrcdepth stop`, `vrcdepth status`;",
    "             `vrcdepth set --latency=<ms> --mesh=on|off --real-eye-height=<m>|auto",
    "             `vrcdepth set --calibration=auto|1d|3d`: block colour calibration (auto by default)",
    "             `vrcdepth set --head-camera=on|off [--head-camera-offset=0.15]`: pin VRChat's Stream",
    "             camera ahead of the headset (VR occlusion source)",
    "             `vrcdepth set --occlusion=on|off`: VRChat's depth hides PetPlay objects in the headset",
    "             `vrcdepth set --headset-decode=on|off`: decode depth in the headset renderer (default on)",
    "             --scan=on|off|clear --voxel=<m>`",
    "             (markdown/vrchat-depth)",
    "             `vrcdepth debug [--stop]`: desktop MKB fly camera, live depth + player pose",
    "  vrc        VRChat instance peer discovery + TOFU trust:",
    "             `vrc status`, `vrc peers`, `vrc trusted`,",
    "             `vrc trust <usr_...|displayName> [--force]`, `vrc untrust <usr_...>`,",
    "             `vrc test-prompt [displayName] [--mismatch]`, `vrc clear-test`",
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

async function sendMessage<T>(
  target: string,
  type: string,
  payload: unknown = null,
  timeoutMs = 30_000,
): Promise<T> {
  const body = await fetchAgentReplJson<ReplReply<T>>("/message", {
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
    return await fetchAgentReplJson<{ health?: { details?: WebXrStatus } }>(
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

type VrcCameraCalibrationStatus = {
  calibrating: boolean;
  calibrationRemainingMs: number;
  samples: number;
  calibration: {
    hand: string;
    rmsErrorMeters: number;
    maxErrorMeters: number;
    scale: number;
    yawRad: number;
    samples: number;
  } | null;
  lastError: string | null;
  hasWorldPose: boolean;
  fovYDeg: number | null;
};

/** `camera` drives the VRChat camera layer and its calibration (see `desktopView.ts`). */
async function cmdCamera(): Promise<number> {
  const health = await requireServer();
  const main = health.actors?.main;
  const webxr = health.actors?.webxr;
  if (main == null || webxr == null) {
    throw new Error("server has no `main`/`webxr` actor registered");
  }
  const sub = Deno.args.filter((arg) => !arg.startsWith("-"))[1];
  if (sub === "calibrate") {
    const seconds = numberFlag("--seconds") ?? 10;
    let status = await sendMessage<VrcCameraCalibrationStatus>(webxr, "STARTVRCCAMERACALIBRATION", {
      durationMs: seconds * 1000,
    });
    console.log(`calibrating for ${seconds}s: hold the VRChat camera and slowly turn it`);
    if (!status.hasWorldPose) {
      console.warn("no VRChat camera pose received yet: is the camera open and OSC enabled?");
    }
    while (status.calibrating) {
      await wait(1_000);
      status = await sendMessage<VrcCameraCalibrationStatus>(webxr, "GETVRCCAMERACALIBRATION");
      if (status.calibrating) {
        console.log(`  ${Math.ceil(status.calibrationRemainingMs / 1000)}s left, ${status.samples} samples`);
      }
      if (status.calibrating && status.calibrationRemainingMs <= 0) {
        // Poses stopped arriving; solve with what there is.
        status = await sendMessage<VrcCameraCalibrationStatus>(webxr, "STOPVRCCAMERACALIBRATION");
      }
    }
    console.log(formatVrcCameraCalibration(status));
    return status.lastError == null ? 0 : 1;
  }
  if (sub === "status") {
    const [view, calibration] = await Promise.all([
      sendMessage<DesktopViewStatus>(main, "VRCCAMERAVIEWSTATUS"),
      sendMessage<VrcCameraCalibrationStatus>(webxr, "GETVRCCAMERACALIBRATION"),
    ]);
    console.log(`camera view  ${formatDesktopView(view)}`);
    console.log(`calibration  ${formatVrcCameraCalibration(calibration)}`);
    return 0;
  }
  const stopping = hasFlag("--stop");
  const status = await sendMessage<DesktopViewStatus>(
    main,
    stopping ? "STOPVRCCAMERAVIEW" : "STARTVRCCAMERAVIEW",
    stopping ? null : {
      width: numberFlag("--width") ?? undefined,
      height: numberFlag("--height") ?? undefined,
      fovYDeg: numberFlag("--fov") ?? undefined,
      diagnostics: hasFlag("--diagnostics"),
    },
  );
  console.log(`camera view ${stopping ? "stop" : "start"} -> ${formatDesktopView(status)}`);
  return 0;
}

function formatVrcCameraCalibration(status: VrcCameraCalibrationStatus): string {
  const fov = status.fovYDeg == null ? "fov unreported" : `fov ${status.fovYDeg.toFixed(1)}deg`;
  const pose = status.hasWorldPose ? "pose received" : "no pose yet";
  if (status.lastError) return `failed: ${status.lastError} (${pose}, ${fov})`;
  const fit = status.calibration;
  if (fit == null) return `not calibrated (${pose}, ${fov})`;
  return `${fit.hand} hand, rms ${(fit.rmsErrorMeters * 100).toFixed(1)}cm max ${
    (fit.maxErrorMeters * 100).toFixed(1)
  }cm, scale ${fit.scale.toFixed(3)}, yaw ${(fit.yawRad * 180 / Math.PI).toFixed(1)}deg, ${fit.samples} samples (${fov})`;
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
    await stopServerProcess(
      serverProcess.pid,
      (message) => console.warn(`${LOG_PREFIX} ${message}`),
    );
  }

  await startServerAndReport(serverProcess?.args ?? []);
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

/** `startServer` plus the client's own reporting; a reboot and `dev` share it. */
async function startServerAndReport(extraArgs: string[] = []): Promise<void> {
  const port = getAgentReplPort();
  const { pid, ready } = await startServer(extraArgs);
  console.log(
    `${LOG_PREFIX} started server pid=${pid} port=${port} (log in ./logs)` +
      (extraArgs.length > 0 ? ` args=[${extraArgs.join(" ")}]` : ""),
  );
  if (!ready) {
    console.warn(`${LOG_PREFIX} server did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
  }
}

async function cmdDev(): Promise<number> {
  if (await serverHealth() == null) {
    // A dev server outlives SteamVR restarts; see OPENVR_REATTACH_ARG.
    await startServerAndReport([OPENVR_REATTACH_ARG]);
  }
  const status = await cmdDesktop();
  if (status !== 0) {
    return status;
  }
  await cmdStatus();
  return 0;
}

/** `vrcdepth` drives the VRChat depth intake and shows its sync (`petplay/vrchatDepth.ts`). */
async function cmdVrcDepth(): Promise<number> {
  const health = await requireServer();
  const main = health.actors?.main;
  const webxr = health.actors?.webxr;
  if (main == null || webxr == null) {
    throw new Error("server has no `main`/`webxr` actor registered");
  }
  const sub = Deno.args.filter((arg) => !arg.startsWith("-"))[1] ?? "status";
  if (sub === "debug") {
    if (hasFlag("--stop")) {
      const view = health.actors?.vrcCameraView;
      if (view) console.log(JSON.stringify(await sendMessage(view, "STARTDESKTOPVIEW", { depthDebug: false }), null, 2));
      return 0;
    }
    const intake = await sendMessage<{ window?: { width: number; height: number; x?: number; y?: number } | null }>(main, "STARTVRCDEPTH", null);
    const existingView = health.actors?.vrcCameraView;
    console.log(JSON.stringify(await sendMessage(existingView ?? main, existingView ? "STARTDESKTOPVIEW" : "STARTVRCCAMERAVIEW", {
      depthDebug: true,
      cameraOriginTarget: health.actors?.cameraOrigin,
      depthTarget: health.actors?.vrchatDepth ?? undefined,
      width: numberFlag("--width") ?? (existingView ? undefined : intake.window?.width),
      height: numberFlag("--height") ?? (existingView ? undefined : intake.window?.height),
      x: existingView ? undefined : intake.window?.x,
      y: existingView ? undefined : intake.window?.y,
    }), null, 2));
    return 0;
  }
  if (sub === "start") {
    const grid = numberFlag("--grid");
    console.log(JSON.stringify(
      await sendMessage(main, "STARTVRCDEPTH", grid ? { grid } : null),
      null,
      2,
    ));
    return 0;
  }
  if (sub === "stop") {
    console.log(JSON.stringify(await sendMessage(main, "STOPVRCDEPTH"), null, 2));
    return 0;
  }
  if (sub === "set") {
    const mesh = Deno.args.find((arg) => arg.startsWith("--mesh="))?.slice(7);
    const eyeHeight = Deno.args.find((arg) => arg.startsWith("--real-eye-height="))?.slice(18);
    const calibrationPolicy = Deno.args.find((arg) => arg.startsWith("--calibration="))?.slice(14);
    const headCamera = Deno.args.find((arg) => arg.startsWith("--head-camera="))?.slice(14);
    const occlusion = Deno.args.find((arg) => arg.startsWith("--occlusion="))?.slice(12);
    const headsetDecode = Deno.args.find((arg) => arg.startsWith("--headset-decode="))?.slice(17);
    if (calibrationPolicy != null) {
      const intake = health.actors?.vrchatDepth;
      if (intake == null) throw new Error("vrcdepth is not running");
      await sendMessage(intake, "SETVRCDEPTHCALIBRATION", { policy: calibrationPolicy });
    }
    if (eyeHeight != null) {
      const intake = health.actors?.vrchatDepth;
      if (intake == null) throw new Error("vrcdepth is not running");
      await sendMessage(intake, "SETVRCDEPTHREALEYEHEIGHT", {
        meters: eyeHeight === "auto" ? null : Number(eyeHeight),
      });
    }
    console.log(JSON.stringify(
      await sendMessage(webxr, "SETVRCDEPTHOPTIONS", {
        latencyMs: numberFlag("--latency") ?? undefined,
        debugMesh: mesh == null ? undefined : mesh === "on",
        scan: Deno.args.find((arg) => arg.startsWith("--scan="))?.slice(7),
        voxelMeters: numberFlag("--voxel") ?? undefined,
        headCamera: headCamera == null ? undefined : headCamera === "on",
        occlusion: occlusion == null ? undefined : occlusion === "on",
        headsetDecode: headsetDecode == null ? undefined : headsetDecode === "on",
        headCameraOffset: numberFlag("--head-camera-offset") ?? undefined,
      }),
      null,
      2,
    ));
    return 0;
  }
  if (sub === "status") {
    console.log(JSON.stringify(await sendMessage(main, "VRCDEPTHSTATUS"), null, 2));
    return 0;
  }
  console.error(`${LOG_PREFIX} vrcdepth: unknown subcommand "${sub}"`);
  return 2;
}

async function cmdVrc(): Promise<number> {
  const health = await requireServer();
  const vrcPeers = health.actors?.vrcPeers;
  const webxr = health.actors?.webxr;
  const positional = Deno.args.filter((a) => !a.startsWith("-"));
  const sub = positional[1] ?? "status";
  if (sub === "test-prompt") {
    const displayName = positional[2] ?? "TestFriend";
    const mismatch = hasFlag("--mismatch");
    if (vrcPeers) {
      console.log(
        JSON.stringify(
          await sendMessage(vrcPeers, "SIMULATEPEER", { displayName, mismatch }),
          null,
          2,
        ),
      );
      return 0;
    }
    if (!webxr) throw new Error("server has neither vrcPeers nor webxr actor");
    console.log(
      JSON.stringify(
        await sendMessage(webxr, "VRCTOFUTESTPROMPT", { displayName, mismatch }),
        null,
        2,
      ),
    );
    return 0;
  }
  if (sub === "clear-test") {
    if (vrcPeers) {
      console.log(JSON.stringify(await sendMessage(vrcPeers, "CLEARSIMULATED"), null, 2));
      return 0;
    }
    if (!webxr) throw new Error("server has neither vrcPeers nor webxr actor");
    console.log(
      JSON.stringify(await sendMessage(webxr, "VRCTOFUTESTPROMPT", { clear: true }), null, 2),
    );
    return 0;
  }
  if (!vrcPeers) throw new Error("server has no vrcPeers actor (reboot server to load it)");
  if (sub === "status") {
    console.log(JSON.stringify(await sendMessage(vrcPeers, "STATUS"), null, 2));
    return 0;
  }
  if (sub === "peers") {
    console.log(JSON.stringify(await sendMessage(vrcPeers, "LISTPEERS"), null, 2));
    return 0;
  }
  if (sub === "trusted") {
    console.log(JSON.stringify(await sendMessage(vrcPeers, "LISTTRUSTED"), null, 2));
    return 0;
  }
  if (sub === "trust") {
    const target = positional[2];
    if (!target) {
      console.error(`${LOG_PREFIX} vrc trust requires <usr_...|displayName>`);
      return 2;
    }
    const payload = target.startsWith("usr_")
      ? { userId: target, force: hasFlag("--force") }
      : { displayName: target, force: hasFlag("--force") };
    console.log(JSON.stringify(await sendMessage(vrcPeers, "TRUST", payload), null, 2));
    return 0;
  }
  if (sub === "untrust") {
    const userId = positional[2];
    if (!userId) {
      console.error(`${LOG_PREFIX} vrc untrust requires <usr_...>`);
      return 2;
    }
    console.log(JSON.stringify(await sendMessage(vrcPeers, "UNTRUST", { userId }), null, 2));
    return 0;
  }
  console.error(`${LOG_PREFIX} vrc: unknown subcommand "${sub}"`);
  return 2;
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
    case "camera":
      return await cmdCamera();
    case "vrcdepth":
      return await cmdVrcDepth();
    case "vrc":
      return await cmdVrc();
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
