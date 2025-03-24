import { PostMan } from "../submodules/stageforge/mod.ts";
import { wait } from "../classes/utils.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { CustomLogger } from "../classes/customlogger.ts";

//main process

const state = {
  name: "main",
};

new PostMan(state, {
  MAIN: (_payload: string) => {
    main();
  },
  STDIN: (payload: string) => {
    CustomLogger.log("actor", "stdin:", payload);
  },
} as const);

async function main() {
  CustomLogger.log("default", "main actor started");

  const ivr = await PostMan.create("./OpenVR.ts")
  const ivrsystem = await PostMan.PostMessage({
    target: ivr,
    type: "GETOPENVRPTR",
    payload: null
  }, true)
  const ivroverlay = await PostMan.PostMessage({
    target: ivr,
    type: "GETOVERLAYPTR",
    payload: null
  }, true)

  const hmd = await PostMan.create("./hmd.ts");
  const input = await PostMan.create("./controllers.ts");
  const origin = await PostMan.create("./VRCOrigin.ts");
  const overlay = await PostMan.create("./dogoverlay.ts");
  const laser = await PostMan.create("./laser.ts");
  const osc = await PostMan.create("./OSC.ts");

  PostMan.PostMessage({
    target: hmd,
    type: "INITOPENVR",
    payload: ivrsystem
  })
  PostMan.PostMessage({
    target: [origin, overlay, laser],
    type: "INITOVROVERLAY",
    payload: ivroverlay
  })

  PostMan.PostMessage({
    target: origin,
    type: "ASSIGNVRC",
    payload: osc,
  });
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
      texture: "../resources/P1.png",
    },
  });
  //this is delay dependent pls fix
  await wait(500)
  PostMan.PostMessage({
    target: overlay,
    type: "ASSIGNVRCORIGIN",
    payload: origin,
  });

  PostMan.PostMessage({
    target: laser,
    type: "STARTLASERS",
    payload: null
  });
  PostMan.PostMessage({
    target: overlay,
    type: "STARTOVERLAY",
    payload: {
      name: "pet1",
      texture: "../resources/P1.png",
      sync: true,
    },
  });

  inputloop(input, overlay);
}

async function inputloop(inputactor: string, overlayactor: string) {
  CustomLogger.log("default", "inputloop started");
  while (true) {

    const inputstate = await PostMan.PostMessage({
      target: inputactor,
      type: "GETCONTROLLERDATA",
      payload: null,
    }, true) as [
        OpenVR.InputPoseActionData,
        OpenVR.InputPoseActionData,
        OpenVR.InputDigitalActionData,
        OpenVR.InputDigitalActionData,
      ];

    if (inputstate[2].bState == 1) {
      PostMan.PostMessage({
        target: overlayactor,
        type: "SETOVERLAYLOCATION",
        payload: inputstate[0].pose.mDeviceToAbsoluteTracking,
      });
    } else if (inputstate[3].bState == 1) {
      PostMan.PostMessage({
        target: overlayactor,
        type: "SETOVERLAYLOCATION",
        payload: inputstate[1].pose.mDeviceToAbsoluteTracking,
      });
    }

    await wait(10);
  }
}
