import {
  TypedActorFunctions,
  BaseState,
  MessageAddressReal,
  ToAddress,
  worker,
} from "../actorsystem/types.ts";
import { OnMessage, Postman } from "../classes/PostMan.ts";

type State = {
  username: string | null;
  registry: Record<string, string>;
};

const state: State & BaseState = {
  id: "",
  name: "portal",
  socket: null,
  username: null,
  registry: {},
};

const functions: TypedActorFunctions = {
  CUSTOMINIT: (_payload) => {
    hyperswarm();
  },
  LOG: (_payload) => {
    console.log(state.id);
  },
  PREGISTER: (payload) => {
    register(payload);
  },
  LOOKUP: (payload, address) => {
    const addr = address as MessageAddressReal;
    lookup(payload, addr.fm);
  },
  GET_ALL: (_payload, address) => {
    const addr = address as MessageAddressReal;
    getAllEntries(addr.fm);
  },
};

function hyperswarm() {
  Postman.functions?.HYPERSWARM?.(null, state.id);
}

function register(payload: { name: string; address: string }) {
  const { name, address } = payload;

  if (name.startsWith("self:")) {
    const username = name.slice(5);
    if (state.username && state.username !== username) {
      console.error("Cannot change own username after initialization");
      return;
    }
    state.username = username;
    state.registry[username] = address;
    state.registry["portal"] = state.id;

    console.log(`Portal initialized/updated with username: ${state.username}`);
  } else {
    if (!state.username) {
      console.error("Portal not initialized. Register self first.");
      return;
    }
    state.registry[name] = address;
  }

  // Register the actor (or user) regardless of whether it's self or not

  console.log(`Registered ${name} with address ${address}`);
}

function lookup(name: string, returnAddress: ToAddress) {
  if (!state.username) {
    console.error("Portal not initialized. Register self first.");
    return;
  }

  const address = state.registry[name];
  const result = address ? address : `No address found for ${name}`;

  Postman.PostMessage({
    address: { fm: state.id, to: returnAddress },
    type: "CB:LOOKUP",
    payload: result,
  });
}

function getAllEntries(returnAddress: ToAddress) {
  if (!state.username) {
    console.error("Portal not initialized. Call INIT first.");
    return null;
  }

  Postman.PostMessage({
    address: { fm: state.id, to: returnAddress },
    type: "CB:GET_ALL",
    payload: Object.entries(state.registry),
  });
}

new Postman(worker, functions, state);

OnMessage((message) => {
  Postman.runFunctions(message);
});
