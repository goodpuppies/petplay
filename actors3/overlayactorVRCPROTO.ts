import {
    TypedActorFunctions,
    BaseState,
    worker,
    ToAddress,
    MessageAddressReal,
} from "../actorsystem/types.ts";
import { OnMessage, Postman } from "../classes/PostMan.ts";
import { wait } from "../actorsystem/utils.ts";
import * as OpenVR from "../OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../OpenVR_TS_Bindings_Deno/pointers.ts";
import { stringToPointer } from "../OpenVR_TS_Bindings_Deno/utils.ts";
import { CustomLogger } from "../classes/customlogger.ts";

//a steamvr overlay

type State = {
    id: string;
    vrc: string;
    db: Record<string, unknown>;
    vrSystem: OpenVR.IVRSystem | null;
    overlayClass: OpenVR.IVROverlay | null;
    overlayHandle: OpenVR.OverlayHandle;
    overlayerror: OpenVR.OverlayError;
    OverlayTransform: OpenVR.HmdMatrix34 | null;
    [key: string]: unknown;
};

const state: State & BaseState = {
    id: "",
    db: {},
    name: "overlay1",
    vrc: "",
    hmd: "",
    vrSystem: null,
    socket: null,
    sync: false,
    overlayClass: null,
    OverlayTransform: null,
    numbah: 0,
    addressBook: new Set<string>(),
    overlayHandle: 0n,
    TrackingUniverseOriginPTR: null,
    overlayerror: OpenVR.OverlayError.VROverlayError_None,
};

