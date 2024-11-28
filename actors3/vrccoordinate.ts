import {
    TypedActorFunctions,
    BaseState,
    worker,
    MessageAddressReal,
} from "../actorsystem/types.ts";
import { OnMessage, Postman } from "../classes/PostMan.ts";
import { OscSubscriber } from "../classes/getvrcpos.ts";
import { CustomLogger } from "../classes/customlogger.ts";

//vrchat integration

interface coord {
    [key: string]: number;
}

type State = {
    oscSubscriber: OscSubscriber | null
    coordinate: coord
    [key: string]: unknown;
};

const state: State & BaseState = {
    id: "",
    name: "vrccoordinate",
    socket: null,
    coordinate: {},
    oscSubscriber: null,
    addressBook: new Array<string>(),
};

const functions: TypedActorFunctions = {
    CUSTOMINIT: (_payload) => {
        main();
    },
    LOG: (_payload) => {
        CustomLogger.log("actor", state.id);
    },
    GETCOORDINATE: (_payload, address) => {
        const addr = address as MessageAddressReal;
        Postman.PostMessage({
            address: { fm: state.id, to: addr.fm },
            type: "CB:GETCOORDINATE",
            payload: state.coordinate
        });
    }
};

function handleOscMessage(address: string, value: number) {
    state.coordinate[address] = value;
}

function main() {
    const PositionX: string = "/avatar/parameters/CustomObjectSync/PositionX";
    const PositionXNeg: string = "/avatar/parameters/CustomObjectSync/PositionXNeg";
    const PositionXPos: string = "/avatar/parameters/CustomObjectSync/PositionXPos";
    const RotationX: string = "/avatar/parameters/CustomObjectSync/RotationX";
    const AngleMagX_Angle = "/avatar/parameters/CustomObjectSync/AngleMagX_Angle";
    const AngleSignX_Angle = "/avatar/parameters/CustomObjectSync/AngleSignX_Angle"

    const PositionY: string = "/avatar/parameters/CustomObjectSync/PositionY";
    const PositionYNeg: string = "/avatar/parameters/CustomObjectSync/PositionYNeg";
    const PositionYPos: string = "/avatar/parameters/CustomObjectSync/PositionYPos";
    const RotationY: string = "/avatar/parameters/CustomObjectSync/RotationY";
    const AngleMagY_Angle = "/avatar/parameters/CustomObjectSync/AngleMagY_Angle";
    const AngleSignY_Angle = "/avatar/parameters/CustomObjectSync/AngleSignY_Angle"

    const PositionZ: string = "/avatar/parameters/CustomObjectSync/PositionZ";
    const PositionZNeg: string = "/avatar/parameters/CustomObjectSync/PositionZNeg";
    const PositionZPos: string = "/avatar/parameters/CustomObjectSync/PositionZPos";
    const RotationZ: string = "/avatar/parameters/CustomObjectSync/RotationZ";
    const AngleMagZ_Angle = "/avatar/parameters/CustomObjectSync/AngleMagZ_Angle";
    const AngleSignZ_Angle = "/avatar/parameters/CustomObjectSync/AngleSignZ_Angle"




    state.oscSubscriber = new OscSubscriber([
        PositionX, PositionY, PositionZ,
        PositionXNeg, PositionYNeg, PositionZNeg,
        PositionXPos, PositionYPos, PositionZPos,
        RotationX, RotationY, RotationZ,
        AngleMagX_Angle, AngleMagY_Angle, AngleMagZ_Angle,
        AngleSignX_Angle, AngleSignY_Angle, AngleSignZ_Angle
    ]);
    if (state.oscSubscriber) {
        state.oscSubscriber.subscribe(handleOscMessage.bind(state));
        state.oscSubscriber.listenForOscMessages().then(() => {
            CustomLogger.log("actor", "Finished listening for OSC messages.");
        });
    }

}

new Postman(worker, functions, state);

OnMessage((message) => {
    Postman.runFunctions(message);
});
