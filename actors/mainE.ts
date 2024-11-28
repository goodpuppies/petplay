import { Message, TypedActorFunctions, BaseState, ToAddress, worker, type GenericActorFunctions } from "../actorsystem/types.ts";
import { OnMessage, Postman } from "../classes/PostMan.ts";
import { wait } from "../actorsystem/utils.ts";
import { CustomLogger } from "../classes/customlogger.ts";
import type { Message as IrohMessage } from "@number0/iroh";

//main process

type State = {
  [key: string]: unknown;
};

const state: State & BaseState = {
  name: "main",
  id: "",
  addressBook: new Set()
};

export const functions = {
  MAIN: (payload: null) => {
    main(payload);
    Postman.functions.OPENPORTAL("muffin")
  },
  LOG: (_payload: null) => {
    CustomLogger.log("actor", state.id);
  },
  STDIN: (payload: string) => {
    CustomLogger.log("actor", "stdin:", payload);
  },
} as const;

async function main(_payload: unknown) {

  const dummy = await Postman.create("dummy.ts")
  
  console.log("DUMMY CREATED")

  await wait(2000)
  console.log("trigger log id dummy")
  
  Postman.PostMessage({
    address: {
      fm: state.id,
      to: dummy
    },
    type: "LOG",
    payload: null
  })
}

new Postman(worker, functions, state);

OnMessage((message) => {
  console.log("message received:", message)

  Postman.runFunctions(message);
});