const functions: TypedActorFunctions = {
    CUSTOMINIT: (_payload) => {
        Postman.functions?.HYPERSWARM?.(null, state.id);
        //main()
    },
    LOG: (_payload) => {
        CustomLogger.log("actor", state.id);
    },
    GETID: (_payload, address) => {
        // use a check here
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
        const systemPtr = Deno.UnsafePointer.create(ptrn);  // Recreate the pointer
        state.overlayClass = new OpenVR.IVROverlay(systemPtr);
        CustomLogger.log("actor", `OpenVR system initialized in actor ${state.id} with pointer ${ptrn}`);
    },
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

    let error = state.overlayerror
    const overlay = state.overlayClass!
    const overlayHandle = state.overlayHandle


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


    state.sync = sync;


    //#region init openvr
    let error;


    const overlay = state.overlayClass as OpenVR.IVROverlay;
    //#endregion

    //#region overlay

    //#region show
    const overlayHandlePTR = P.BigUint64P<OpenVR.OverlayHandle>();

    error = overlay.CreateOverlay(overlaymame, overlaymame, overlayHandlePTR);
    const overlayHandle = new Deno.UnsafePointerView(overlayHandlePTR).getBigUint64();
    state.overlayHandle = overlayHandle;

    CustomLogger.log("actor", `Overlay created with handle: ${overlayHandle}`);

    const imgpath = Deno.realPathSync(overlaytexture);
    overlay.SetOverlayFromFile(overlayHandle, imgpath);
    overlay.SetOverlayWidthInMeters(overlayHandle, 1);
    overlay.ShowOverlay(overlayHandle);
    //#endregion



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
    setOverlayTransformAbsolute(initialTransform)

    CustomLogger.log("default", "Overlay created and shown.");
    //#endregion


    await wait(7000)

    function transformCoordinate(value: number): number {

        return (value - 0.5) * 360;
    }

    function transformRotation(value: number): number {
        return value * 2 * Math.PI;
    }


    while (true) {



        if (state.vrc != "") {
            interface coord {
                [key: string]: number;
            }

            // Get the HMD position and orientation (pose)
            const hmdPose = await Postman.PostMessage({
                address: { fm: state.id, to: state.hmd },
                type: "GETHMDPOSITION",
                payload: null,
            }, true) as OpenVR.TrackedDevicePose;

            // Extract the 3x3 rotation matrix from the HMD pose
            const hmdMatrix = hmdPose.mDeviceToAbsoluteTracking.m;

            // Calculate the HMD's yaw (rotation around the Y axis)
            const hmdYaw = Math.atan2(hmdMatrix[0][2], hmdMatrix[0][0]);

            // Get the VRChat coordinate data
            const coordinate = await Postman.PostMessage({
                address: { fm: state.id, to: state.vrc },
                type: "GETCOORDINATE",
                payload: null,
            }, true) as coord;

            if (coordinate[PositionX] !== undefined) lastKnownPosition.x = coordinate[PositionX];
            if (coordinate[PositionY] !== undefined) lastKnownPosition.y = coordinate[PositionY];
            if (coordinate[PositionZ] !== undefined) lastKnownPosition.z = coordinate[PositionZ];
            if (coordinate[RotationY] !== undefined) lastKnownRotation.y = coordinate[RotationY];

            // Transform VRChat coordinates
            const transformedX = transformCoordinate(lastKnownPosition.x);
            const transformedY = transformCoordinate(lastKnownPosition.y);
            const transformedZ = transformCoordinate(lastKnownPosition.z);

            // Get the VRChat yaw (rotation around Y axis) from VRChat data
            const vrChatYaw = transformRotation(lastKnownRotation.y);

            // Combine HMD's yaw with VRChat's yaw
            const correctedYaw = hmdYaw + vrChatYaw;

            // Calculate sine and cosine of corrected yaw
            const cosCorrectedYaw = Math.cos(correctedYaw);
            const sinCorrectedYaw = Math.sin(correctedYaw);

            // Rotate X and Z using the corrected yaw
            const rotatedX = transformedX * cosCorrectedYaw - transformedZ * sinCorrectedYaw;
            const rotatedZ = transformedX * sinCorrectedYaw + transformedZ * cosCorrectedYaw;

            // Construct the updated transformation matrix
            const matrix: OpenVR.HmdMatrix34 = {
                m: [
                    [cosCorrectedYaw, 0, sinCorrectedYaw, rotatedX],
                    [0, 1, 0, -transformedY + 2.9],
                    [-sinCorrectedYaw, 0, cosCorrectedYaw, -rotatedZ]
                ]
            };

            CustomLogger.log("default", "Overlay Transformation Matrix: ", matrix);

            // Apply the updated matrix to the overlay
            setOverlayTransformAbsolute(matrix);
        }

        //#region quat math ver
        /*
        //quaternion math ver sadly not any better
        if (state.vrc != "") {
            interface coord {
                [key: string]: number;
            }

            // Get the HMD position and orientation (pose)
            const hmdPose = await Postman.PostMessage({
                address: { fm: state.id, to: state.hmd },
                type: "GETHMDPOSITION",
                payload: null,
            }, true) as OpenVR.TrackedDevicePose;

            // Extract the 3x3 rotation matrix from the HMD pose
            const hmdMatrix = hmdPose.mDeviceToAbsoluteTracking.m;

            // Convert HMD rotation matrix to quaternion
            const hmdQuaternion = matrixToQuaternion(hmdMatrix);

            // Get the VRChat coordinate data
            const coordinate = await Postman.PostMessage({
                address: { fm: state.id, to: state.vrc },
                type: "GETCOORDINATE",
                payload: null,
            }, true) as coord;

            if (coordinate[PositionX] !== undefined) lastKnownPosition.x = coordinate[PositionX];
            if (coordinate[PositionY] !== undefined) lastKnownPosition.y = coordinate[PositionY];
            if (coordinate[PositionZ] !== undefined) lastKnownPosition.z = coordinate[PositionZ];
            if (coordinate[RotationY] !== undefined) lastKnownRotation.y = coordinate[RotationY];

            // Transform VRChat coordinates
            const transformedX = transformCoordinate(lastKnownPosition.x);
            const transformedY = transformCoordinate(lastKnownPosition.y);
            const transformedZ = 0 - transformCoordinate(lastKnownPosition.z);

            // Get the VRChat yaw (rotation around Y axis) from VRChat data
            const vrChatYaw = transformRotation(lastKnownRotation.y);

            // Create quaternion for VRChat yaw rotation
            const vrChatQuaternion = [Math.cos(vrChatYaw / 2), 0, Math.sin(vrChatYaw / 2), 0];

            // Combine HMD quaternion with VRChat quaternion
            const combinedQuaternion = multiplyQuaternions(hmdQuaternion, vrChatQuaternion);

            // Extract only the yaw component from the combined quaternion
            const yawOnlyQuaternion = [combinedQuaternion[0], 0, combinedQuaternion[2], 0];
            normalizeQuaternion(yawOnlyQuaternion);

            // Convert yaw-only quaternion back to rotation matrix
            const rotationMatrix = quaternionToMatrix(yawOnlyQuaternion);

            // Apply rotation to position
            const rotatedPosition = [
                rotationMatrix[0][0] * transformedX + rotationMatrix[0][2] * transformedZ,
                -transformedY + 2.9,
                rotationMatrix[2][0] * transformedX + rotationMatrix[2][2] * transformedZ
            ];

            // Construct the updated transformation matrix
            const matrix: OpenVR.HmdMatrix34 = {
                m: [
                    [rotationMatrix[0][0], 0, rotationMatrix[0][2], rotatedPosition[0]],
                    [0, 1, 0, rotatedPosition[1]],
                    [rotationMatrix[2][0], 0, rotationMatrix[2][2], rotatedPosition[2]]
                ]
            };

            CustomLogger.log("default", "Overlay Transformation Matrix: ", matrix);

            // Apply the updated matrix to the overlay
            setOverlayTransformAbsolute(matrix);
        }
        */
        //#endregion



        await wait(1)




    }

}



