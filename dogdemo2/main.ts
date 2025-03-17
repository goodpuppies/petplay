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
  addressBook: new Set(),
  vrcosc: undefined as undefined | string
};


new PostMan(state, {
  MAIN: (_payload: string) => {
    PostMan.setTopic("vrcosc")
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


  const hmd = await PostMan.create("./dogdemo2/hmd.ts");
  const inputactor = await PostMan.create("./dogdemo2/controllers.ts");
  //const overlayactorVRC = await PostMan.create("./actors/VRCOverlay.ts");
  const vrcorigin = await PostMan.create("./dogdemo2/VRCOrigin.ts");
  const genericoverlay = await PostMan.create("./dogdemo2/dogoverlay.ts");
  //const vrcosc = await PostMan.create("./dogdemo2/VRCOSC.ts");

  //find common vrcosc
  console.log("startfinding osc")
  console.log("book is ", )
  while (!state.vrcosc) {
    // Check if addressBook has any entry starting with "vrccoordinate"
    for (const address of PostMan.state.addressBook) {
      if (typeof address === 'string' && address.startsWith('vrccoordinate')) {
        state.vrcosc = address;
        CustomLogger.log("default", `Found VRC OSC: ${address}`);
        break;
      } 
    }
    // If not found, wait briefly before checking again
    if (!state.vrcosc) {
      await wait(500);
    }
  }

  await wait(2000)

  //init vr systems
  PostMan.PostMessage({
    target: hmd,
    type: "INITOPENVR",
    payload: ivrsystem
  })

  //init all overlays
  PostMan.PostMessage({
    target: [vrcorigin, genericoverlay],
    type: "INITOPENVR",
    payload: ivroverlay
  })
  await wait(5000)

  //#region initialize origin
  //expose osc to origin point
  PostMan.PostMessage({
    target: vrcorigin,
    type: "ASSIGNVRC",
    payload: state.vrcosc,
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
      name: "overlayXXX",
      texture: "./resources/P2.png",
      sync: false,
    },
  });

  // Expose VRC origin address to the dog overlay
  PostMan.PostMessage({
    target: [genericoverlay],
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
      name: "pet2",
      texture: "./resources/P2.png",
      sync: true,
    },
  });




  //#endregion




  //await wait(5000);

  //inputloop(inputactor, genericoverlay);
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
