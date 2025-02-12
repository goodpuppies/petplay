import * as OpenVR from "../OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../OpenVR_TS_Bindings_Deno/pointers.ts";
import { CustomLogger } from "./customlogger.ts";

export class OpenVRTransform {
    private overlayClass: OpenVR.IVROverlay;
    private overlayHandle: OpenVR.OverlayHandle;

    constructor(overlayClass: OpenVR.IVROverlay, overlayHandle: OpenVR.OverlayHandle) {
        this.overlayClass = overlayClass;
        this.overlayHandle = overlayHandle;
    }

    setTransformAbsolute(transform: OpenVR.HmdMatrix34) {
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

    getTransformAbsolute(): OpenVR.HmdMatrix34 {
        const TrackingUniverseOriginPTR = P.Int32P<OpenVR.TrackingUniverseOrigin>();
        const hmd34size = OpenVR.HmdMatrix34Struct.byteSize;
        const hmd34buf = new ArrayBuffer(hmd34size);
        const hmd34view = new DataView(hmd34buf);
        const m34ptr = Deno.UnsafePointer.of<OpenVR.HmdMatrix34>(hmd34buf)!;

        const error = this.overlayClass.GetOverlayTransformAbsolute(
            this.overlayHandle, 
            TrackingUniverseOriginPTR, 
            m34ptr
        );

        if (error !== OpenVR.OverlayError.VROverlayError_None) {
            CustomLogger.error("actorerr", `Failed to get overlay transform: ${OpenVR.OverlayError[error]}`);
            throw new Error("Failed to get overlay transform");
        }

        return OpenVR.HmdMatrix34Struct.read(hmd34view) as OpenVR.HmdMatrix34;
    }
}
