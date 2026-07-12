import "./denoBrowserPolyfills.ts";
import React from "react";
import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { NativeHudPanel } from "../classes/environment/nativeFrontend.tsx";
import { WebXRScene } from "../classes/environment/scene.tsx";
import {
  OrbitHandlesView,
  type RaylibR3FViewerSceneProps,
  runRaylibR3FViewerApp,
  SceneCameraAim,
} from "./raylibR3FViewerApp.tsx";

type StartDesktopControlPayload = {
  wristMenuActor?: string | null;
  displayInstanceActor?: string | null;
  webxrTarget?: string | null;
};

const DEFAULT_WIDTH = 1500;
const DEFAULT_HEIGHT = 950;
const DEFAULT_TITLE = "PetPlay Desktop Control";
const LOG = "[desktopControl]";
const AIM_ORIGIN: [number, number, number] = [0, 1.2, -1.45];
const CAMERA_POSITION: [number, number, number] = [0, 1.45, 1.15];
const CHILD_ARG = "--desktop-control-child";
const IS_CHILD = Deno.args.includes(CHILD_ARG);

const state = actorState({
  name: "desktop_control",
  running: false,
  stopRequested: false,
  lastError: null as string | null,
  wristMenuActor: null as string | null,
  displayInstanceActor: null as string | null,
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
      <WebXRScene XROrigin={() => null} displayInstanceActor={state.displayInstanceActor} />
      <NativeHudPanel
        actorId={state.wristMenuActor}
        transform={{
          position: [0.82, 1.34, -1.35],
          rotation: [0, -0.35, 0],
          scale: [0.72, 0.72, 0.72],
        }}
      />
    </>
  );
}

function startDesktopControl(payload: StartDesktopControlPayload): void {
  state.wristMenuActor = payload.wristMenuActor ?? state.wristMenuActor;
  state.displayInstanceActor = payload.displayInstanceActor ?? null;
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
    args: [
      "run",
      "-A",
      "--unstable-webgpu",
      "--env-file",
      "petplay/desktopControlSurface.tsx",
      CHILD_ARG,
      `--title=${DEFAULT_TITLE}`,
      `--webxr-target=${state.webxrTarget ?? "webxr"}`,
    ],
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
    displayInstanceActor: state.displayInstanceActor,
    webxrTarget: state.webxrTarget,
    childPid: state.child?.pid ?? null,
  };
}

if (import.meta.main && IS_CHILD) {
  startDesktopControl({ webxrTarget: getStringArg("webxr-target", "webxr") });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(signal, () => {
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
  await fetch("http://127.0.0.1:3987/message", {
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
