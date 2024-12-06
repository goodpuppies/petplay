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
    SCREENDATA: (payload: string) => {
        try {
            const data = JSON.parse(payload);
            const { width, height, data: imageData, format } = data;
            
            CustomLogger.log("default", `Received ${format} screen data: ${width}x${height}, ${imageData.length} bytes in base64`);
            
            // Try to decode a few bytes just to verify data integrity
            const sampleBytes = atob(imageData.slice(0, 10));
            CustomLogger.log("default", `First few bytes verified: ${Array.from(sampleBytes).map(b => b.charCodeAt(0))}`);
        } catch (err) {
            CustomLogger.log("default", "Error handling screen data:", err);
        }
    },
} as const;

async function main(_payload: unknown) {

    //create iroh doc

    //announce doc in portal
    await wait(4000)

    const obj = {
        name: "muffin"
    }

    /* const doc = await Postman.PostMessage({
        address: { fm: state.id, to: Postman.portal },
        type: "CREATEDOC",
        payload: null
    }, true)
    console.log(doc) */


}



new Postman(worker, functions, state);

OnMessage((message) => {
    //console.log("got msg", message)
    Postman.runFunctions(message);
});
