import { ToAddress } from "../stageforge/src/lib/types.ts";
import { PostMan } from "../stageforge/mod.ts";
import { wait } from "../classes/utils.ts";
import { OpenVRType } from "../OpenVR_TS_Bindings_Deno/utils.ts";
import * as OpenVR from "../OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { CustomLogger } from "../classes/customlogger.ts";

//main process

const state = {
  name: "main",
  id: "",
  db: {},
  socket: null,
  numbah: 0,
  addressBook: new Set()
};


new PostMan(state.name, {
  MAIN: (_payload: string) => {
    //PostMan.setTopic("muffin")
    main();
  },
  LOG: (_payload: null) => {
    CustomLogger.log("actor", state.id);
  },
  STDIN: (payload: string) => {
    CustomLogger.log("actor", "stdin:", payload);
  },
} as const);

async function main() {
  CustomLogger.log("default", "main actor started");

  const ivr = await PostMan.create("./actors/OpenVR.ts")
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


  //const overlayactor = await PostMan.create("overlayactor.ts");



  const hmd = await PostMan.create("./actors/hmd.ts");
  const inputactor = await PostMan.create("./actors/controllers.ts");

  const overlayactorVRC = await PostMan.create("./actors/VRCOverlay.ts");

  const vrcorigin = await PostMan.create("./actors/VRCOrigin.ts");

  const laser = await PostMan.create("./actors/laser.ts");


  await wait(2000)

  PostMan.PostMessage({
    target: hmd,
    type: "INITOPENVR",
    payload: ivrsystem
  })

  PostMan.PostMessage({
    target: [overlayactorVRC, vrcorigin, laser],
    type: "INITOPENVR",
    payload: ivroverlay
  })


  const vrc = await PostMan.create("./actors/VRCOSC.ts");


  PostMan.PostMessage({
    target: vrcorigin,
    type: "ASSIGNVRC",
    payload: vrc,
  });

  PostMan.PostMessage({
    target: vrcorigin,
    type: "ASSIGNHMD",
    payload: hmd,
  });

  PostMan.PostMessage({
    target: laser,
    type: "SETINPUTACTOR",
    payload: inputactor,
  });
  PostMan.PostMessage({
    target: inputactor,
    type: "SETLASER",
    payload: laser,
  });


  //await wait(2000)

  PostMan.PostMessage({
    target: vrcorigin,
    type: "STARTOVERLAY",
    payload: {
      name: "overlayXX",
      texture: "./resources/P1.png",
      sync: false,
    },
  });

  PostMan.PostMessage({
    target: overlayactorVRC,
    type: "ASSIGNVRCORIGIN",
    payload: vrcorigin,
  });

  PostMan.PostMessage({
    target: laser,
    type: "STARTLASERS",
    payload: null,
  });




  PostMan.PostMessage({
    target: overlayactorVRC,
    type: "STARTOVERLAY",
    payload: {
      name: "overlay1",
      texture: "./resources/P1.png",
      sync: true,
      inputActor: inputactor
    },
  });

  PostMan.PostMessage({
    target: inputactor,
    type: "SETOVERLAYACTOR",
    payload: overlayactorVRC,
  });



  //await wait(5000);

  inputloop(inputactor, overlayactorVRC);
}

async function inputloop(inputactor: ToAddress, overlayactor: ToAddress) {
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

