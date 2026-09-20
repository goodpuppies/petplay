import "./denoBrowserPolyfills.ts";
import React from "react";
import { useFrame, useThree } from "@react-three/fiber/webgpu";
import * as THREE from "three/webgpu";
import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { childProcessArgs } from "../classes/childModule.ts";
import { NativeHudPanel } from "../classes/environment/nativeFrontend.tsx";
import { WebXRScene } from "../classes/environment/scene.tsx";
import { VREnvironmentPlaceholder } from "../classes/environment/vrEnvironmentPlaceholder.tsx";
import { getAgentReplBaseUrl } from "../classes/utils.ts";
import {
  getScreenCaptureStatus,
  requestScreenCapture,
} from "../classes/environment/screenCapture.ts";
import {
  OrbitHandlesView,
  type RaylibR3FViewerSceneProps,
  runRaylibR3FViewerApp,
  SceneCameraAim,
} from "./raylibR3FViewerApp.tsx";

type StartDesktopControlPayload = {
  wristMenuActor?: string | null;
  displayOverlayHostActor?: string | null;
  webxrTarget?: string | null;
};

const DEFAULT_WIDTH = 1500;
const DEFAULT_HEIGHT = 950;
const DEFAULT_TITLE = "PetPlay Desktop Control";
const LOG = "[desktopControl]";
const AIM_ORIGIN: [number, number, number] = [0, 1.2, -1.45];
const CAMERA_POSITION: [number, number, number] = [0, 1.45, 1.15];
function envNumber(name: string, fallback: number): number {
  const parsed = Number(Deno.env.get(name));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Head-locked placement for the wrist HUD in desktop mode. Pulled in close and
 * squared up so the panel can be read and iterated on while designing; the XR
 * path keeps its own wrist-relative transform in `wristMenu/logic.tsx`.
 *
 * Tunable without a rebuild via PETPLAY_WRIST_HUD_{DISTANCE,SCALE,X,Y}, since a
 * restart costs far more than the tweak being tried.
 */
const WRIST_HUD_TRANSFORM = {
  position: [
    envNumber("PETPLAY_WRIST_HUD_X", 0),
    envNumber("PETPLAY_WRIST_HUD_Y", -0.04),
    -Math.abs(envNumber("PETPLAY_WRIST_HUD_DISTANCE", 0.35)),
  ] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
  scale: (() => {
    const s = envNumber("PETPLAY_WRIST_HUD_SCALE", 0.5);
    return [s, s, s] as [number, number, number];
  })(),
};

const CHILD_ARG = "--desktop-control-child";
const IS_CHILD = Deno.args.includes(CHILD_ARG);
let childShutdownSignalReceived = false;

const state = actorState({
  name: "desktop_control",
  running: false,
  stopRequested: false,
  lastError: null as string | null,
  wristMenuActor: null as string | null,
  displayOverlayHostActor: null as string | null,
  webxrTarget: null as string | null,
  runPromise: null as Promise<void> | null,
  child: null as Deno.ChildProcess | null,
  childStatus: null as Promise<Deno.CommandStatus> | null,
});

if (!IS_CHILD) {
  new PostMan(
    state,
    {
      __INIT__: (_payload: void) => {},
      __SHUTDOWN__: async (_payload: unknown) => {
        await stopDesktopControl();
      },
      __HEALTH__: (_payload: unknown) => getDesktopControlStatus(),
      STARTDESKTOPCONTROL: (payload: StartDesktopControlPayload | null) => {
        startDesktopControl(payload ?? {});
        return getDesktopControlStatus();
      },
      STOPDESKTOPCONTROL: async (_payload: void) => {
        await stopDesktopControl();
        return getDesktopControlStatus();
      },
    } as const,
  );
}

function DesktopControlScene(
  { controlsStore, logPrefix }: RaylibR3FViewerSceneProps,
) {
  return (
    <>
      <SceneCameraAim controlsStore={controlsStore} logPrefix={logPrefix} />
      <React.Suspense fallback={null}>
        <OrbitHandlesView controlsStore={controlsStore} logPrefix={logPrefix} />
      </React.Suspense>
      <DesktopViewOffsetBridge controlsStore={controlsStore} logPrefix={logPrefix} />
      <VREnvironmentPlaceholder />
      <WebXRScene XROrigin={() => null} displayOverlayHostActor={state.displayOverlayHostActor} />
      <DesktopWristMenuHud actorId={state.wristMenuActor} />
    </>
  );
}

function DesktopWristMenuHud({ actorId }: { actorId: string | null }) {
  const groupRef = React.useRef<THREE.Group>(null);
  const camera = useThree((r3fState) => r3fState.camera);

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;
    camera.updateWorldMatrix(true, false);
    camera.getWorldPosition(group.position);
    camera.getWorldQuaternion(group.quaternion);
    group.updateMatrixWorld(true);
  });

  return (
    <group ref={groupRef}>
      <NativeHudPanel
        actorId={actorId}
        transform={WRIST_HUD_TRANSFORM}
      />
    </group>
  );
}

