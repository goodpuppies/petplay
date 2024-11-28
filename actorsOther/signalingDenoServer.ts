import { OnMessage, Postman } from "../classes/PostMan.ts";
import { TypedActorFunctions, BaseState, worker } from "../actorsystem/types.ts";
import { SignalingServer } from "../classes/signalingClass.ts";

const state: BaseState = {
  name: "signalingDenoServer",
  id: "",
  db: {},
  socket: null,
  numbah: 0,
  addressBook: new Set(),
  rtcSocket: null,
};

const functions: TypedActorFunctions = {
  CUSTOMINIT: (_payload) => {
    Postman.functions?.STARTSERVER?.(8081, state.id);
  },
  STARTSERVER: (payload) => {
    const signalingServer = new SignalingServer(payload);
    signalingServer.start();
  },
};

new Postman(worker, functions, state);

OnMessage((message) => {
  Postman.runFunctions(message);
});
