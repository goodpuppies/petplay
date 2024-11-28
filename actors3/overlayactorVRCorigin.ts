import {
    TypedActorFunctions,
    BaseState,
    worker,
    MessageAddressReal,
} from "../actorsystem/types.ts";
import { OnMessage, Postman } from "../classes/PostMan.ts";
import { wait } from "../actorsystem/utils.ts";
import * as OpenVR from "../OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../OpenVR_TS_Bindings_Deno/pointers.ts";
import { CustomLogger } from "../classes/customlogger.ts";

type State = {
    id: string;
    vrc: string;
    hmd: string;
    overlayClass: OpenVR.IVROverlay | null;
    overlayHandle: OpenVR.OverlayHandle;
    overlayerror: OpenVR.OverlayError;
    origin: OpenVR.HmdMatrix34 | null
    sync: boolean;
    originChangeCount: number;
};

const state: State & BaseState = {
    id: "",
    origin: null,
    name: "origin",
    vrc: "",
    hmd: "",
    overlayClass: null,
    overlayHandle: 0n,
    overlayerror: OpenVR.OverlayError.VROverlayError_None,
    sync: false,
    addressBook: new Set(),
    originChangeCount: 0,
};

const functions: TypedActorFunctions = {
    CUSTOMINIT: (_payload) => {
        Postman.functions?.HYPERSWARM?.(null, state.id);
    },
    LOG: (_payload) => {
        CustomLogger.log("actor", state.id);
    },
    GETID: (_payload, address) => {
        const addr = address as MessageAddressReal;
        Postman.PostMessage({
            address: { fm: state.id, to: addr.fm },
            type: "CB:GETID",
            payload: state.id,
        }, false);
    },
    ASSIGNVRC: (payload) => {
        state.vrc = payload;
    },
    ASSIGNHMD: (payload) => {
        state.hmd = payload;
    },
    STARTOVERLAY: (payload, _address) => {
        mainX(payload.name, payload.texture, payload.sync);
    },
    ADDADDRESS: (payload, _address) => {
        state.addressBook.add(payload);
    },
    GETOVERLAYLOCATION: (_payload, address) => {
        const addr = address as MessageAddressReal;
        const m34 = GetOverlayTransformAbsolute();
        Postman.PostMessage({
            address: { fm: state.id, to: addr.fm },
            type: "CB:GETOVERLAYLOCATION",
            payload: m34,
        });
    },
    SETOVERLAYLOCATION: (payload, _address) => {
        const transform = payload as OpenVR.HmdMatrix34;
        if (state.sync == false) {
            CustomLogger.log("syncloop", "set transform ");
        }
        setOverlayTransformAbsolute(transform);
    },
    INITOPENVR: (payload) => {
        const ptrn = payload;
        const systemPtr = Deno.UnsafePointer.create(ptrn);
        state.overlayClass = new OpenVR.IVROverlay(systemPtr);
        CustomLogger.log("actor", `OpenVR system initialized in actor ${state.id} with pointer ${ptrn}`);
    },
    GETVRCORIGIN: (_payload, address) => {
        const addr = address as MessageAddressReal;
        //state.origin is OpenVR.HmdMatrix34
        Postman.PostMessage({
            address: { fm: state.id, to: addr.fm },
            type: "CB:GETVRCORIGIN",
            payload: state.origin,
        })
    }
};

function setOverlayTransformAbsolute(transform: OpenVR.HmdMatrix34) {
    const overlay = state.overlayClass!;
    const transformBuffer = new ArrayBuffer(OpenVR.HmdMatrix34Struct.byteSize);
    const transformView = new DataView(transformBuffer);
    OpenVR.HmdMatrix34Struct.write(transform, transformView);
    const transformPtr = Deno.UnsafePointer.of<OpenVR.HmdMatrix34>(transformBuffer)!;
    overlay.SetOverlayTransformAbsolute(state.overlayHandle, OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding, transformPtr);
}