function startDesktopControl(payload: StartDesktopControlPayload): void {
  state.wristMenuActor = payload.wristMenuActor ?? state.wristMenuActor;
  state.displayOverlayHostActor = payload.displayOverlayHostActor ?? null;
  state.webxrTarget = payload.webxrTarget ?? state.webxrTarget ?? "webxr";
  if (!IS_CHILD) {
    startDesktopControlChild();
    return;
  }
  if (state.runPromise) {
    return;
  }
  state.stopRequested = false;
  state.lastError = null;
  state.running = true;
  state.runPromise = runRaylibR3FViewerApp({
    defaultTitle: DEFAULT_TITLE,
    logPrefix: LOG,
    defaultWidth: DEFAULT_WIDTH,
    defaultHeight: DEFAULT_HEIGHT,
    aim: {
      aimOrigin: AIM_ORIGIN,
      cameraPosition: CAMERA_POSITION,
      fov: 58,
    },
    renderExtractionId: "desktop-control-surface",
    Scene: DesktopControlScene,
    logDependencyVersions: true,
    shouldClose: () => state.stopRequested,
  }).catch((error) => {
    state.lastError = error instanceof Error ? error.message : String(error);
    console.error(`${LOG} viewer failed`, error);
  }).finally(() => {
    state.running = false;
    state.stopRequested = false;
    state.runPromise = null;
  });
}

function startDesktopControlChild(): void {
  if (state.child) {
    return;
  }
  state.stopRequested = false;
  state.lastError = null;
  state.running = true;
  const command = new Deno.Command(Deno.execPath(), {
    args: childProcessArgs(new URL("./desktopControlSurface.tsx", import.meta.url), [
      CHILD_ARG,
      `--title=${DEFAULT_TITLE}`,
      `--webxr-target=${state.webxrTarget ?? "webxr"}`,
      `--wrist-menu-actor=${state.wristMenuActor ?? ""}`,
      `--display-overlay-host-actor=${state.displayOverlayHostActor ?? ""}`,
    ]),
    cwd: Deno.cwd(),
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  });
  state.child = command.spawn();
  state.childStatus = state.child.status;
  void state.childStatus.then((status) => {
    state.running = false;
    state.child = null;
    state.childStatus = null;
    if (!status.success && !state.stopRequested) {
      state.lastError = `desktop control child exited with code ${status.code}`;
    }
    state.stopRequested = false;
  }).catch((error) => {
    state.running = false;
    state.child = null;
    state.childStatus = null;
    state.lastError = error instanceof Error ? error.message : String(error);
    state.stopRequested = false;
  });
}

async function stopDesktopControl(): Promise<void> {
  state.stopRequested = true;
  if (!IS_CHILD) {
    const child = state.child;
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Process may already be gone.
      }
    }
    await state.childStatus?.catch(() => {});
    state.child = null;
    state.childStatus = null;
    state.running = false;
    state.stopRequested = false;
    return;
  }
  await state.runPromise;
}

function getDesktopControlStatus() {
  return {
    running: state.running,
    stopRequested: state.stopRequested,
    lastError: state.lastError,
    wristMenuActor: state.wristMenuActor,
    displayOverlayHostActor: state.displayOverlayHostActor,
    webxrTarget: state.webxrTarget,
    childPid: state.child?.pid ?? null,
  };
}

/**
 * Capture endpoint. Lives in the child because that is the process owning the
 * Raylib window; the agent REPL runs in the parent and cannot see the
 * framebuffer. Kept to a single verb so there is no chance of it mutating
 * render state:
 *
 *   POST /capture {"path": "/abs/out.png"}  -> writes a PNG of the next frame
 *   GET  /capture                            -> last capture path / error
 */
