import {
  TypedActorFunctions,
  BaseState,
  ToAddress,
  worker,
  System,
  MessageAddressReal,
} from "../actorsystem/types.ts";

import { wait } from "../actorsystem/utils.ts";

import { OnMessage, Postman } from "../classes/PostMan.ts";
import { CustomLogger } from "../classes/customlogger.ts";

type State = {
  id: string;
  channel: string | null;

  [key: string]: unknown;
};

const state: State & BaseState = {
  id: "",
  channel: null,
  name: "sub",
  socket: null,
  addressBook: new Set(),
};

const functions: TypedActorFunctions = {
  CUSTOMINIT: (_payload) => {
    NET()
  },
  LOG: (_payload) => {
    console.log("LOG", state.id)
    CustomLogger.log("actor", state.id);
    CustomLogger.log("actor", state.addressBook);
  },
  MESSAGE: (payload, _address) => {

    console.log("message", state.id)
    const addr = payload as ToAddress;

    CustomLogger.log("actor", "trying")
    console.log("MESSAGE", payload)


    Postman.PostMessage({
      address: { fm: state.id, to: addr },
      type: "LOG",
      payload: null,
    });
  },
  GETID: (_payload, address) => {
    // use a check here
    const addr = address as MessageAddressReal;
    Postman.PostMessage({
      address: { fm: state.id, to: addr.fm },
      type: "CB:GETID",
      payload: state.id,
    });
  },
};


async function NET() {
  Postman.functions?.HYPERSWARM?.(null, state.id);
}

new Postman(worker, functions, state);

OnMessage((message) => {
  Postman.runFunctions(message);
});
