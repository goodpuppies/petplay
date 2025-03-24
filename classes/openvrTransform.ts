import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { CustomLogger } from "./customlogger.ts";

export class OpenVRTransform {
    private overlayClass: OpenVR.IVROverlay;
    private overlayHandle: OpenVR.OverlayHandle;

    constructor(overlayClass: OpenVR.IVROverlay, overlayHandle: OpenVR.OverlayHandle) {
        this.overlayClass = overlayClass;
        this.overlayHandle = overlayHandle;
    }

    setTransformAbsolute(transform: OpenVR.HmdMatrix34) {
        const [transformPtr, _transformView] = createStruct<OpenVR.HmdMatrix34>(transform, OpenVR.HmdMatrix34Struct)
        this.overlayClass.SetOverlayTransformAbsolute(
            this.overlayHandle, 
            OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding, 
            transformPtr
        );
    }

    getTransformAbsolute(): OpenVR.HmdMatrix34 {
        const TrackingUniverseOriginPTR = P.Int32P<OpenVR.TrackingUniverseOrigin>();
        const [m34ptr, hmd34view] = createStruct<OpenVR.HmdMatrix34>(null, OpenVR.HmdMatrix34Struct)
        const error = this.overlayClass.GetOverlayTransformAbsolute(
            this.overlayHandle, 
            TrackingUniverseOriginPTR, 
            m34ptr
        );
        if (error !== OpenVR.OverlayError.VROverlayError_None) throw new Error("Failed to get overlay transform");

        return OpenVR.HmdMatrix34Struct.read(hmd34view) as OpenVR.HmdMatrix34;
    }
}