//#region Helper functions for quaternion operations

function matrixToQuaternion(m: number[][]): number[] {
    const trace = m[0][0] + m[1][1] + m[2][2];
    let q: number[] = [0, 0, 0, 0];

    if (trace > 0) {
        const s = 0.5 / Math.sqrt(trace + 1.0);
        q[0] = 0.25 / s;
        q[1] = (m[2][1] - m[1][2]) * s;
        q[2] = (m[0][2] - m[2][0]) * s;
        q[3] = (m[1][0] - m[0][1]) * s;
    } else {
        if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
            const s = 2.0 * Math.sqrt(1.0 + m[0][0] - m[1][1] - m[2][2]);
            q[0] = (m[2][1] - m[1][2]) / s;
            q[1] = 0.25 * s;
            q[2] = (m[0][1] + m[1][0]) / s;
            q[3] = (m[0][2] + m[2][0]) / s;
        } else if (m[1][1] > m[2][2]) {
            const s = 2.0 * Math.sqrt(1.0 + m[1][1] - m[0][0] - m[2][2]);
            q[0] = (m[0][2] - m[2][0]) / s;
            q[1] = (m[0][1] + m[1][0]) / s;
            q[2] = 0.25 * s;
            q[3] = (m[1][2] + m[2][1]) / s;
        } else {
            const s = 2.0 * Math.sqrt(1.0 + m[2][2] - m[0][0] - m[1][1]);
            q[0] = (m[1][0] - m[0][1]) / s;
            q[1] = (m[0][2] + m[2][0]) / s;
            q[2] = (m[1][2] + m[2][1]) / s;
            q[3] = 0.25 * s;
        }
    }

    return q;
}

function multiplyQuaternions(a: number[], b: number[]): number[] {
    return [
        a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
        a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
        a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
        a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]
    ];
}

function normalizeQuaternion(q: number[]): void {
    const length = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    q[0] /= length;
    q[1] /= length;
    q[2] /= length;
    q[3] /= length;
}

function quaternionToMatrix(q: number[]): number[][] {
    const x = q[1], y = q[2], z = q[3], w = q[0];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;

    return [
        [1 - (yy + zz), xy - wz, xz + wy],
        [xy + wz, 1 - (xx + zz), yz - wx],
        [xz - wy, yz + wx, 1 - (xx + yy)]
    ];
}
//#endregion




/* async function syncloop() {
    CustomLogger.log("default", "syncloop started");
    while (true) {


        const m34 = GetOverlayTransformAbsolute();
        Postman.PostMessage({
            address: { fm: state.id, to: state.addressBook },
            type: "SETOVERLAYLOCATION",
            payload: m34,
        });
        await wait(10);
    }
}
 */


new Postman(worker, functions, state);

OnMessage((message) => {
    Postman.runFunctions(message);
});
