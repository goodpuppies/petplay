import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { wait } from "../classes/utils.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import { ActorId } from "../submodules/stageforge/src/lib/types.ts";
import { multiplyMatrix } from "../classes/matrixutils.ts";
import { MainStdinHandler } from "../classes/mainStdinHandler.ts";

const state = actorState({
  name: "main",
  ivroverlay: null as null | string,
  origin: null as null | ActorId,
  overlays: [] as string[],
  inputstate: null as actionData | null,
});

const WEBXR_RENDER_HEIGHT = 500;
const WEBXR_RENDER_WIDTH = WEBXR_RENDER_HEIGHT * 2;
const WEBXR_OVERLAY_MODE = "both"  as const;

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

  const ivr = await PostMan.create("./OpenVR.ts", import.meta.url);
  const ivrsystem = await PostMan.PostMessage({
    target: ivr,
    type: "GETOPENVRPTR",
    payload: null,
  }, true);
  const ivroverlay = await PostMan.PostMessage({
    target: ivr,
    type: "GETOVERLAYPTR",
    payload: null,
  }, true);
  const ivrinput = await PostMan.PostMessage({
    target: ivr,
    type: "GETINPUTPTR",
    payload: null,
  }, true);
  state.ivroverlay = ivroverlay as string;

  const hmd = await PostMan.create("./hmd.ts", import.meta.url);
  const input = await PostMan.create("./controllers.ts", import.meta.url);
  const origin = await PostMan.create("./VRCOrigin.ts", import.meta.url);
  state.origin = origin;
  const laser = await PostMan.create("./laser.ts", import.meta.url);
  //const osc = await PostMan.create("./OSC.ts", import.meta.url);
  const webxr = await PostMan.create("./webxr.ts", import.meta.url);

  PostMan.PostMessage({
    target: input,
    type: "INITINPUT",
    payload: [ivrinput, ivroverlay],
  });
  PostMan.PostMessage({
    target: [hmd],
    type: "INITOPENVR",
    payload: ivrsystem,
  });

  PostMan.PostMessage({
    target: [origin, laser],
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
      overlayPointer: ivroverlay as number,
      vrSystemPointer: ivrsystem as number,
      controllerActor: input,
      overlayKey: "petplay.webxr.overlay",
      overlayName: "PetPlay WebXR Overlay",
      overlayWidthInMeters: 3,
      overlayDistance: 1,
      overlayRenderMode: WEBXR_OVERLAY_MODE,
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
  PostMan.PostMessage({
    target: laser,
    type: "ASSIGNINPUT",
    payload: input,
  });
  PostMan.PostMessage({
    target: origin,
    type: "STARTORIGIN",
    payload: {
      name: "originoverlay",
      texture: "./resources/PetPlay.png",
    },
  });
  PostMan.PostMessage({
    target: laser,
    type: "STARTLASERS",
    payload: null,
  });

  const endTime = performance.now();
  const timeElapsed = Math.round(endTime - startTime);
  LogChannel.log("default", `scene created in ${timeElapsed} ms`);

  inputloop(input);
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
      if (inputstate[2].bState == 1) {
        PostMan.PostMessage({
          target: state.overlays,
          type: "SETOVERLAYLOCATION",
          payload: inputstate[0].pose.mDeviceToAbsoluteTracking,
        });
      } else if (inputstate[3].bState == 1) {
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
