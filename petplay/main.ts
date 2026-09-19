import { actorState, PostMan, System } from "../submodules/stageforge/mod.ts";
import { wait } from "../classes/utils.ts";
import { clampCaptureFps } from "../classes/ScreenCapturer/scclass.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import { type ActorId, resolveActorId } from "../submodules/stageforge/src/lib/types.ts";
import { multiplyMatrix } from "../classes/matrixutils.ts";
import { MainStdinHandler } from "../classes/mainStdinHandler.ts";
import { OverlayRenderMode } from "./webxr.ts";
import type { api as openVrApi } from "./OpenVR.ts";

const state = actorState({
  name: "main",
  ivroverlay: null as null | bigint,
  origin: null as null | ActorId,
  overlays: [] as string[],
  inputstate: null as actionData | null,
});

const WEBXR_RENDER_HEIGHT = 40;
const WEBXR_RENDER_WIDTH = WEBXR_RENDER_HEIGHT * 2;
/** Raylib ghost only: `WebXRHost` skips WebGPU XR scene draws. Use `"both"` to compare to the live layer. */
const WEBXR_OVERLAY_MODE = "raylib" as OverlayRenderMode;

function isEnabledArg(name: string): boolean {
  const raw = Deno.args.find((a) => a === name || a.startsWith(`${name}=`));
  if (raw == null) {
    return false;
  }
  const v = raw.split("=", 2)[1]?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

function getNoOpenVrEnabled(): boolean {
  return isEnabledArg("--novr");
}

function getDesktopControlEnabled(): boolean {
  return Deno.args.includes("--desktop");
}

/**
 * Spawns the agent REPL actor in every launch mode, so a dev/tooling run can be driven over HTTP
 * without also starting the desktop-control window (`--desktop` implies it as before).
 * See `utils/overlay-perf.ts`.
 */
function getAgentReplEnabled(): boolean {
  return Deno.args.includes("--agent-repl");
}

function getScreenCaptureFps(): number {
  const raw = Deno.args
    .find((a) => a.startsWith("--screen-capture-fps="))
    ?.split("=", 2)[1];
  return clampCaptureFps(raw == null ? undefined : Number(raw));
}

function getNativeRaylibOpenVrDebugEnabled(): boolean {
  const raw = Deno.args.find((a) => a.startsWith("--webxr-native-raylib-debug"));
  if (raw == null) {
    return false;
  }
  const v = raw.split("=", 2)[1]?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

function getNativeRaylibOpenVrDebugWithHostEnabled(): boolean {
  const raw = Deno.args.find((a) => a.startsWith("--webxr-native-raylib-debug-with-host"));
  if (raw == null) {
    return false;
  }
  const v = raw.split("=", 2)[1]?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

function getDisableHostOpenVrInputEnabled(): boolean {
  const raw = Deno.args.find((a) => a.startsWith("--webxr-disable-host-openvr-input"));
  if (raw == null) {
    return false;
  }
  const v = raw.split("=", 2)[1]?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

function getRaylibBypassRaythreeEnabled(): boolean {
  const raw = Deno.args.find((a) => a.startsWith("--webxr-raylib-bypass-raythree"));
  if (raw == null) {
    return false;
  }
  const v = raw.split("=", 2)[1]?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

function getRaylibOpenVrPacedRaythreeEnabled(): boolean {
  const raw = Deno.args.find((a) => a.startsWith("--webxr-raylib-openvr-paced-raythree"));
  if (raw == null) {
    return WEBXR_OVERLAY_MODE === "raylib";
  }
  const v = raw.split("=", 2)[1]?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

const stdinHandler = new MainStdinHandler({
  spawnOverlay: (name) => {
    void spawnOverlay(name);
  },
  inspect: () => {
    console.log(state.addressBook);
  },
  logInput: (input) => {
    LogChannel.log("actor", "stdin:", input);
  },
});

new PostMan(
  state,
  {
    MAIN: (_payload: string) => {
      PostMan.setTopic("muffin");
      void main().catch((error) => {
        console.error("[petplay boot] startup failed:", error);
        throw error;
      });
    },
    STDIN: (payload: string) => {
      stdinHandler.handle(payload);
    },
    __SHUTDOWN__: (_payload: unknown) => {
      // Stop the supervision loop before dependants are torn down around it.
      supervisor.running = false;
    },
    /** Host teardown announces itself before it starts shutting actors down. */
    PREPARESHUTDOWN: async (_payload: unknown) => {
      supervisor.running = false;
      await Promise.race([supervisor.idle ?? Promise.resolve(), wait(3_000)]);
      return true;
    },
    /**
     * Ordered SteamVR detach on demand (REPL / tooling). `openvr.RELEASE` is not
     * safe to send directly while actors hold its interfaces — the supervisor
     * stops them first.
     */
    DETACHOPENVR: async (_payload: unknown) => {
      if (supervisedActors == null) {
        return getSupervisorHealth();
      }
      if (supervisor.attachment != null) {
        supervisor.requestDetach = true;
        return { requested: true, phase: supervisor.phase };
      }
      await callActor<OpenVrStatus>(supervisedActors.ivr, "RELEASE").catch((error) => {
        LogChannel.log("actor", `[supervisor] RELEASE failed: ${messageOf(error)}`);
      });
      return getSupervisorHealth();
    },
    __HEALTH__: (_payload: unknown) => {
      return getSupervisorHealth();
    },
    GETSUPERVISORSTATUS: (_payload: unknown) => {
      return getSupervisorHealth();
    },
    /** Desktop view actor: started by the client CLI, not by a client process. */
    STARTDESKTOPCONTROL: async (_payload: unknown) => {
      return await startDesktopView();
    },
    STOPDESKTOPCONTROL: async (_payload: unknown) => {
      return await stopDesktopView();
    },
    DESKTOPCONTROLSTATUS: async (_payload: unknown) => {
      return await getDesktopViewStatus();
    },
    /** Decoupled desktop view: renders this scene's IR in its own window process. */
    STARTDESKTOPVIEW: async (payload: DecoupledViewPayload | null) => {
      return await startDecoupledDesktopView(payload);
    },
    STOPDESKTOPVIEW: async (_payload: unknown) => {
      return await stopDecoupledDesktopView();
    },
    DESKTOPVIEWSTATUS: async (_payload: unknown) => {
      return await getDecoupledDesktopViewStatus();
    },
  } as const,
);

async function main() {
  const startTime = performance.now();
  console.log(`[petplay boot] main actor started (novr=${getNoOpenVrEnabled()})`);
  LogChannel.log("default", "creating scene");
  if (getNoOpenVrEnabled()) {
    await createNoOpenVrScene();
  } else {
    await createSupervisedScene();
  }
  const endTime = performance.now();
  const timeElapsed = Math.round(endTime - startTime);
  LogChannel.log("default", `scene created in ${timeElapsed} ms`);
}

/**
 * SteamVR-facing actors. They exist only while the runtime is attached, so
 * every one of them is created on attach and murdered on detach.
 */
type OpenVrAttachment = {
  hmd: ActorId;
  origin: ActorId;
  displayOverlayHost: ActorId;
  attachedAt: number;
  /** `webxr` uploaded frames at attach: distinguishes a stalled pump from a fresh one. */
  uploadedFramesAtAttach: number;
};

type SupervisedSceneActors = {
  ivr: ActorId;
  wristMenu: ActorId;
  cameraOrigin: ActorId;
  webxr: ActorId;
  agentRepl: ActorId;
  desktopControlEnabled: boolean;
};

type OpenVrPointers = {
  system: number | bigint;
  overlay: number | bigint;
  input: number | bigint;
  renderModels: number | bigint;
  compositor: number | bigint | null;
};

type OpenVrStatus = {
  ready: boolean;
  runtimeQuit: boolean;
  initError: string | null;
  initAttempts: number;
};

type WebXrOverlayStatus = {
  uploadedFrames?: number;
  raylib?: { expected?: boolean; overlayReady?: boolean; running?: boolean };
};

const OPENVR_DETACHED_POLL_MS = 3_000;
const OPENVR_ATTACHED_POLL_MS = 1_000;
const OPENVR_CALL_TIMEOUT_MS = 5_000;
const OPENVR_HEALTH_TIMEOUT_MS = 1_500;
/** Time after `STARTWEBXR` before a non-running overlay pump counts as a loss. */
const OPENVR_OVERLAY_GRACE_MS = 10_000;
/** How long a detach waits for dependants to stop touching the interfaces. */
const OPENVR_DETACH_SETTLE_MS = 5_000;

/**
 * Attachment state, mirrored into `__HEALTH__` so the agent REPL can see what
 * the supervisor is doing (and why it last detached) in a live session.
 */
const supervisor = {
  running: false,
  /** In-flight supervision pass, awaited by `PREPARESHUTDOWN`. */
  idle: null as Promise<void> | null,
  /** Set by `DETACHOPENVR`; the next pass performs the ordered detach. */
  requestDetach: false,
  phase: "off" as "off" | "detached" | "attached",
  attachment: null as OpenVrAttachment | null,
  openvr: null as OpenVrStatus | null,
  lastReason: null as string | null,
  lastTransitionAt: 0,
  attachCount: 0,
  detachCount: 0,
};

/** Set by [createSupervisedScene]; `--novr` never creates OpenVR actors. */
let supervisedActors: SupervisedSceneActors | null = null;

/**
 * Actor ids the client surface drives. `petplay/client.ts` (and the desktop
 * window's own REPL calls) resolve everything through these names, so the
 * desktop view can be started and stopped after boot like any other actor.
 */
const clientActors = {
  wristMenu: null as ActorId | null,
  webxr: null as ActorId | null,
  agentRepl: null as ActorId | null,
  cameraOrigin: null as ActorId | null,
  /** Started on demand by `STARTDESKTOPCONTROL` — the interactive desktop view actor. */
  desktopControl: null as ActorId | null,
  /** Started on demand by `STARTDESKTOPVIEW` — the decoupled IR-consumer view actor. */
  desktopView: null as ActorId | null,
};

function clientActorRegistry() {
  const attachment = supervisor.attachment;
  return {
    main: state.id,
    ...(clientActors.wristMenu ? { wristMenu: clientActors.wristMenu } : {}),
    ...(clientActors.webxr ? { webxr: clientActors.webxr } : {}),
    ...(clientActors.agentRepl ? { agentRepl: clientActors.agentRepl } : {}),
    ...(clientActors.cameraOrigin ? { cameraOrigin: clientActors.cameraOrigin } : {}),
    ...(clientActors.desktopControl ? { desktopControl: clientActors.desktopControl } : {}),
    ...(clientActors.desktopView ? { desktopView: clientActors.desktopView } : {}),
    ...(supervisedActors ? { openvr: supervisedActors.ivr } : {}),
    ...(attachment
      ? {
        hmd: attachment.hmd,
        origin: attachment.origin,
        displayOverlayHost: attachment.displayOverlayHost,
      }
      : {}),
  };
}

/** Publishes the name→id registry the agent REPL resolves actor names through. */
function registerClientActors(): void {
  const actorRegistry = clientActorRegistry();
  if (clientActors.agentRepl != null) {
    PostMan.PostMessage({
      target: clientActors.agentRepl,
      type: "REGISTER_ACTORS",
      payload: actorRegistry,
    });
  }
  LogChannel.log("actorroute", {
    event: "main-actor-registry",
    actorRegistry,
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Awaited actor message with a deadline and `{__actorError}` unwrapping. */
async function callActor<T>(
  target: ActorId,
  type: string,
  timeoutMs: number = OPENVR_CALL_TIMEOUT_MS,
): Promise<T> {
  const result = await withTimeout(
    PostMan.PostMessage({ target, type, payload: null }, true),
    timeoutMs,
    `${type} on ${target}`,
  );
  const actorError = (result as { __actorError?: { message?: string } } | null)
    ?.__actorError;
  if (actorError != null) {
    throw new Error(`${type} failed: ${actorError.message ?? "actor dispatch failed"}`);
  }
  return result as T;
}

async function actorIsResponsive(target: ActorId, timeoutMs: number): Promise<boolean> {
  try {
    await callActor(target, "HEALTH", timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function queryOpenVrStatus(ivr: ActorId): Promise<OpenVrStatus | null> {
  try {
    const health = await callActor<{ details?: OpenVrStatus }>(
      ivr,
      "HEALTH",
      OPENVR_HEALTH_TIMEOUT_MS,
    );
    return health?.details ?? null;
  } catch {
    return null;
  }
}

async function queryWebXrStatus(webxr: ActorId): Promise<WebXrOverlayStatus | null> {
  try {
    const health = await callActor<{ details?: WebXrOverlayStatus }>(
      webxr,
      "HEALTH",
      OPENVR_HEALTH_TIMEOUT_MS,
    );
    return health?.details ?? null;
  } catch {
    return null;
  }
}

function registerSceneActors(actors: SupervisedSceneActors): void {
  supervisedActors = actors;
  clientActors.wristMenu = actors.wristMenu;
  clientActors.webxr = actors.webxr;
  clientActors.agentRepl = actors.agentRepl;
  clientActors.cameraOrigin = actors.cameraOrigin;
  registerClientActors();
}

/** Starts (or restarts) the desktop view actor; its window opens on this machine. */
async function startDesktopView() {
  const existing = clientActors.desktopControl;
  if (existing != null && await actorIsResponsive(existing, OPENVR_HEALTH_TIMEOUT_MS)) {
    PostMan.PostMessage({
      target: existing,
      type: "STARTDESKTOPCONTROL",
      payload: desktopViewPayload(),
    });
    return await getDesktopViewStatus();
  }
  if (existing != null) {
    PostMan.PostMessage({ target: System, type: "MURDER", payload: existing });
    await waitForActorsStopped([existing]);
    clientActors.desktopControl = null;
  }
  const actor = await PostMan.create("./desktopControlSurface.tsx", import.meta.url);
  clientActors.desktopControl = resolveActorId(actor);
  PostMan.PostMessage({
    target: actor,
    type: "STARTDESKTOPCONTROL",
    payload: desktopViewPayload(),
  });
  registerClientActors();
  LogChannel.log("actor", `[desktop] view actor started ${clientActors.desktopControl}`);
  return await getDesktopViewStatus();
}

async function stopDesktopView() {
  const id = clientActors.desktopControl;
  if (id == null) {
    return await getDesktopViewStatus();
  }
  await callActor(id, "STOPDESKTOPCONTROL").catch((error) => {
    LogChannel.log("actor", `[desktop] STOPDESKTOPCONTROL: ${messageOf(error)}`);
  });
  PostMan.PostMessage({ target: System, type: "MURDER", payload: id });
  await waitForActorsStopped([id]);
  clientActors.desktopControl = null;
  registerClientActors();
  LogChannel.log("actor", "[desktop] view actor stopped");
  return await getDesktopViewStatus();
}

function desktopViewPayload() {
  return {
    wristMenuActor: clientActors.wristMenu,
    displayOverlayHostActor: supervisor.attachment?.displayOverlayHost ?? null,
    webxrTarget: "webxr",
  };
}

/**
 * Decoupled desktop view: a window process that renders this scene's IR instead
 * of mounting a second scene. Independent render rate; one scene update.
 */
async function startDecoupledDesktopView(capture: DecoupledViewPayload | null = null) {
  const existing = clientActors.desktopView;
  if (existing != null && await actorIsResponsive(existing, OPENVR_HEALTH_TIMEOUT_MS)) {
    PostMan.PostMessage({
      target: existing,
      type: "STARTDESKTOPVIEW",
      payload: decoupledDesktopViewPayload(capture),
    });
    return await getDecoupledDesktopViewStatus();
  }
  if (existing != null) {
    PostMan.PostMessage({ target: System, type: "MURDER", payload: existing });
    await waitForActorsStopped([existing]);
    clientActors.desktopView = null;
  }
  const actor = await PostMan.create("./desktopView.ts", import.meta.url, {
    worker: "process",
  });
  clientActors.desktopView = resolveActorId(actor);
  PostMan.PostMessage({
    target: actor,
    type: "STARTDESKTOPVIEW",
    payload: decoupledDesktopViewPayload(capture),
  });
  registerClientActors();
  LogChannel.log(
    "actor",
    `[desktop] decoupled view actor started ${clientActors.desktopView}`,
  );
  return await getDecoupledDesktopViewStatus();
}

async function stopDecoupledDesktopView() {
  const id = clientActors.desktopView;
  if (id == null) {
    return await getDecoupledDesktopViewStatus();
  }
  await callActor(id, "STOPDESKTOPVIEW").catch((error) => {
    LogChannel.log("actor", `[desktop] STOPDESKTOPVIEW: ${messageOf(error)}`);
  });
  PostMan.PostMessage({ target: System, type: "MURDER", payload: id });
  await waitForActorsStopped([id]);
  clientActors.desktopView = null;
  registerClientActors();
  LogChannel.log("actor", "[desktop] decoupled view actor stopped");
  return await getDecoupledDesktopViewStatus();
}

/** Client-requested extras for a decoupled view start (see `desktopView.ts`). */
type DecoupledViewPayload = {
  capturePath?: string | null;
  hidden?: boolean;
  width?: number;
  height?: number;
};

function decoupledDesktopViewPayload(capture: DecoupledViewPayload | null = null) {
  return {
    webxrTarget: clientActors.webxr,
    width: capture?.width ?? getNumberArg("--desktop-view-width", 1280),
    height: capture?.height ?? getNumberArg("--desktop-view-height", 720),
    fps: getNumberArg("--desktop-view-fps", 120),
    diagnostics: Deno.args.includes("--desktop-view-diagnostics"),
    title: Deno.args.find((arg) => arg.startsWith("--desktop-view-title="))
      ?.split("=", 2)[1] ?? "PetPlay Desktop View",
    capturePath: capture?.capturePath ?? null,
    hidden: capture?.hidden ?? false,
  };
}

async function getDecoupledDesktopViewStatus() {
  const id = clientActors.desktopView;
  if (id == null) {
    return { running: false, actorId: null, details: null };
  }
  try {
    const health = await callActor<{ details?: unknown }>(id, "HEALTH", OPENVR_HEALTH_TIMEOUT_MS);
    return { running: true, actorId: id, details: health?.details ?? null };
  } catch {
    return { running: false, actorId: id, details: null };
  }
}

/** Numeric CLI argument with a positive-integer guard. */
function getNumberArg(name: string, fallback: number): number {
  const raw = Deno.args.find((arg) => arg.startsWith(`${name}=`))?.split("=", 2)[1];
  const parsed = raw == null ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
}

async function getDesktopViewStatus() {
  const id = clientActors.desktopControl;
  if (id == null) {
    return { running: false, actorId: null, details: null };
  }
  try {
    const health = await callActor<{ details?: unknown }>(id, "HEALTH", OPENVR_HEALTH_TIMEOUT_MS);
    return { running: true, actorId: id, details: health?.details ?? null };
  } catch {
    return { running: false, actorId: id, details: null };
  }
}

function desktopOverlayConfig() {
  return {
    overlayKey: "petplay.displayOverlayHost.desktop",
    displayName: "PetPlay display",
    runScreenCapture: true,
    captureFrameLimit: 0,
    captureFps: getScreenCaptureFps(),
    initialWidthMeters: (16 / 9) * 0.5,
    enableMouseInput: true,
  };
}

/**
 * `STARTWEBXR` with or without an OpenVR runtime. The null-pointer payload is
 * the one `--novr` uses: emulated XR session, scene graph and desktop view keep
 * running, but nothing is presented to a headset.
 */
function startWebXr(
  actors: SupervisedSceneActors,
  pointers: OpenVrPointers | null,
  hmdDisplayFrequencyHz: number | null,
  displayOverlayHostActor: ActorId | null,
): void {
  const withRuntime = pointers != null;
  PostMan.PostMessage({
    target: actors.webxr,
    type: "STARTWEBXR",
    payload: {
      width: WEBXR_RENDER_WIDTH,
      height: WEBXR_RENDER_HEIGHT,
      title: "PetPlay WebXR",
      debugWindow: false,
      sessionMode: "immersive-ar",
      alpha: true,
      overlayPointer: pointers?.overlay ?? null,
      vrSystemPointer: pointers?.system ?? null,
      controllerActor: null,
      wristMenuActor: actors.wristMenu,
      displayOverlayHostActor,
      overlayKey: "petplay.webxr.overlay",
      overlayName: "PetPlay WebXR Overlay",
      overlayWidthInMeters: 3,
      overlayDistance: 1,
      overlayRenderMode: WEBXR_OVERLAY_MODE,
      nativeRaylibDebug: withRuntime && getNativeRaylibOpenVrDebugEnabled(),
      nativeRaylibDebugWithHost: withRuntime && getNativeRaylibOpenVrDebugWithHostEnabled(),
      // Without a runtime there is no host IVRInput to sample.
      disableHostOpenVrInput: !withRuntime || getDisableHostOpenVrInputEnabled(),
      raylibBypassRaythree: withRuntime && getRaylibBypassRaythreeEnabled(),
      raylibOpenVrPacedRaythree: withRuntime && getRaylibOpenVrPacedRaythreeEnabled(),
      desktopViewControlEnabled: actors.desktopControlEnabled,
      hmdDisplayFrequencyHz,
      vrCompositorPointer: pointers?.compositor ?? null,
      /** Sample IVRInput on the webxr XR rAF (after compositor pacing) instead of a ~1kHz SAB writer. */
      vrInputPointer: pointers?.input ?? null,
      vrRenderModelsPointer: pointers?.renderModels ?? null,
    },
  });
}

async function readOpenVrPointers(ivr: ActorId): Promise<OpenVrPointers> {
  const [system, overlay, input, renderModels, compositor] = await Promise.all([
    callActor<number | bigint>(ivr, "GETOPENVRPTR"),
    callActor<number | bigint>(ivr, "GETOVERLAYPTR"),
    callActor<number | bigint>(ivr, "GETINPUTPTR"),
    callActor<number | bigint>(ivr, "GETRENDERMODELSPTR"),
    callActor<number | bigint | null>(ivr, "GETCOMPOSITORPTR"),
  ]);
  if (system == null || overlay == null || input == null || renderModels == null) {
    throw new Error("OpenVR interfaces are not all available");
  }
  return { system, overlay, input, renderModels, compositor };
}

/**
 * OpenVR-capable boot under supervision.
 *
 * The control plane — wrist menu, VRC camera origin, WebXR scene, desktop view
 * and the agent REPL — comes up immediately and keeps running whether or not
 * SteamVR is there. The SteamVR-facing actors (HMD, VRC origin, display overlay
 * host) are created on attach and murdered on detach, in dependency order: the
 * client runtime must outlive every wrapper built from its interface pointers.
 */
async function createSupervisedScene() {
  console.log("[petplay boot] creating OpenVR actor");
  const ivr = await PostMan.create<typeof openVrApi>("./OpenVR.ts", import.meta.url);
  console.log("[petplay boot] creating control-plane actors");
  const wristMenu = await PostMan.create("./wristMenu.ts", import.meta.url);
  const cameraOrigin = await PostMan.create("./VRCOriginCamera.ts", import.meta.url);
  const webxr = await PostMan.create("./webxr.ts", import.meta.url);
  const agentRepl = await PostMan.create("./agentRepl.ts", import.meta.url);
  const desktopControlEnabled = getDesktopControlEnabled();
  const actors: SupervisedSceneActors = {
    ivr: resolveActorId(ivr),
    wristMenu: resolveActorId(wristMenu),
    cameraOrigin: resolveActorId(cameraOrigin),
    webxr: resolveActorId(webxr),
    agentRepl: resolveActorId(agentRepl),
    desktopControlEnabled,
  };
  console.log("[petplay boot] control-plane actors created");

  PostMan.PostMessage({
    target: cameraOrigin,
    type: "ASSIGNWEBXR",
    payload: webxr,
  });
  // Start the scene without OpenVR: the desktop view works with SteamVR closed,
  // and the supervisor re-starts the session with the runtime once it appears.
  startWebXr(actors, null, null, null);
  if (desktopControlEnabled) {
    PostMan.PostMessage({
      target: cameraOrigin,
      type: "STARTCAMERAORIGIN",
      payload: null,
    });
  }
  registerSceneActors(actors);
  if (desktopControlEnabled) {
    await startDesktopView();
  }

  supervisedActors = actors;
  supervisor.running = true;
  supervisor.idle = superviseOpenVrRuntime(actors).catch((error) => {
    LogChannel.error("actor", `[supervisor] stopped: ${messageOf(error)}`);
  });
}

/** Bootstrap order matters for teardown as well: SteamVR-facing actors are re-created on attach. */
async function attachOpenVrRuntime(actors: SupervisedSceneActors): Promise<void> {
  const pointers = await readOpenVrPointers(actors.ivr);
  LogChannel.log("actor", "[supervisor] SteamVR available; attaching OpenVR actors");
  const created: ActorId[] = [];
  try {
    // The control-plane session is running without OpenVR; restart it with the
    // runtime so the overlay, pacer and IVRInput sampling come up.
    await callActor(actors.webxr, "STOPWEBXR", OPENVR_CALL_TIMEOUT_MS * 2).catch((error) => {
      LogChannel.log("actor", `[supervisor] STOPWEBXR before attach: ${messageOf(error)}`);
    });
    const hmd = await PostMan.create("./hmd.ts", import.meta.url);
    created.push(resolveActorId(hmd));
    PostMan.PostMessage({
      target: hmd,
      type: "INITOPENVR",
      payload: pointers.system,
    });
    const hmdDisplayFrequencyHz = await callActor<number | null>(
      resolveActorId(hmd),
      "GETHMDDISPLAYFREQUENCY",
    ).catch(() => null);
    const origin = await PostMan.create("./VRCOrigin.ts", import.meta.url);
    created.push(resolveActorId(origin));
    PostMan.PostMessage({
      target: origin,
      type: "INITOVROVERLAY",
      payload: pointers.overlay,
    });
    const displayOverlayHost = await PostMan.create(
      "./displayOverlayHost.ts",
      import.meta.url,
      { worker: "process" },
    );
    created.push(resolveActorId(displayOverlayHost));

    const attachment: OpenVrAttachment = {
      hmd: resolveActorId(hmd),
      origin: resolveActorId(origin),
      displayOverlayHost: resolveActorId(displayOverlayHost),
      attachedAt: Date.now(),
      uploadedFramesAtAttach: (await queryWebXrStatus(actors.webxr))?.uploadedFrames ?? 0,
    };
    supervisor.attachment = attachment;
    supervisor.phase = "attached";
    supervisor.attachCount += 1;
    supervisor.lastReason = null;
    supervisor.lastTransitionAt = Date.now();
    state.origin = origin;
    state.ivroverlay = pointers.overlay as bigint;

    PostMan.PostMessage({
      target: displayOverlayHost,
      type: "CONFIGUREDESKTOP",
      payload: desktopOverlayConfig(),
    });
    if (Deno.args.includes("--dev-start-desktop-overlay")) {
      PostMan.PostMessage({
        target: displayOverlayHost,
        type: "STARTDESKTOP",
        payload: desktopOverlayConfig(),
      });
    }
    PostMan.PostMessage({
      target: actors.wristMenu,
      type: "SETDISPLAYOVERLAYHOSTACTOR",
      payload: attachment.displayOverlayHost,
    });
    startWebXr(actors, pointers, hmdDisplayFrequencyHz, attachment.displayOverlayHost);
    PostMan.PostMessage({ target: origin, type: "ASSIGNHMD", payload: hmd });
    PostMan.PostMessage({ target: origin, type: "ASSIGNVRC", payload: actors.cameraOrigin });
    PostMan.PostMessage({ target: origin, type: "ADDOVERLAY", payload: actors.webxr });
    PostMan.PostMessage({
      target: actors.cameraOrigin,
      type: "ASSIGNWEBXR",
      payload: actors.webxr,
    });
    // Temporarily disable VRC origin updates into the WebXR scene. The
    // scene will fall back to identity until the raythree-based path
    // replaces the current ad-hoc ghost renderer/origin plumbing.
    PostMan.PostMessage({
      target: origin,
      type: "STARTORIGIN",
      payload: { name: "originoverlay", texture: "./resources/PetPlay.png" },
    });
    PostMan.PostMessage({ target: actors.cameraOrigin, type: "STARTCAMERAORIGIN", payload: null });
    registerSceneActors(actors);
    LogChannel.log("actor", `[supervisor] OpenVR attached (attach #${supervisor.attachCount})`);
  } catch (error) {
    for (const id of created.reverse()) {
      PostMan.PostMessage({ target: System, type: "MURDER", payload: id });
    }
    supervisor.attachment = null;
    supervisor.phase = "detached";
    throw error;
  }
}

/** Waits until the murdered actors stop answering, so no wrapper outlives the runtime. */
async function waitForActorsStopped(ids: readonly ActorId[]): Promise<void> {
  const deadline = performance.now() + OPENVR_DETACH_SETTLE_MS;
  while (performance.now() < deadline) {
    const alive = await Promise.all(ids.map((id) => actorIsResponsive(id, 400)));
    if (!alive.some(Boolean)) return;
    await wait(150);
  }
  LogChannel.log(
    "actor",
    "[supervisor] dependants still answering after detach; releasing the runtime anyway",
  );
}

/**
 * SteamVR went away: stop using the interfaces in dependency order and release
 * the client runtime, then hand the scene back to the no-runtime payload so the
 * desktop view (and the spatial layout) survives.
 */
async function detachOpenVrRuntime(
  actors: SupervisedSceneActors,
  attachment: OpenVrAttachment,
  reason: string,
): Promise<void> {
  supervisor.phase = "detached";
  supervisor.lastReason = reason;
  supervisor.attachment = null;
  LogChannel.log("actor", `[supervisor] detaching OpenVR: ${reason}`);

  // 1. `webxr` drops its overlay, pacer and IVRInput wrappers first.
  await callActor(actors.webxr, "STOPWEBXR", OPENVR_CALL_TIMEOUT_MS * 2).catch((error) => {
    LogChannel.log("actor", `[supervisor] STOPWEBXR during detach: ${messageOf(error)}`);
  });
  // 2. Nobody points at the dying overlay host any more; the desktop view keeps
  //    rendering through a session without a runtime.
  PostMan.PostMessage({
    target: actors.wristMenu,
    type: "SETDISPLAYOVERLAYHOSTACTOR",
    payload: null,
  });
  startWebXr(actors, null, null, null);
  // 3. Dependants: their shutdown hooks destroy overlays while the runtime is
  //    still alive, which is the only safe order.
  for (const id of [attachment.displayOverlayHost, attachment.origin, attachment.hmd]) {
    PostMan.PostMessage({ target: System, type: "MURDER", payload: id });
  }
  await waitForActorsStopped([attachment.displayOverlayHost, attachment.origin, attachment.hmd]);
  // 4. Now the client runtime itself can go; `TRYINIT` will build a new one.
  await callActor(actors.ivr, "RELEASE").catch((error) => {
    LogChannel.log("actor", `[supervisor] RELEASE failed: ${messageOf(error)}`);
  });
  state.ivroverlay = null;
  state.origin = null;
  supervisor.detachCount += 1;
  supervisor.lastTransitionAt = Date.now();
  registerSceneActors(actors);
  LogChannel.log("actor", `[supervisor] OpenVR detached (detach #${supervisor.detachCount})`);
}

/** True once the runtime is unusable and the attachment has to come down. */
async function openVrLossReason(
  actors: SupervisedSceneActors,
  attachment: OpenVrAttachment,
): Promise<string | null> {
  const openvr = await queryOpenVrStatus(actors.ivr);
  supervisor.openvr = openvr;
  if (openvr == null) return "openvr actor unreachable";
  if (openvr.runtimeQuit) return "SteamVR asked the client to quit";
  if (!openvr.ready) return `runtime released (${openvr.initError ?? "not initialized"})`;
  const watched: Array<[string, ActorId]> = [
    ["hmd", attachment.hmd],
    ["origin", attachment.origin],
    ["display overlay host", attachment.displayOverlayHost],
  ];
  for (const [label, id] of watched) {
    if (!await actorIsResponsive(id, OPENVR_HEALTH_TIMEOUT_MS)) {
      return `${label} actor stopped`;
    }
  }
  // A hard SteamVR kill delivers no event; the stalled overlay pump is the
  // first thing that notices.
  if (Date.now() - attachment.attachedAt > OPENVR_OVERLAY_GRACE_MS) {
    const status = await queryWebXrStatus(actors.webxr);
    const raylib = status?.raylib;
    const uploaded = status?.uploadedFrames ?? 0;
    if (
      raylib?.expected === true && raylib.overlayReady === true &&
      raylib.running !== true && uploaded > attachment.uploadedFramesAtAttach
    ) {
      return "overlay pump stopped";
    }
  }
  return null;
}

async function superviseOpenVrRuntime(actors: SupervisedSceneActors): Promise<void> {
  supervisor.phase = "detached";
  supervisor.lastTransitionAt = Date.now();
  LogChannel.log(
    "actor",
    "[supervisor] watching for SteamVR; the desktop view stays available while it is away",
  );
  while (supervisor.running) {
    try {
      if (supervisor.attachment == null) {
        const status = await queryOpenVrStatus(actors.ivr);
        supervisor.openvr = status;
        if (status?.ready) {
          await attachOpenVrRuntime(actors);
        } else if (status != null) {
          supervisor.openvr = await callActor<OpenVrStatus>(actors.ivr, "TRYINIT");
        }
        await wait(OPENVR_DETACHED_POLL_MS);
        continue;
      }
      const requested = supervisor.requestDetach;
      supervisor.requestDetach = false;
      const reason = requested
        ? "operator request"
        : await openVrLossReason(actors, supervisor.attachment);
      if (reason != null) {
        await detachOpenVrRuntime(actors, supervisor.attachment, reason);
      }
      await wait(OPENVR_ATTACHED_POLL_MS);
    } catch (error) {
      supervisor.lastReason = messageOf(error);
      LogChannel.error("actor", `[supervisor] pass failed: ${supervisor.lastReason}`);
      await wait(OPENVR_DETACHED_POLL_MS);
    }
  }
}

function getSupervisorHealth() {
  return {
    running: supervisor.running,
    phase: supervisor.phase,
    attachCount: supervisor.attachCount,
    detachCount: supervisor.detachCount,
    lastReason: supervisor.lastReason,
    lastTransitionAt: supervisor.lastTransitionAt,
    openvr: supervisor.openvr,
    desktopViewActor: clientActors.desktopView,
    attachment: supervisor.attachment == null ? null : {
      hmd: supervisor.attachment.hmd,
      origin: supervisor.attachment.origin,
      displayOverlayHost: supervisor.attachment.displayOverlayHost,
      attachedAt: supervisor.attachment.attachedAt,
    },
  };
}


async function createNoOpenVrScene() {
  LogChannel.log("default", "OpenVR actors disabled (--novr)");

  const wristMenu = await PostMan.create("./wristMenu.ts", import.meta.url);
  const webxr = await PostMan.create("./webxr.ts", import.meta.url);
  const desktopControlEnabled = getDesktopControlEnabled();
  const cameraOrigin = desktopControlEnabled
    ? await PostMan.create("./VRCOriginCamera.ts", import.meta.url)
    : null;
  const agentRepl = desktopControlEnabled || getAgentReplEnabled()
    ? await PostMan.create("./agentRepl.ts", import.meta.url)
    : null;

  clientActors.wristMenu = resolveActorId(wristMenu);
  clientActors.webxr = resolveActorId(webxr);
  clientActors.agentRepl = agentRepl ? resolveActorId(agentRepl) : null;
  clientActors.cameraOrigin = cameraOrigin ? resolveActorId(cameraOrigin) : null;
  registerClientActors();

  PostMan.PostMessage({
    target: webxr,
    type: "STARTWEBXR",
    payload: {
      width: WEBXR_RENDER_WIDTH,
      height: WEBXR_RENDER_HEIGHT,
      title: "PetPlay WebXR",
      debugWindow: false,
      sessionMode: "immersive-ar",
      alpha: true,
      overlayPointer: null,
      vrSystemPointer: null,
      controllerActor: null,
      wristMenuActor: wristMenu,
      displayOverlayHostActor: null,
      overlayRenderMode: "raylib" as OverlayRenderMode,
      nativeRaylibDebug: false,
      nativeRaylibDebugWithHost: false,
      disableHostOpenVrInput: true,
      raylibBypassRaythree: false,
      raylibOpenVrPacedRaythree: false,
      desktopViewControlEnabled: desktopControlEnabled,
      hmdDisplayFrequencyHz: null,
      vrCompositorPointer: null,
      vrInputPointer: null,
      vrRenderModelsPointer: null,
    },
  });

  if (cameraOrigin) {
    PostMan.PostMessage({
      target: cameraOrigin,
      type: "ASSIGNWEBXR",
      payload: webxr,
    });
    PostMan.PostMessage({
      target: cameraOrigin,
      type: "STARTCAMERAORIGIN",
      payload: null,
    });
  }

  if (desktopControlEnabled) {
    await startDesktopView();
    LogChannel.log(
      "default",
      "Desktop mode active; screen capture/display overlay is disabled until a non-OpenVR presentation backend is available",
    );
  }
}

async function spawnOverlay(name: string): Promise<ActorId> {
  if (getNoOpenVrEnabled()) {
    throw new Error("Cannot spawn OpenVR overlay while --novr is enabled");
  }
  LogChannel.log("actor", `Attempting to spawn overlay with name: ${name}`);
  const overlay = await PostMan.create("./genericoverlay.ts", import.meta.url);
  PostMan.PostMessage({
    target: overlay,
    type: "INITOVROVERLAY",
    payload: state.ivroverlay,
  });

  PostMan.PostMessage({
    target: overlay,
    type: "STARTOVERLAY",
    payload: {
      name: name,
      texture: "./resources/P1.png",
      sync: false,
    },
  });

  PostMan.PostMessage({
    target: state.origin!,
    type: "ADDOVERLAY",
    payload: overlay,
  });

  PostMan.PostMessage({
    target: overlay,
    type: "SETOVERLAYLOCATION",
    payload: state.inputstate![0].pose.mDeviceToAbsoluteTracking,
  });

  //state.overlays.push(overlay);
  return overlay;
}

async function inputloop(inputactor: string) {
  while (true) {
    const inputstate = await PostMan.PostMessage({
      target: inputactor,
      type: "GETCONTROLLERDATA",
      payload: null,
    }, true) as actionData;
    state.inputstate = inputstate;

    if (state.overlays.length > 0) {
      if (inputstate[2].bState) {
        PostMan.PostMessage({
          target: state.overlays,
          type: "SETOVERLAYLOCATION",
          payload: inputstate[0].pose.mDeviceToAbsoluteTracking,
        });
      } else if (inputstate[3].bState) {
        PostMan.PostMessage({
          target: state.overlays,
          type: "SETOVERLAYLOCATION",
          payload: inputstate[1].pose.mDeviceToAbsoluteTracking,
        });
      }

      await wait(10);
    }

    //#region JANK
    const transformer: OpenVR.HmdMatrix34 = {
      m: [
        [1.0000000, 0.0000000, 0.0000000, 0.01],
        [0.0000000, 0.7071068, 0.7071068, -0.05],
        [0.0000000, -0.7071068, 0.7071068, 0.01],
      ],
    };

    const controller1: OpenVR.HmdMatrix34 = {
      m: [
        [...inputstate[0].pose.mDeviceToAbsoluteTracking.m[0]],
        [...inputstate[0].pose.mDeviceToAbsoluteTracking.m[1]],
        [...inputstate[0].pose.mDeviceToAbsoluteTracking.m[2]],
      ],
    };
    const controller2: OpenVR.HmdMatrix34 = {
      m: [
        [...inputstate[1].pose.mDeviceToAbsoluteTracking.m[0]],
        [...inputstate[1].pose.mDeviceToAbsoluteTracking.m[1]],
        [...inputstate[1].pose.mDeviceToAbsoluteTracking.m[2]],
      ],
    };

    const controller1mod = multiplyMatrix(controller1, transformer);
    const controller2mod = multiplyMatrix(controller2, transformer);

    inputstate[0].pose.mDeviceToAbsoluteTracking = controller1mod;
    inputstate[1].pose.mDeviceToAbsoluteTracking = controller2mod;
    //#endregion

    await wait(10);
  }
}

type actionData = [
  OpenVR.InputPoseActionData,
  OpenVR.InputPoseActionData,
  OpenVR.InputDigitalActionData,
  OpenVR.InputDigitalActionData,
];