function startCaptureServer(): void {
  const port = envNumber("PETPLAY_CAPTURE_PORT", 3988);
  try {
    Deno.serve({ hostname: "127.0.0.1", port, onListen: () => {} }, async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== "/capture") {
        return Response.json({ ok: false, error: "Not found" }, { status: 404 });
      }
      if (req.method === "GET") {
        return Response.json({ ok: true, ...getScreenCaptureStatus() });
      }
      if (req.method !== "POST") {
        return Response.json({ ok: false, error: "Use GET or POST" }, { status: 405 });
      }
      try {
        const body = await req.json().catch(() => ({})) as { path?: string };
        const path = body.path ?? `${Deno.cwd()}/capture.png`;
        // Resolves only once the render loop has written the file.
        const written = await requestScreenCapture(path);
        return Response.json({ ok: true, path: written });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    });
    console.log(`${LOG} capture endpoint on http://127.0.0.1:${port}/capture`);
  } catch (error) {
    console.warn(`${LOG} capture endpoint unavailable:`, error);
  }
}

// A checkout spawns this module directly, so `import.meta.main` holds there; a compiled build
// dispatches it into this process instead, where it does not. `IS_CHILD` alone decides which
// process this is — only the spawned child is ever handed the argument.
if (IS_CHILD) {
  startCaptureServer();
  startDesktopControl({
    webxrTarget: getStringArg("webxr-target", "webxr"),
    wristMenuActor: getStringArg("wrist-menu-actor", "") || null,
    displayOverlayHostActor: getStringArg("display-overlay-host-actor", "") || null,
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(signal, () => {
        childShutdownSignalReceived = true;
        state.stopRequested = true;
      });
    } catch {
      // Ignore unsupported signal hooks.
    }
  }
  while (state.runPromise) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (state.lastError) {
    Deno.exit(1);
  }
  if (!childShutdownSignalReceived) {
    // The user closed the Raylib window. Ask the root PetPlay process to run
    // its normal cooperative actor teardown instead of leaving it headless.
    const parentPid = Deno.ppid;
    if (parentPid > 1) {
      try {
        console.log(`${LOG} window closed; requesting PetPlay shutdown`);
        Deno.kill(parentPid, "SIGINT");
      } catch (error) {
        console.warn(`${LOG} could not request parent shutdown`, error);
      }
    }
  }
}

function DesktopViewOffsetBridge(
  { controlsStore, logPrefix }: RaylibR3FViewerSceneProps,
) {
  React.useEffect(() => {
    let lastSentAt = 0;
    let lastSent: [number, number, number] | null = null;
    let pending: [number, number, number] | null = null;
    let flushTimer: number | null = null;

    const readOffset = (): [number, number, number] => {
      const origin = controlsStore.getState().origin;
      return [
        origin[0] - AIM_ORIGIN[0],
        origin[1] - AIM_ORIGIN[1],
        origin[2] - AIM_ORIGIN[2],
      ];
    };

    const shouldSend = (offset: [number, number, number]) =>
      lastSent == null ||
      Math.abs(offset[0] - lastSent[0]) > 0.001 ||
      Math.abs(offset[1] - lastSent[1]) > 0.001 ||
      Math.abs(offset[2] - lastSent[2]) > 0.001;

    const flush = () => {
      flushTimer = null;
      const offset = pending;
      pending = null;
      if (!offset || !shouldSend(offset)) {
        return;
      }
      lastSent = offset;
      lastSentAt = performance.now();
      void postDesktopViewOffset(offset).catch((error) => {
        console.warn(`${logPrefix} failed to sync desktop view offset`, error);
      });
    };

    const queueFlush = () => {
      pending = readOffset();
      if (!shouldSend(pending)) {
        return;
      }
      const now = performance.now();
      const delay = Math.max(0, 33 - (now - lastSentAt));
      if (flushTimer == null) {
        flushTimer = setTimeout(flush, delay);
      }
    };

    queueFlush();
    const unsubscribe = controlsStore.subscribe(queueFlush);
    return () => {
      unsubscribe();
      if (flushTimer != null) {
        clearTimeout(flushTimer);
      }
    };
  }, [controlsStore, logPrefix]);

  return null;
}

async function postDesktopViewOffset(offset: [number, number, number]): Promise<void> {
  const target = state.webxrTarget ?? "webxr";
  if (!target) {
    return;
  }
  await fetch(`${getAgentReplBaseUrl()}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      target,
      type: "SETDESKTOPVIEWOFFSET",
      payload: { enabled: true, offset },
    }),
  });
}

function getStringArg(name: string, fallback: string): string {
  return Deno.args.find((arg) => arg.startsWith(`--${name}=`))?.split("=", 2)[1] ?? fallback;
}
