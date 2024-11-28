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
    name: "dummy",
    id: "",
    addressBook: new Set()
};

export const functions = {
    CUSTOMINIT: (payload: null) => {
        main(payload);
        Postman.functions.OPENPORTAL("muffin")
    },
    LOG: (payload: null) => {
        console.log("AAAA")
        CustomLogger.log("actor", state.id);
    },
    STDIN: (payload: string) => {
        CustomLogger.log("actor", "stdin:", payload);
    },
} as const;

async function main(_payload: unknown) {

    //create iroh doc

    //announce doc in portal
    await wait(4000)

    const obj = {
        name: "muffin"
    }

    const doc = await Postman.PostMessage({
        address: { fm: state.id, to: Postman.portal },
        type: "CREATEDOC",
        payload: null
    }, true)
    console.log(doc)


}



new Postman(worker, functions, state);

OnMessage((message) => {
    //console.log("got msg", message)
    Postman.runFunctions(message);
});
