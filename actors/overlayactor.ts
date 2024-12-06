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

// A SteamVR overlay
type State = {
    id: string;
    db: Record<string, unknown>;
    overlayClass: OpenVR.IVROverlay | null;
    overlayHandle: OpenVR.OverlayHandle;
    overlayerror: OpenVR.OverlayError;
    OverlayTransform: OpenVR.HmdMatrix34 | null;
    vrSystem: OpenVR.IVRSystem | null; // Add vrSystem to state
    [key: string]: unknown;
};

const state: State & BaseState = {
    id: "",
    db: {},
    name: "overlay1",
    socket: null,
    sync: false,
    overlayClass: null,
    OverlayTransform: null,
    numbah: 0,
    addressBook: new Set(),
    overlayHandle: 0n,
    TrackingUniverseOriginPTR: null,
    overlayerror: OpenVR.OverlayError.VROverlayError_None,
    vrSystem: null, // Initialize as null
};

let lastNonOverlayMessageTime = 0;
const smoothingWindow: OpenVR.HmdMatrix34[] = [];
const smoothingWindowSize = 10;

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
    STARTOVERLAY: (payload, _address) => {
        mainX(payload.name, payload.texture, payload.sync);
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
    SETOVERLAYLOCATION: (payload, address) => {
        const addr = address as MessageAddressReal;
        const currentTime = Date.now();

        if (!addr.fm.startsWith("overlay")) {
            lastNonOverlayMessageTime = currentTime;
        } else if (currentTime - lastNonOverlayMessageTime < 100) {
            return;
        }

        const transform = payload as OpenVR.HmdMatrix34;
        if (state.sync == false) {
            CustomLogger.log("syncloop", "set transform ");
        }
        addTransformToSmoothingWindow(transform);
        const smoothedTransform = getSmoothedTransform();
        setOverlayTransformAbsolute(smoothedTransform);
    },
    INITOPENVR: (payload) => {
        const ptrn = payload;
        const systemPtr = Deno.UnsafePointer.create(ptrn);  // Recreate the pointer
        state.vrSystem = new OpenVR.IVRSystem(systemPtr);   // Create the OpenVR instance
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

function addTransformToSmoothingWindow(transform: OpenVR.HmdMatrix34) {
    if (smoothingWindow.length >= smoothingWindowSize) {
        smoothingWindow.shift();
    }
    smoothingWindow.push(transform);
}

function getSmoothedTransform(): OpenVR.HmdMatrix34 {
    const smoothedTransform: OpenVR.HmdMatrix34 = {
        m: [
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0]
        ]
    };

    for (const transform of smoothingWindow) {
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 4; j++) {
                smoothedTransform.m[i][j] += transform.m[i][j];
            }
        }
    }

    const windowSize = smoothingWindow.length;
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 4; j++) {
            smoothedTransform.m[i][j] /= windowSize;
        }
    }

    return smoothedTransform;
}

async function mainX(overlaymame: string, overlaytexture: string, sync: boolean) {
    state.sync = sync;

    //#region overlay
    const overlay = state.overlayClass as OpenVR.IVROverlay;
    const overlayHandlePTR = P.BigUint64P<OpenVR.OverlayHandle>();
    const error = overlay.CreateOverlay(overlaymame, overlaymame, overlayHandlePTR);
    const overlayHandle = new Deno.UnsafePointerView(overlayHandlePTR).getBigUint64();
    state.overlayHandle = overlayHandle;

    CustomLogger.log("actor", `Overlay created with handle: ${overlayHandle}`);

    const imgpath = Deno.realPathSync(overlaytexture);
    overlay.SetOverlayFromFile(overlayHandle, imgpath);
    overlay.SetOverlayWidthInMeters(overlayHandle, 0.2);
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
    //#endregion

    await wait(7000);

    if (sync) {
        syncloop();
    }
}

async function syncloop() {
    CustomLogger.log("default", "syncloop started");
    while (true) {
        const m34 = GetOverlayTransformAbsolute();
        state.addressBook.forEach((address) => {
            Postman.PostMessage({
                address: { fm: state.id, to: address },
                type: "SETOVERLAYLOCATION",
                payload: m34,
            });
        });

        await wait(50);
    }
}

new Postman(worker, functions, state);

OnMessage((message) => {
    Postman.runFunctions(message);
});
