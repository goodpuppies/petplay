/**
 * Decoupled desktop view: a raylib **window** that renders the `webxr` scene's IR.
 *
 * The scene, its update loop and its XR session live in the `webxr` worker. This
 * actor owns nothing but a window: it receives `WebXRRaythreeRenderPayload`
 * (`WEBXRVIEWFRAME`), rasterizes it with `WebXRRaythreeRaylibRenderer` straight
 * into its own framebuffer, and re-draws the latest payload at its own rate. So a
 * VR session and a desktop window can show the same scene at the same time, at
 * independent render rates, with exactly one scene update between them.
 *
 * Unlike the interactive desktop control surface (`desktopControlSurface.tsx`,
 * which mounts a second `WebXRScene`), this view holds no React tree, no spatial
 * graph and no pointer handles: it is a pure IR consumer. It is a **preview** and
 * takes no viewpoint input — moving the shared viewpoint from here would shift
 * the rendered XR view while the OpenVR overlays (placed in absolute tracking
 * space) stayed put, desyncing the two coordinate frames.
 *
 * `STARTDESKTOPVIEW { capturePath, hidden, width, height }` renders it headless:
 * wait for the first IR frame, draw it, write one PNG through the same screen
 * capture path and close. That is how `client capture` takes a screenshot with no
 * preview window left running.
 *
 * Runs as a child OS process (`{ worker: "process" }`) so the window's GL context
 * and event loop stay out of the host process, matching `displayOverlayHost`.
 */
import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import raylib from "../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import { getRaylibLibraryPath } from "../classes/nativeLibraryPaths.ts";
import { WebXRRaythreeRaylibRenderer } from "../classes/webxrRaythreeRaylibRenderer.ts";
import type { WebXRRaythreeRenderPayload } from "../classes/webxrRaythreeScene.ts";
import {
  getScreenCaptureStatus,
  requestScreenCapture,
  runPendingScreenCapture,
} from "../classes/environment/screenCapture.ts";
import { wait } from "../classes/utils.ts";

export type StartDesktopViewPayload = {
  /** `webxr` actor id to register with (frames + camera offset). */
  webxrTarget?: string | null;
  width?: number;
  height?: number;
  /** Target frames per second; 0 = uncapped (raylib `SetTargetFPS`). */
  fps?: number;
  /** Draw an IR/payload diagnostics line into the window. */
  diagnostics?: boolean;
  title?: string;
  /** One-shot: write this PNG once a frame has been drawn, then close the window. */
  capturePath?: string | null;
  /** Create the window hidden — used by the one-shot capture path. */
  hidden?: boolean;
};

/** Stable renderer context id: asset sync is incremental per id. */
const RENDER_CONTEXT_ID = "desktop-decoupled-view";
/** A payload is acked once it has been rendered; a busy view gets a fresh frame. */
const LOOP_SLEEP_MS = 1;
/** One-shot captures wait this long for a payload carrying geometry before giving up on it. */
const CAPTURE_FALLBACK_MS = 5_000;
/** Silence this long after receiving frames means the scene's view registry was rebuilt. */
const VIEW_REREGISTER_AFTER_MS = 5_000;

const state = actorState({
  name: "desktop_view",
  running: false,
  stopRequested: false,
  lastError: null as string | null,
  webxrTarget: null as string | null,
  registered: false,
  width: 1280,
  height: 720,
  fps: 120,
  title: "PetPlay Desktop View",
  /** Payloads received from the scene / rendered in the window / acked back. */
  framesReceived: 0,
  framesRendered: 0,
  framesAcked: 0,
  /** Payloads that arrived while one was still in flight renderer-side. */
  lastRenderMs: 0,
  lastWindowFps: 0,
  /** One-shot capture request (path), what it wrote, and whether the window is hidden. */
  capturePath: null as string | null,
  captureWritten: null as string | null,
  hidden: false,
  /** What the last received IR frame actually carried; the view's own diagnostics. */
  lastPayload: null as {
    instances: number;
    geometries: number;
    materials: number;
    textures: number;
    lights: number;
    panels: number;
    texts: number;
    frameCount: number;
  } | null,
  /** Cumulative asset batches the view has received (priming + deltas). */
  assetsSeen: { geometries: 0, materials: 0, textures: 0 },
  /** Draw the IR/payload diagnostics line into the window. */
  diagnostics: false,
  loop: null as Promise<void> | null,
});

