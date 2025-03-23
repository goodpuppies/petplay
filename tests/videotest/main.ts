import { ToAddress } from "../../submodules/stageforge/src/lib/types.ts";
import { PostMan } from "../../submodules/stageforge/mod.ts";
import { wait } from "../../classes/utils.ts";
import * as OpenVR from "../../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { CustomLogger } from "../../classes/customlogger.ts";

//main process

const state = {
  name: "main",
  id: "",
  db: {},
  socket: null,
  numbah: 0,
  addressBook: new Set()
};


new PostMan(state, {
  MAIN: (_payload: string) => {
    main();
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


  //const overlayactorVRC = await PostMan.create("./actors/VRCOverlay.ts");
  const genericoverlay = await PostMan.create("./videoOverlay.ts");
  const genericoverlay2 = await PostMan.create("./videoOverlay.ts");
 
  await wait(2000)

  //init vr systems


  //init all overlays
  PostMan.PostMessage({
    target: [genericoverlay, genericoverlay2],
    type: "INITOPENVR",
    payload: ivroverlay
  })
  await wait(5000)




  //#region initialize generic overlay

  

  await wait(10000)

  PostMan.PostMessage({
    target: genericoverlay2,
    type: "STARTOVERLAY",
    payload: {
      name: "pet2",
      sync: false,
      frames: 0
    },
  });
  await wait(2000)
  PostMan.PostMessage({
    target: genericoverlay,
    type: "STARTOVERLAY",
    payload: {
      name: "pet1",
      sync: true,
      frames: 0
    },
  });
 



  //#endregion





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
