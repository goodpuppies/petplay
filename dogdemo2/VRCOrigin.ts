import { PostMan } from "../stageforge/mod.ts";
import { wait } from "../classes/utils.ts";
import * as OpenVR from "../OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../OpenVR_TS_Bindings_Deno/pointers.ts";
import { CustomLogger } from "../classes/customlogger.ts";
import { OpenVRTransform } from "../classes/openvrTransform.ts";
import { TransformStabilizer } from "../classes/transformStabilizer.ts";

const state = {
    id: "",
    origin: null as OpenVR.HmdMatrix34 | null,
    name: "origin",
    vrc: "",
    hmd: "",
    overlayClass: null as OpenVR.IVROverlay | null,
    overlayHandle: 0n as OpenVR.OverlayHandle,
    overlayerror: OpenVR.OverlayError.VROverlayError_None,
    sync: false,
    addressBook: new Set(),
    overlayTransform: null as OpenVRTransform | null,
    originChangeCount: 0,
    transformStabilizer: null as TransformStabilizer | null,
};

new PostMan(state, {
    CUSTOMINIT: (_payload: void) => {
        PostMan.setTopic("vrcosc")
    },
    LOG: (_payload: void) => {
        CustomLogger.log("actor", state.id);
    },
    GETID: (_payload: void) => {
        return state.id
    },
    ASSIGNVRC: (payload: string) => {
        state.vrc = payload;
    },
    ASSIGNHMD: (payload: string) => {
        state.hmd = payload;
    },
    STARTOVERLAY: (payload: { name: string, texture: string, sync: boolean }) => {
        mainX(payload.name, payload.texture, payload.sync);
    },
    ADDADDRESS: (payload: string) => {
        state.addressBook.add(payload);
    },
    GETOVERLAYLOCATION: (_payload: void) => {
        const m34 = GetOverlayTransformAbsolute();
        return m34
    },
    SETOVERLAYLOCATION: (payload: OpenVR.HmdMatrix34) => {
        const transform = payload;
        if (state.sync == false) {
            CustomLogger.log("syncloop", "set transform ");
        }
        setOverlayTransformAbsolute(transform);
    },
    INITOPENVR: (payload: bigint) => {
        const ptrn = payload;
        const systemPtr = Deno.UnsafePointer.create(ptrn);
        state.overlayClass = new OpenVR.IVROverlay(systemPtr);
        CustomLogger.log("actor", `OpenVR system initialized in actor ${state.id} with pointer ${ptrn}`);
    },
    GETVRCORIGIN: (_payload: void) => {
        return state.origin
    }
} as const);

//#region out of scope

function setOverlayTransformAbsolute(transform: OpenVR.HmdMatrix34) {
    if (!state.overlayTransform) { throw new Error("overlayTransform is null"); }
    state.overlayTransform.setTransformAbsolute(transform);
}

function GetOverlayTransformAbsolute(): OpenVR.HmdMatrix34 {
    if (!state.overlayTransform) { throw new Error("overlayTransform is null"); }
    return state.overlayTransform.getTransformAbsolute();
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

//#endregion

async function mainX(overlaymame: string, overlaytexture: string, sync: boolean) {
    try {
        state.sync = sync;
        state.transformStabilizer = new TransformStabilizer();

        CustomLogger.log("overlay", "Creating overlay...");
        const overlay = state.overlayClass as OpenVR.IVROverlay;
        const overlayHandlePTR = P.BigUint64P<OpenVR.OverlayHandle>();
        const error = overlay.CreateOverlay(overlaymame, overlaymame, overlayHandlePTR);

        if (error !== OpenVR.OverlayError.VROverlayError_None) {
            throw new Error(`Failed to create overlay: ${OpenVR.OverlayError[error]}`);
        }

        const overlayHandle = new Deno.UnsafePointerView(overlayHandlePTR).getBigUint64();
        state.overlayHandle = overlayHandle;
        state.overlayTransform = new OpenVRTransform(overlay, overlayHandle);

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

                const hmdPose = await PostMan.PostMessage({
                    target: state.hmd,
                    type: "GETHMDPOSITION",
                    payload: null,
                }, true) as OpenVR.TrackedDevicePose;

                const hmdMatrix = hmdPose.mDeviceToAbsoluteTracking.m;
                const hmdYaw = Math.atan2(hmdMatrix[0][2], hmdMatrix[0][0]);

                const coordinate = await PostMan.PostMessage({
                    target: state.vrc,
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

                // Create HMD transform matrix
                const hmdTransform: OpenVR.HmdMatrix34 = {
                    m: [
                        [hmdMatrix[0][0], hmdMatrix[0][1], hmdMatrix[0][2], hmdX],
                        [hmdMatrix[1][0], hmdMatrix[1][1], hmdMatrix[1][2], hmdY],
                        [hmdMatrix[2][0], hmdMatrix[2][1], hmdMatrix[2][2], hmdZ]
                    ]
                };

                const angle = -Math.PI / 2; // -90 degrees, pointing straight down
                const s = Math.sin(angle);
                const c = Math.cos(angle);

                const finalMatrix: OpenVR.HmdMatrix34 = {
                    m: [
                        [cosCorrectedYaw, sinCorrectedYaw * s, sinCorrectedYaw * c, rotatedX],
                        [0, c, -s, -transformedY + 2.9],
                        [-sinCorrectedYaw, cosCorrectedYaw * s, cosCorrectedYaw * c, -rotatedZ]
                    ]
                };

                if (state.transformStabilizer) {
                    const stabilizedMatrix = state.transformStabilizer.getStabilizedTransform(
                        pureMatrix,
                        hmdTransform,
                        finalMatrix
                    );
                    setOverlayTransformAbsolute(finalMatrix);

                    // Use stabilized matrix for origin updates too
                    if (isOriginChanged(stabilizedMatrix)) {
                        state.origin = stabilizedMatrix;
                        state.originChangeCount++;
                        lastOrigin = stabilizedMatrix;
                    }
                } else {
                    setOverlayTransformAbsolute(finalMatrix);

                    if (isOriginChanged(pureMatrix)) {
                        state.origin = pureMatrix;
                        state.originChangeCount++;
                        lastOrigin = pureMatrix;
                    }
                }

                const currentTime = Date.now();
                if (currentTime - lastLogTime >= 1000) {
                    CustomLogger.log("origin", `Origin changed ${state.originChangeCount} times in the last second`);
                    state.originChangeCount = 0;
                    lastLogTime = currentTime;
                }

                await wait(11);
            }
            await wait(11);
        }
    } catch (e) {
        CustomLogger.error("overlay", `Error in mainX: ${(e as Error).message}`);
    }
}