function GetOverlayTransformAbsolute(): OpenVR.HmdMatrix34 {
    let error = state.overlayerror;
    const overlay = state.overlayClass!;
    const overlayHandle = state.overlayHandle;

    const TrackingUniverseOriginPTR = P.Int32P<OpenVR.TrackingUniverseOrigin>();
    const hmd34size = OpenVR.HmdMatrix34Struct.byteSize;
    const hmd34buf = new ArrayBuffer(hmd34size);
    const hmd34view = new DataView(hmd34buf);
    const m34ptr = Deno.UnsafePointer.of<OpenVR.HmdMatrix34>(hmd34buf)!;

    error = overlay.GetOverlayTransformAbsolute(overlayHandle, TrackingUniverseOriginPTR, m34ptr);
    if (error !== OpenVR.OverlayError.VROverlayError_None) {
        CustomLogger.error("actorerr", `Failed to get overlay transform: ${OpenVR.OverlayError[error]}`);
        throw new Error("Failed to get overlay transform");
    }
    const m34 = OpenVR.HmdMatrix34Struct.read(hmd34view) as OpenVR.HmdMatrix34;
    return m34;
}

const PositionX: string = "/avatar/parameters/CustomObjectSync/PositionX";
const PositionY: string = "/avatar/parameters/CustomObjectSync/PositionY";
const PositionZ: string = "/avatar/parameters/CustomObjectSync/PositionZ";
const RotationY: string = "/avatar/parameters/CustomObjectSync/RotationY";

const lastKnownPosition: LastKnownPosition = { x: 0, y: 0, z: 0 };
const lastKnownRotation: LastKnownRotation = { y: 0 };

interface LastKnownPosition {
    x: number;
    y: number;
    z: number;
}

interface LastKnownRotation {
    y: number;
}

