import { ToAddress } from "../stageforge/src/lib/types.ts";
import { PostMan } from "../stageforge/mod.ts";
import { wait } from "../classes/utils.ts";
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
    ////PostMan.setTopic("muffin")
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


  const hmd = await PostMan.create("./dogdemo/hmd.ts");
  const inputactor = await PostMan.create("./dogdemo/controllers.ts");
  //const overlayactorVRC = await PostMan.create("./actors/VRCOverlay.ts");
  const vrcorigin = await PostMan.create("./dogdemo/VRCOrigin.ts");
  const genericoverlay = await PostMan.create("./dogdemo/dogoverlay.ts");
  const genericoverlay2 = await PostMan.create("./dogdemo/dogoverlay.ts");
  const vrcosc = await PostMan.create("./dogdemo/VRCOSC.ts");

  await wait(2000)

  //init vr systems
  PostMan.PostMessage({
    target: hmd,
    type: "INITOPENVR",
    payload: ivrsystem
  })

  //init all overlays
  PostMan.PostMessage({
    target: [vrcorigin, genericoverlay, genericoverlay2],
    type: "INITOPENVR",
    payload: ivroverlay
  })
  await wait(5000)

  //#region initialize origin
  //expose osc to origin point
  PostMan.PostMessage({
    target: vrcorigin,
    type: "ASSIGNVRC",
    payload: vrcosc,
  });
  //expose hmd to origin point
  PostMan.PostMessage({
    target: vrcorigin,
    type: "ASSIGNHMD",
    payload: hmd,
  });
  //render origin
  PostMan.PostMessage({
    target: vrcorigin,
    type: "STARTOVERLAY",
    payload: {
      name: "overlayXX",
      texture: "./resources/P1.png",
      sync: false,
    },
  });

  // Expose VRC origin address to the dog overlay
  PostMan.PostMessage({
    target: [genericoverlay, genericoverlay2],
    type: "ASSIGNVRCORIGIN",
    payload: vrcorigin,
  });
  //#endregion 



  //#region initialize generic overlay

  

  await wait(1000)
  PostMan.PostMessage({
    target: genericoverlay,
    type: "STARTOVERLAY",
    payload: {
      name: "pet1",
      texture: "./resources/P1.png",
      sync: true,
    },
  });
  await wait(3000)
  PostMan.PostMessage({
    target: genericoverlay2,
    type: "STARTOVERLAY",
    payload: {
      name: "pet2",
      texture: "./resources/P2.png",
      sync: false,
    },
  });


  //#endregion




  //await wait(5000);

  inputloop(inputactor, genericoverlay);
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
