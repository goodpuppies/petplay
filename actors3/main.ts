import { TypedActorFunctions, BaseState, Payload, ToAddress, worker } from "../actorsystem/types.ts";
import { OnMessage, Postman } from "../classes/PostMan.ts";
import { wait } from "../actorsystem/utils.ts";
import { OpenVRType } from "../OpenVR_TS_Bindings_Deno/utils.ts";
import * as OpenVR from "../OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { CustomLogger } from "../classes/customlogger.ts";

//main process

type State = {
  id: string;
  db: Record<string, unknown>;
  [key: string]: unknown;
};

const state: State & BaseState = {
  name: "main",
  id: "",
  db: {},
  socket: null,
  numbah: 0,
  addressBook: new Set()
};

export const functions = {
  MAIN: (payload: string) => {
    main(payload);
  },
  LOG: (_payload: null) => {
    CustomLogger.log("actor", state.id);
  },
  STDIN: (payload: string) => {
    CustomLogger.log("actor", "stdin:", payload);
  },
};

async function main(_payload: Payload["MAIN"]) {
  CustomLogger.log("default", "main actor started");

  const ivr = await Postman.create("InitOpenVR.ts")
  const ivrsystem = await Postman.PostMessage({
    address: { fm: state.id, to: ivr },
    type: "GETOPENVRPTR",
    payload: null
  }, true)
  const ivroverlay = await Postman.PostMessage({
    address: { fm: state.id, to: ivr },
    type: "GETOVERLAYPTR",
    payload: null
  }, true)


  const overlayactor = await Postman.create("overlayactor.ts");



  const hmd = await Postman.create("hmdactor.ts");
  const inputactor = await Postman.create("inputactor.ts");

  const overlayactorVRC = await Postman.create("overlayactorVRC.ts");

  const vrcorigin = await Postman.create("overlayactorVRCorigin.ts");


  await wait(1000)

  Postman.PostMessage({
    address: { fm: state.id, to: hmd },
    type: "INITOPENVR",
    payload: ivrsystem
  })
  Postman.PostMessage({
    address: { fm: state.id, to: [overlayactorVRC, vrcorigin] },
    type: "INITOPENVR",
    payload: ivroverlay
  })


  const vrc = await Postman.create("vrccoordinate.ts");


  Postman.PostMessage({
    address: { fm: state.id, to: vrcorigin },
    type: "ASSIGNVRC",
    payload: vrc,
  });

  Postman.PostMessage({
    address: { fm: state.id, to: vrcorigin },
    type: "ASSIGNHMD",
    payload: hmd,
  });


  await wait(2000)

  Postman.PostMessage({
    address: { fm: state.id, to: vrcorigin },
    type: "STARTOVERLAY",
    payload: {
      name: "overlayXX",
      texture: "./resources/P1.png",
      sync: false,
    },
  });

  Postman.PostMessage({
    address: { fm: state.id, to: overlayactorVRC },
    type: "ASSIGNVRCORIGIN",
    payload: vrcorigin,
  });





  Postman.PostMessage({
    address: { fm: state.id, to: overlayactorVRC },
    type: "STARTOVERLAY",
    payload: {
      name: "overlay1",
      texture: "./resources/PetPlay.png",
      sync: true,
    },
  });



  await wait(5000);

  inputloop(inputactor, overlayactorVRC);
}

async function inputloop(inputactor: ToAddress, overlayactor: ToAddress) {
  CustomLogger.log("default", "inputloop started");
  while (true) {
    const inputstate = await Postman.PostMessage({
      address: { fm: state.id, to: inputactor },
      type: "GETCONTROLLERDATA",
      payload: null,
    }, true) as [
        OpenVR.InputPoseActionData,
        OpenVR.InputPoseActionData,
        OpenVR.InputDigitalActionData,
        OpenVR.InputDigitalActionData,
      ];

    if (inputstate[2].bState == 1) {
      Postman.PostMessage({
        address: { fm: state.id, to: overlayactor },
        type: "SETOVERLAYLOCATION",
        payload: inputstate[0].pose.mDeviceToAbsoluteTracking,
      });
    } else if (inputstate[3].bState == 1) {
      Postman.PostMessage({
        address: { fm: state.id, to: overlayactor },
        type: "SETOVERLAYLOCATION",
        payload: inputstate[1].pose.mDeviceToAbsoluteTracking,
      });
    }

    await wait(10);
  }
}

new Postman(worker, functions, state);

OnMessage((message) => {
  Postman.runFunctions(message);
});