async function mainX(overlaymame: string, overlaytexture: string, sync: boolean) {
    state.sync = sync;
    const overlay = state.overlayClass as OpenVR.IVROverlay;

    const overlayHandlePTR = P.BigUint64P<OpenVR.OverlayHandle>();
    const error = overlay.CreateOverlay(overlaymame, overlaymame, overlayHandlePTR);
    const overlayHandle = new Deno.UnsafePointerView(overlayHandlePTR).getBigUint64();
    state.overlayHandle = overlayHandle;

    CustomLogger.log("actor", `Overlay created with handle: ${overlayHandle}`);

    const imgpath = Deno.realPathSync(overlaytexture);
    overlay.SetOverlayFromFile(overlayHandle, imgpath);
    overlay.SetOverlayWidthInMeters(overlayHandle, 0.5);
    overlay.ShowOverlay(overlayHandle);

    const initialTransformSize = OpenVR.HmdMatrix34Struct.byteSize;
    const initialTransformBuf = new ArrayBuffer(initialTransformSize);
    const initialTransformView = new DataView(initialTransformBuf);

    const initialTransform: OpenVR.HmdMatrix34 = {
        m: [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 1.0],
            [0.0, 0.0, 1.0, -2.0]
        ]
    };
    OpenVR.HmdMatrix34Struct.write(initialTransform, initialTransformView);
    state.trackingUniverseOriginPTR = Deno.UnsafePointer.of<OpenVR.TrackingUniverseOrigin>(new Int32Array(1))!;
    setOverlayTransformAbsolute(initialTransform);

    CustomLogger.log("default", "Overlay created and shown.");



    function transformCoordinate(value: number): number {
        return (value - 0.5) * 340;
    }

    function transformRotation(value: number): number {
        return value * 2 * Math.PI;
    }

    let lastOrigin: OpenVR.HmdMatrix34 | null = null;
    let lastLogTime = Date.now();

    function isOriginChanged(newOrigin: OpenVR.HmdMatrix34): boolean {
        if (!lastOrigin) return true;
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 4; j++) {
                if (newOrigin.m[i][j] !== lastOrigin.m[i][j]) return true;
            }
        }
        return false;
    }

    while (true) {
        if (state.vrc != "") {
            interface coord {
                [key: string]: number;
            }

            const hmdPose = await Postman.PostMessage({
                address: { fm: state.id, to: state.hmd },
                type: "GETHMDPOSITION",
                payload: null,
            }, true) as OpenVR.TrackedDevicePose;

            const hmdMatrix = hmdPose.mDeviceToAbsoluteTracking.m;
            const hmdYaw = Math.atan2(hmdMatrix[0][2], hmdMatrix[0][0]);

            const coordinate = await Postman.PostMessage({
                address: { fm: state.id, to: state.vrc },
                type: "GETCOORDINATE",
                payload: null,
            }, true) as coord;

            if (coordinate[PositionX] !== undefined) lastKnownPosition.x = coordinate[PositionX];
            if (coordinate[PositionY] !== undefined) lastKnownPosition.y = coordinate[PositionY];
            if (coordinate[PositionZ] !== undefined) lastKnownPosition.z = coordinate[PositionZ];
            if (coordinate[RotationY] !== undefined) lastKnownRotation.y = coordinate[RotationY];

            const hmdX = hmdMatrix[0][3];  // Extract HMD X position
            const hmdY = hmdMatrix[1][3];  // Extract HMD Y position
            const hmdZ = hmdMatrix[2][3];  // Extract HMD Z position
            const vrChatYaw = transformRotation(lastKnownRotation.y);
            const correctedYaw = hmdYaw + vrChatYaw;

            const cosVrChatYaw = Math.cos(correctedYaw);
            const sinVrChatYaw = Math.sin(correctedYaw);
            const rotatedHmdX = hmdX * cosVrChatYaw - hmdZ * sinVrChatYaw;
            const rotatedHmdZ = hmdX * sinVrChatYaw + hmdZ * cosVrChatYaw;


            const transformedX = transformCoordinate(lastKnownPosition.x) + rotatedHmdX;
            const transformedY = transformCoordinate(lastKnownPosition.y);
            const transformedZ = transformCoordinate(lastKnownPosition.z) - rotatedHmdZ;


            const cosCorrectedYaw = Math.cos(correctedYaw);
            const sinCorrectedYaw = Math.sin(correctedYaw);

            const rotatedX = transformedX * cosCorrectedYaw - transformedZ * sinCorrectedYaw;
            const rotatedZ = transformedX * sinCorrectedYaw + transformedZ * cosCorrectedYaw;



            const pureMatrix: OpenVR.HmdMatrix34 = {
                m: [
                    [cosCorrectedYaw, 0, sinCorrectedYaw, rotatedX],
                    [0, 1, 0, -transformedY],
                    [-sinCorrectedYaw, 0, cosCorrectedYaw, -rotatedZ]
                ]
            };
            if (isOriginChanged(pureMatrix)) {
                state.origin = pureMatrix;
                state.originChangeCount++;
                lastOrigin = pureMatrix;
            }


            //#region visual
            const angle = -Math.PI / 2; // -90 degrees, pointing straight down

            // Sin and cos of the angle
            const s = Math.sin(angle);
            const c = Math.cos(angle);

            const matrix: OpenVR.HmdMatrix34 = {
                m: [
                    [cosCorrectedYaw, sinCorrectedYaw * s, sinCorrectedYaw * c, rotatedX],
                    [0, c, -s, -transformedY + 2.9],
                    [-sinCorrectedYaw, cosCorrectedYaw * s, cosCorrectedYaw * c, -rotatedZ]
                ]
            };

            //CustomLogger.log("default", "Overlay Transformation Matrix: ", matrix);
            setOverlayTransformAbsolute(matrix);
            //#endregion

        }
        const currentTime = Date.now();
        if (currentTime - lastLogTime >= 1000) {
            console.log(`Origin changed ${state.originChangeCount} times in the last second`);
            state.originChangeCount = 0;
            lastLogTime = currentTime;
        }

        await wait(11);
    }
}

new Postman(worker, functions, state);

OnMessage((message) => {
    Postman.runFunctions(message);
});