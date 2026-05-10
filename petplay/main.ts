import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { wait } from "../classes/utils.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import type { ActorId } from "../submodules/stageforge/src/lib/types.ts";
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
    return false;
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
      main();
    },
    STDIN: (payload: string) => {
      stdinHandler.handle(payload);
    },
  } as const,
);

async function main() {
  const startTime = performance.now();
  LogChannel.log("default", "creating scene");

  const ivr = await PostMan.create<typeof openVrApi>("./OpenVR.ts", import.meta.url);
  const ivrsystem = await ivr.GETOPENVRPTR();
  const ivroverlay = await ivr.GETOVERLAYPTR();
  const ivrinput = await ivr.GETINPUTPTR();
  state.ivroverlay = ivroverlay;

  const hmd = await PostMan.create("./hmd.ts", import.meta.url);
  const origin = await PostMan.create("./VRCOrigin.ts", import.meta.url);
  state.origin = origin;
  //const laser = await PostMan.create("./laser.ts", import.meta.url);
  //const osc = await PostMan.create("./OSC.ts", import.meta.url);
  const wristMenu = await PostMan.create("./wristMenu.ts", import.meta.url);
  const displayInstance = await PostMan.create("./displayInstance.ts", import.meta.url);
  const webxr = await PostMan.create("./webxr.ts", import.meta.url);

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
      hmdDisplayFrequencyHz,
      vrCompositorPointer: compositorPtr,
      /** Sample IVRInput on the webxr XR rAF (after compositor pacing) instead of a ~1kHz SAB writer. */
      vrInputPointer: ivrinput as number | bigint,
    },
  });
  PostMan.PostMessage({
    target: displayInstance,
    type: "STARTDESKTOP",
    payload: {
      overlayKey: "petplay.displayInstance.desktop",
      displayName: "PetPlay display",
      runScreenCapture: true,
      captureFrameLimit: 0,
      initialWidthMeters: (16 / 9) * 0.5,
      enableMouseInput: true,
    },
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
  /* PostMan.PostMessage({
    target: laser,
    type: "STARTLASERS",
    payload: null,
  }); */

  const endTime = performance.now();
  const timeElapsed = Math.round(endTime - startTime);
  LogChannel.log("default", `scene created in ${timeElapsed} ms`);

  // inputloop is intentionally not started while WebXR owns IVRInput sampling.
}

async function spawnOverlay(name: string): Promise<ActorId> {
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
