import { actorState, PostMan, System } from "../submodules/stageforge/mod.ts";
import { wait } from "../classes/utils.ts";
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
const OPENVR_STARTUP_TIMEOUT_MS = 15_000;
type OpenVrActor = {
  GETCOMPOSITORPTR: () => Promise<bigint | null>;
};
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

function getScreenCaptureFps(): number {
  const raw = Deno.args
    .find((a) => a.startsWith("--screen-capture-fps="))
    ?.split("=", 2)[1];
  const value = raw == null ? 10 : Number(raw);
  return Number.isFinite(value) ? Math.max(1, Math.min(60, value)) : 10;
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
  } as const,
);

async function withStartupTimeout<T>(label: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${OPENVR_STARTUP_TIMEOUT_MS}ms`)),
      OPENVR_STARTUP_TIMEOUT_MS,
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

async function main() {
  const startTime = performance.now();
  console.log(`[petplay boot] main actor started (novr=${getNoOpenVrEnabled()})`);
  LogChannel.log("default", "creating scene");
  if (getNoOpenVrEnabled()) {
    await createNoOpenVrScene();
  } else {
    await createOpenVrScene();
  }
  const endTime = performance.now();
  const timeElapsed = Math.round(endTime - startTime);
  LogChannel.log("default", `scene created in ${timeElapsed} ms`);
}

async function createOpenVrScene() {
  console.log("[petplay boot] creating OpenVR actor");
  const ivr = await withStartupTimeout(
    "Creating the OpenVR actor",
    PostMan.create<typeof openVrApi>("./OpenVR.ts", import.meta.url),
  );
  const ivrActorId = resolveActorId(ivr);
  try {
    console.log("[petplay boot] OpenVR actor created; requesting IVRSystem");
    const ivrsystem = await withStartupTimeout("Waiting for IVRSystem", ivr.GETOPENVRPTR());
    console.log("[petplay boot] IVRSystem ready; requesting IVROverlay");
    const ivroverlay = await withStartupTimeout("Waiting for IVROverlay", ivr.GETOVERLAYPTR());
    console.log("[petplay boot] IVROverlay ready; requesting IVRInput");
    const ivrinput = await withStartupTimeout("Waiting for IVRInput", ivr.GETINPUTPTR());
    await continueOpenVrScene(ivr, ivrsystem, ivroverlay, ivrinput);
  } catch (error) {
    console.error(`[petplay boot] OpenVR startup failed; terminating ${ivrActorId}.`, error);
    PostMan.PostMessage({ target: System, type: "MURDER", payload: ivrActorId });
    throw error;
  }
}

async function continueOpenVrScene(
  ivr: OpenVrActor,
  ivrsystem: bigint,
  ivroverlay: bigint,
  ivrinput: bigint,
) {
  console.log("[petplay boot] IVRInput ready; creating dependent actors");
  state.ivroverlay = ivroverlay;

  console.log("[petplay boot] creating HMD actor");
  const hmd = await PostMan.create("./hmd.ts", import.meta.url);
  console.log("[petplay boot] creating VRC origin actor");
  const origin = await PostMan.create("./VRCOrigin.ts", import.meta.url);
  console.log("[petplay boot] creating VRC camera origin actor");
  const cameraOrigin = await PostMan.create("./VRCOriginCamera.ts", import.meta.url);
  state.origin = origin;
  //const laser = await PostMan.create("./laser.ts", import.meta.url);
  //const osc = await PostMan.create("./OSC.ts", import.meta.url);
  console.log("[petplay boot] creating wrist-menu actor");
  const wristMenu = await PostMan.create("./wristMenu.ts", import.meta.url);
  console.log("[petplay boot] creating display-instance actor");
  const displayInstance = await PostMan.create("./displayInstance.ts", import.meta.url);
  console.log("[petplay boot] creating WebXR actor");
  const webxr = await PostMan.create("./webxr.ts", import.meta.url);
  console.log("[petplay boot] creating Agent REPL actor");
  const agentRepl = await PostMan.create("./agentRepl.ts", import.meta.url);
  console.log("[petplay boot] core actors created");
  const desktopControlEnabled = getDesktopControlEnabled();
  const desktopControl = desktopControlEnabled
    ? await PostMan.create("./desktopControlSurface.tsx", import.meta.url)
    : null;
  const actorRegistry = {
    main: state.id,
    openvr: resolveActorId(ivr),
    hmd: resolveActorId(hmd),
    origin: resolveActorId(origin),
    cameraOrigin: resolveActorId(cameraOrigin),
    wristMenu: resolveActorId(wristMenu),
    displayInstance: resolveActorId(displayInstance),
    webxr: resolveActorId(webxr),
    agentRepl: resolveActorId(agentRepl),
    ...(desktopControl ? { desktopControl: resolveActorId(desktopControl) } : {}),
  };
  LogChannel.log("actorroute", {
    event: "main-actor-registry",
    actorRegistry,
  });

  PostMan.PostMessage({
    target: [hmd],
    type: "INITOPENVR",
    payload: ivrsystem,
  });
  const hmdDisplayFrequencyHz = await PostMan.PostMessage({
    target: hmd,
    type: "GETHMDDISPLAYFREQUENCY",
    payload: null,
  }, true) as number | null;

  const compositorPtr = await ivr.GETCOMPOSITORPTR();

  PostMan.PostMessage({
    target: [origin, displayInstance],
    type: "INITOVROVERLAY",
    payload: ivroverlay,
  });
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
      overlayPointer: ivroverlay,
      vrSystemPointer: ivrsystem,
      controllerActor: null,
      wristMenuActor: wristMenu,
      displayInstanceActor: displayInstance,
      overlayKey: "petplay.webxr.overlay",
      overlayName: "PetPlay WebXR Overlay",
      overlayWidthInMeters: 3,
      overlayDistance: 1,
      overlayRenderMode: WEBXR_OVERLAY_MODE,
      nativeRaylibDebug: getNativeRaylibOpenVrDebugEnabled(),
      nativeRaylibDebugWithHost: getNativeRaylibOpenVrDebugWithHostEnabled(),
      disableHostOpenVrInput: getDisableHostOpenVrInputEnabled(),
      raylibBypassRaythree: getRaylibBypassRaythreeEnabled(),
      raylibOpenVrPacedRaythree: getRaylibOpenVrPacedRaythreeEnabled(),
      desktopViewControlEnabled: desktopControlEnabled,
      hmdDisplayFrequencyHz,
      vrCompositorPointer: compositorPtr,
      /** Sample IVRInput on the webxr XR rAF (after compositor pacing) instead of a ~1kHz SAB writer. */
      vrInputPointer: ivrinput as number | bigint,
    },
  });
  const desktopOverlayConfig = {
    overlayKey: "petplay.displayInstance.desktop",
    displayName: "PetPlay display",
    runScreenCapture: true,
    captureFrameLimit: 0,
    captureFps: getScreenCaptureFps(),
    initialWidthMeters: (16 / 9) * 0.5,
    enableMouseInput: true,
  };
  PostMan.PostMessage({
    target: displayInstance,
    type: "CONFIGUREDESKTOP",
    payload: desktopOverlayConfig,
  });
  if (Deno.args.includes("--dev-start-desktop-overlay")) {
    PostMan.PostMessage({
      target: displayInstance,
      type: "STARTDESKTOP",
      payload: desktopOverlayConfig,
    });
  }
  PostMan.PostMessage({
    target: wristMenu,
    type: "SETDESKTOPOVERLAYACTOR",
    payload: resolveActorId(displayInstance),
  });

  /* PostMan.PostMessage({
    target: origin,
    type: "ASSIGNVRC",
    payload: osc,
  }); */
  PostMan.PostMessage({
    target: origin,
    type: "ASSIGNHMD",
    payload: hmd,
  });
  PostMan.PostMessage({
    target: origin,
    type: "ASSIGNVRC",
    payload: actorRegistry.cameraOrigin,
  });
  PostMan.PostMessage({
    target: origin,
    type: "ADDOVERLAY",
    payload: actorRegistry.webxr,
  });
  PostMan.PostMessage({
    target: cameraOrigin,
    type: "ASSIGNWEBXR",
    payload: webxr,
  });
  PostMan.PostMessage({
    target: actorRegistry.agentRepl,
    type: "REGISTER_ACTORS",
    payload: actorRegistry,
  });
  if (desktopControl && "desktopControl" in actorRegistry) {
    PostMan.PostMessage({
      target: resolveActorId(desktopControl),
      type: "STARTDESKTOPCONTROL",
      payload: {
        wristMenuActor: actorRegistry.wristMenu,
        displayInstanceActor: null,
        webxrTarget: "webxr",
      },
    });
  }
  /* PostMan.PostMessage({
    target: laser,
    type: "ASSIGNINPUT",
    payload: input,
  }); */
  // Temporarily disable VRC origin updates into the WebXR scene. The
  // scene will fall back to identity until the raythree-based path
  // replaces the current ad-hoc ghost renderer/origin plumbing.
  PostMan.PostMessage({
    target: origin,
    type: "STARTORIGIN",
    payload: {
      name: "originoverlay",
      texture: "./resources/PetPlay.png",
    },
  });
  PostMan.PostMessage({
    target: cameraOrigin,
    type: "STARTCAMERAORIGIN",
    payload: null,
  });
  /* PostMan.PostMessage({
    target: laser,
    type: "STARTLASERS",
    payload: null,
  }); */

  // inputloop is intentionally not started while WebXR owns IVRInput sampling.
}

async function createNoOpenVrScene() {
  LogChannel.log("default", "OpenVR actors disabled (--novr)");

  const wristMenu = await PostMan.create("./wristMenu.ts", import.meta.url);
  const webxr = await PostMan.create("./webxr.ts", import.meta.url);
  const desktopControlEnabled = getDesktopControlEnabled();
  const cameraOrigin = desktopControlEnabled
    ? await PostMan.create("./VRCOriginCamera.ts", import.meta.url)
    : null;
  const agentRepl = desktopControlEnabled
    ? await PostMan.create("./agentRepl.ts", import.meta.url)
    : null;
  const desktopControl = desktopControlEnabled
    ? await PostMan.create("./desktopControlSurface.tsx", import.meta.url)
    : null;

  const actorRegistry = {
    main: state.id,
    wristMenu: resolveActorId(wristMenu),
    webxr: resolveActorId(webxr),
    ...(cameraOrigin ? { cameraOrigin: resolveActorId(cameraOrigin) } : {}),
    ...(agentRepl ? { agentRepl: resolveActorId(agentRepl) } : {}),
    ...(desktopControl ? { desktopControl: resolveActorId(desktopControl) } : {}),
  };
  LogChannel.log("actorroute", {
    event: "main-actor-registry",
    actorRegistry,
  });

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
      displayInstanceActor: null,
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

  if (agentRepl) {
    PostMan.PostMessage({
      target: agentRepl,
      type: "REGISTER_ACTORS",
      payload: actorRegistry,
    });
  }

  if (desktopControl) {
    PostMan.PostMessage({
      target: desktopControl,
      type: "STARTDESKTOPCONTROL",
      payload: {
        wristMenuActor: actorRegistry.wristMenu,
        displayInstanceActor: null,
        webxrTarget: "webxr",
      },
    });
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
