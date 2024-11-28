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
  addressBook: new Set(),
};

const functions: TypedActorFunctions = {
  MAIN: (payload) => {
    main(payload);
  },
  LOG: (_payload) => {
    CustomLogger.log("actor", state.id);
  },
  STDIN: (payload) => {
    CustomLogger.log("actor", "stdin:", payload);
  },
};

async function main(_payload: Payload["MAIN"]) {
  CustomLogger.log("default", "main actor started");

  const net1 = await Postman.create("netTestActor.ts");
  const net2 = await Postman.create("netTestActor.ts");

  console.log("net1:", net1)
  console.log("net2:", net2)


  await wait(1000);

  const _topic = await Postman.PostMessage({
    address: { fm: state.id, to: [net1, net2] },
    type: "SET_TOPIC",
    payload: "muffin",
  }, true);

  while (true) {
    await wait(10)
    console.log("sendmsg")
    Postman.PostMessage({
      address: { fm: state.id, to: net1 },
      type: "MESSAGE",
      payload: net2,
    });
  }



  await wait(5000);

  /*  inputloop(inputactor, overlayactor); */
}

new Postman(worker, functions, state);

OnMessage((message) => {
  Postman.runFunctions(message);
});
