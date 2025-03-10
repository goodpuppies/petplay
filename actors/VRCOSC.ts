import { PostMan } from "../stageforge/mod.ts";
import { OscSubscriber } from "../classes/getvrcpos.ts";
import { CustomLogger } from "../classes/customlogger.ts";

//vrchat integration

interface coord {
    [key: string]: number;
}

const state = {
    id: "",
    name: "vrccoordinate",
    socket: null,
    coordinate: {} as coord,
    oscSubscriber: null as OscSubscriber | null,
    addressBook: new Array<string>(),
};

new PostMan(state.name, {
    CUSTOMINIT: (_payload) => {
        PostMan.setTopic("muffin")
        main();
    },
    GETCOORDINATE: (_payloa) => {
        return state.coordinate
    }
} as const);

function handleOscMessage(address: string, value: number) {
    state.coordinate[address] = value;
}

function main() {
    
    //#region consts
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
    //#endregion

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
