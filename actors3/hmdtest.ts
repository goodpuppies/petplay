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

    const ivr = await Postman.create("InitOpenVR.ts")

    const ptrn = await Postman.PostMessage({
        address: { fm: state.id, to: ivr },
        type: "GETOPENVRPTR",
        payload: null
    }, true)
    await wait(1000)
    console.log("ptrn:", ptrn)

    const net1 = await Postman.create("hmdactor.ts");
    const net2 = await Postman.create("hmdactor.ts");

    Postman.PostMessage({
        address: { fm: state.id, to: [net1, net2] },
        type: "INITOPENVR",
        payload: ptrn
    })

    await wait(1000)

    while (true) {
        const x = await Postman.PostMessage({
            address: { fm: state.id, to: net1 },
            type: "GETHMDPOSITION",
            payload: null
        }, true)
        console.log("x:", x)
        await wait(1000)
        const y = await Postman.PostMessage({
            address: { fm: state.id, to: net2 },
            type: "GETHMDPOSITION",
            payload: null
        }, true)
        console.log("y:", y)

    }



    await wait(1000);

    /*     const _topic = await Postman.PostMessage({
            address: { fm: state.id, to: net1},
            type: "SET_TOPIC",
            payload: "muffin",
        }, true);
     */




    await wait(5000);

    /*  inputloop(inputactor, overlayactor); */
}

new Postman(worker, functions, state);

OnMessage((message) => {
    Postman.runFunctions(message);
});