/** Latest IR to draw; replaced as frames arrive, never queued. */
let latestPayload: WebXRRaythreeRenderPayload | null = null;
let latestSeq = 0;
let renderedSeq = 0;
let lastFrameAt = 0;

new PostMan(
  state,
  {
    __INIT__: (_payload: void) => {},
    __SHUTDOWN__: async (_payload: unknown) => {
      await stopDesktopView();
    },
    __HEALTH__: (_payload: unknown) => getDesktopViewStatus(),
    STARTDESKTOPVIEW: (payload: StartDesktopViewPayload | null) => {
      startDesktopView(payload ?? {});
      return getDesktopViewStatus();
    },
    STOPDESKTOPVIEW: async (_payload: void) => {
      await stopDesktopView();
      return getDesktopViewStatus();
    },
    /** One frame of scene IR from the `webxr` actor. */
    WEBXRVIEWFRAME: (payload: WebXRRaythreeRenderPayload) => {
      latestPayload = payload;
      latestSeq += 1;
      state.framesReceived += 1;
      lastFrameAt = performance.now();
      state.lastPayload = {
        instances: payload.leftEye.frame.instances.length,
        geometries: payload.leftEye.assets.geometries.length,
        materials: payload.leftEye.assets.materials.length,
        textures: payload.leftEye.assets.textures.length,
        lights: payload.leftEye.frame.lights.length,
        panels: payload.ui?.panels?.length ?? 0,
        texts: payload.ui?.texts?.length ?? 0,
        frameCount: payload.frame.frameCount,
      };
      state.assetsSeen.geometries += payload.leftEye.assets.geometries.length;
      state.assetsSeen.materials += payload.leftEye.assets.materials.length;
      state.assetsSeen.textures += payload.leftEye.assets.textures.length;
    },
    REQUESTCAPTURE: async (payload: { path?: string } | null) => {
      if (!state.running) {
        return { ok: false, error: "desktop view is not running" };
      }
      try {
        const path = await requestScreenCapture(payload?.path ?? `${Deno.cwd()}/desktop-view.png`);
        return { ok: true, path };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
    GETCAPTURESTATUS: (_payload: void) => getScreenCaptureStatus(),
  } as const,
);

globalThis.addEventListener("unload", () => {
  state.stopRequested = true;
});

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getDesktopViewStatus() {
  return {
    running: state.running,
    stopRequested: state.stopRequested,
    lastError: state.lastError,
    webxrTarget: state.webxrTarget,
    registered: state.registered,
    width: state.width,
    height: state.height,
    fpsTarget: state.fps,
    windowFps: state.lastWindowFps,
    framesReceived: state.framesReceived,
    framesRendered: state.framesRendered,
    framesAcked: state.framesAcked,
    payloadHeld: latestPayload != null,
    renderLagFrames: Math.max(0, latestSeq - renderedSeq),
    lastRenderMs: Number(state.lastRenderMs.toFixed(3)),
    lastPayload: state.lastPayload,
    assetsSeen: { ...state.assetsSeen },
    capturePath: state.capturePath,
    captureWritten: state.captureWritten,
    hidden: state.hidden,
    loopRunning: state.loop != null,
  };
}

function startDesktopView(payload: StartDesktopViewPayload): void {
  state.webxrTarget = payload.webxrTarget ?? state.webxrTarget;
  state.width = positiveInt(payload.width, state.width);
  state.height = positiveInt(payload.height, state.height);
  state.fps = payload.fps == null || payload.fps < 0 ? state.fps : Math.round(payload.fps);
  state.diagnostics = payload.diagnostics ?? state.diagnostics;
  state.title = payload.title ?? state.title;
  // Per-run directive, not sticky state: a later plain start must not capture
  // again and close itself.
  state.capturePath = payload.capturePath ?? null;
  state.captureWritten = null;
  state.hidden = payload.hidden ?? state.hidden;
  if (state.loop != null) {
    return;
  }
  state.stopRequested = false;
  state.lastError = null;
  state.framesReceived = 0;
  state.framesRendered = 0;
  state.framesAcked = 0;
  latestPayload = null;
  latestSeq = 0;
  renderedSeq = 0;
  state.loop = runDesktopViewWindow()
    .catch((error) => {
      state.lastError = messageOf(error);
      LogChannel.error("actor", `[desktopView] window loop failed: ${state.lastError}`);
    })
    .finally(() => {
      state.loop = null;
      state.running = false;
    });
}

async function stopDesktopView(): Promise<void> {
  state.stopRequested = true;
  // The loop closes the window itself; only a window that ignores the flag
  // (blocked in a raylib call) needs the forced path.
  await Promise.race([state.loop ?? Promise.resolve(), wait(2_000)]);
  unregisterWithWebXr();
}

function positiveInt(value: number | undefined, fallback: number): number {
  return value != null && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function registerWithWebXr(): void {
  const target = state.webxrTarget;
  if (target == null) {
    LogChannel.log("actor", "[desktopView] no webxr target; rendering nothing until one is set");
    return;
  }
  PostMan.PostMessage({
    target,
    type: "REGISTERWEBXRVIEW",
    // No `cameraControl`: this is a preview. View control moves the rendered XR
    // pose, which desyncs it from the OpenVR overlays placed in absolute space.
    payload: { actorId: state.id, label: "desktop" },
  });
  state.registered = true;
  LogChannel.log("actor", `[desktopView] registered with ${target} as ${state.id}`);
}

function unregisterWithWebXr(): void {
  const target = state.webxrTarget;
  if (target == null || !state.registered) {
    return;
  }
  state.registered = false;
  PostMan.PostMessage({
    target,
    type: "UNREGISTERWEBXRVIEW",
    payload: { actorId: state.id },
  });
}

async function runDesktopViewWindow(): Promise<void> {
  const width = state.width;
  const height = state.height;
  raylib.loadRaylib(getRaylibLibraryPath());
  let windowUp = false;
  let renderer: WebXRRaythreeRaylibRenderer | null = null;
  let captureRequested = false;
  try {
    if (state.hidden) {
      raylib.SetConfigFlags(raylib.ConfigFlags.FLAG_WINDOW_HIDDEN);
    }
    raylib.H.InitWindow(width, height, state.title);
    windowUp = true;
    raylib.SetTargetFPS(state.fps);
    renderer = new WebXRRaythreeRaylibRenderer();
    state.running = true;
    LogChannel.log(
      "actor",
      `[desktopView] window ${width}x${height} fps=${state.fps} hidden=${state.hidden} - IR consumer, no local scene`,
    );
    registerWithWebXr();

    let fpsMarkAt = performance.now();
    const windowStartedAt = fpsMarkAt;
    while (!raylib.WindowShouldClose() && !state.stopRequested) {
      drawLatestFrame(renderer);
      // After EndDrawing: the frame is complete and no draw is in flight, which
      // is the only point where reading the framebuffer is safe.
      runPendingScreenCapture();
      // One-shot capture. The first payloads a view receives can still be
      // priming frames with no geometry, so wait for one that carries content;
      // a scene that is legitimately empty still gets captured on the fallback
      // rather than hanging the caller.
      const payload = state.lastPayload;
      const hasGeometry = payload != null &&
        (payload.instances > 0 || payload.panels > 0 || payload.texts > 0);
      const captureReady = latestPayload != null &&
        (hasGeometry || performance.now() - windowStartedAt > CAPTURE_FALLBACK_MS);
      if (state.capturePath != null && !captureRequested && captureReady) {
        captureRequested = true;
        if (!hasGeometry) {
          LogChannel.log("actor", "[desktopView] capture fallback: no payload carried geometry");
        }
        requestScreenCapture(state.capturePath)
          .then((written) => {
            state.captureWritten = written;
            LogChannel.log("actor", `[desktopView] capture written ${written}`);
          })
          .catch((error) => {
            state.lastError = messageOf(error);
            LogChannel.error("actor", `[desktopView] capture failed: ${state.lastError}`);
          })
          .finally(() => {
            state.stopRequested = true;
          });
      }
      const now = performance.now();
      if (now - fpsMarkAt >= 500) {
        state.lastWindowFps = raylib.GetFPS();
        fpsMarkAt = now;
      }
      // A `/reload` of the webxr actor rebuilds its view registry; a view that
      // was receiving frames and stopped is the cheap signal to register again.
      if (
        state.registered && state.framesReceived > 0 && lastFrameAt > 0 &&
        now - lastFrameAt > VIEW_REREGISTER_AFTER_MS
      ) {
        state.registered = false;
        registerWithWebXr();
        lastFrameAt = now;
      }
      await wait(LOOP_SLEEP_MS);
    }
  } finally {
    unregisterWithWebXr();
    renderer?.dispose();
    if (windowUp) {
      raylib.H.CloseWindow();
      raylib.unloadRaylib();
    }
    state.running = false;
  }
}

/**
 * Draws the latest payload into the window framebuffer. Re-drawing an unchanged
 * payload keeps the window presenting at its own rate; the scene still advances
 * only as fast as the `webxr` actor extracts it.
 */
function drawLatestFrame(renderer: WebXRRaythreeRaylibRenderer): void {
  raylib.BeginDrawing();
  try {
    const payload = latestPayload;
    if (payload == null) {
      raylib.H.ClearBackground({ r: 12, g: 14, b: 18, a: 255 });
      return;
    }
    const renderStartedAt = performance.now();
    renderer.renderExtraction(
      payload.leftEye,
      payload.background,
      {
        projectionMatrix: payload.frame.leftEyeProjectionMatrix,
        viewMatrix: payload.frame.leftEyeViewMatrix,
      },
      RENDER_CONTEXT_ID,
      payload.ui,
    );
    state.lastRenderMs = performance.now() - renderStartedAt;
    state.framesRendered += 1;
    if (renderedSeq !== latestSeq) {
      renderedSeq = latestSeq;
    }
    // Window-side diagnostics: drawn every frame so a capture proves both the
    // framebuffer path and what the IR carried.
    raylib.DrawFPS(16, 16);
    if (state.diagnostics) {
      raylib.H.DrawText(
        `ir=${state.framesReceived} rendered=${state.framesRendered} inst=${
          state.lastPayload?.instances ?? 0
        } assets=${state.assetsSeen.geometries}/${state.assetsSeen.materials}/${state.assetsSeen.textures} ui=${
          state.lastPayload?.panels ?? 0
        }/${state.lastPayload?.texts ?? 0}`,
        16,
        44,
        20,
        { r: 255, g: 214, b: 120, a: 255 },
      );
    }
  } finally {
    raylib.EndDrawing();
  }
  // Ack outside the drawing scope: the scene may ship the next frame as soon as
  // this arrives, and it must not race the framebuffer.
  if (renderedSeq !== state.framesAcked && state.registered && state.webxrTarget != null) {
    state.framesAcked = renderedSeq;
    PostMan.PostMessage({
      target: state.webxrTarget,
      type: "WEBXRVIEWFRAMEACK",
      payload: { actorId: state.id, seq: renderedSeq },
    });
  }
}
