import * as OpenVR from "./OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "./OpenVR_TS_Bindings_Deno/pointers.ts";
import { stringToPointer } from "./OpenVR_TS_Bindings_Deno/utils.ts";

class SimpleOverlay {
    private overlayClass: OpenVR.IVROverlay | null = null;
    private overlayHandle: OpenVR.OverlayHandle = 0n;
    private overlayError: OpenVR.OverlayError = OpenVR.OverlayError.VROverlayError_None;

    async initialize(overlayName: string, texturePath: string) {
        // Initialize OpenVR
        const initerrorptr = Deno.UnsafePointer.of<OpenVR.InitError>(new Int32Array(1))!;
        const TypeSafeINITERRPTR: OpenVR.InitErrorPTRType = initerrorptr;

        const errorX = Deno.UnsafePointer.of(new Int32Array(1))!;
        OpenVR.VR_InitInternal(errorX, OpenVR.ApplicationType.VRApplication_Overlay);
        const error = new Deno.UnsafePointerView(errorX).getInt32();
        console.log("Init error:", error);

        const overlayPtr = OpenVR.VR_GetGenericInterface(stringToPointer(OpenVR.IVROverlay_Version), TypeSafeINITERRPTR);
        this.overlayClass = new OpenVR.IVROverlay(overlayPtr);

        // Create overlay
        const overlayHandlePTR = P.BigUint64P<OpenVR.OverlayHandle>();
        this.overlayError = this.overlayClass.CreateOverlay(overlayName, overlayName, overlayHandlePTR);
        this.overlayHandle = new Deno.UnsafePointerView(overlayHandlePTR).getBigUint64();

        console.log(`Overlay created with handle: ${this.overlayHandle}`);

        const imgpath = Deno.realPathSync(texturePath);
        this.overlayClass.SetOverlayFromFile(this.overlayHandle, imgpath);
        this.overlayClass.SetOverlayWidthInMeters(this.overlayHandle,2);
        this.overlayClass.ShowOverlay(this.overlayHandle);

        // Set initial transform
        const initialTransform: OpenVR.HmdMatrix34 = {
            m: [
                [1.0, 0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0, 1.0],
                [0.0, 0.0, 1.0, -2.0]
            ]
        };
        this.setOverlayTransformAbsolute(initialTransform);

        console.log("Overlay created and shown.");
    }

    setOverlayTransformAbsolute(transform: OpenVR.HmdMatrix34) {
        if (!this.overlayClass) return;
        
        const transformBuffer = new ArrayBuffer(OpenVR.HmdMatrix34Struct.byteSize);
        const transformView = new DataView(transformBuffer);
        OpenVR.HmdMatrix34Struct.write(transform, transformView);
        const transformPtr = Deno.UnsafePointer.of<OpenVR.HmdMatrix34>(transformBuffer)!;

        this.overlayClass.SetOverlayTransformAbsolute(
            this.overlayHandle, 
            OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding, 
            transformPtr
        );
    }

    getOverlayTransformAbsolute(): OpenVR.HmdMatrix34 {
        if (!this.overlayClass) {
            throw new Error("Overlay not initialized");
        }

        const TrackingUniverseOriginPTR = P.Int32P<OpenVR.TrackingUniverseOrigin>();
        const hmd34buf = new ArrayBuffer(OpenVR.HmdMatrix34Struct.byteSize);
        const hmd34view = new DataView(hmd34buf);
        const m34ptr = Deno.UnsafePointer.of<OpenVR.HmdMatrix34>(hmd34buf)!;

        this.overlayError = this.overlayClass.GetOverlayTransformAbsolute(
            this.overlayHandle, 
            TrackingUniverseOriginPTR, 
            m34ptr
        );

        if (this.overlayError !== OpenVR.OverlayError.VROverlayError_None) {
            console.error(`Failed to get overlay transform: ${OpenVR.OverlayError[this.overlayError]}`);
            throw new Error("Failed to get overlay transform");
        }

        return OpenVR.HmdMatrix34Struct.read(hmd34view) as OpenVR.HmdMatrix34;
    }
}

// Example usage
const overlay = new SimpleOverlay();
await overlay.initialize("SimpleOverlay", "c:/GIT/petplay/resources/PetPlay.png");

// Keep the program running
console.log("Overlay is running. Press Ctrl+C to exit.");
while (true) {
    await new Promise(resolve => setTimeout(resolve, 1000));
}
