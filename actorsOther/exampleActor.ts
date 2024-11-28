import {
  TypedActorFunctions,
  BaseState,

  worker,
  MessageAddressReal,
} from "../actorsystem/types.ts";

import { OnMessage, Postman } from "../classes/PostMan.ts";



type State = {
  id: string;
  db: Record<string, unknown>;
  [key: string]: unknown;
};

const state: State & BaseState = {
  id: "",
  db: {},
  name: "sub",
  socket: null,
  numbah: 0,
  addressbook: [],
};

const functions: TypedActorFunctions = {
  CUSTOMINIT: (_payload) => {
    hyperswarm()
  },
  LOG: (_payload) => {
    console.log(state.id);
  },
  GETID: (_payload, address) => {
    // use a check here
    const addr = address as MessageAddressReal;
    Postman.PostMessage({
      address: { fm: state.id, to: addr.fm },
      type: "CB:GETID",
      payload: state.id,
    }, false);
  },
};
function hyperswarm() {
  Postman.functions?.HYPERSWARM?.(null, state.id);
}

new Postman(worker, functions, state);

OnMessage((message) => {
  Postman.runFunctions(message);
});
