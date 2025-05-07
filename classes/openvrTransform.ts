import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel"

/**
 * Set overlay transform in absolute coordinates
 */
export function setOverlayTransformAbsolute(
    overlay: OpenVR.IVROverlay,
    overlayHandle: OpenVR.OverlayHandle,
    transform: OpenVR.HmdMatrix34
): void {
    const [transformPtr, _transformView] = createStruct<OpenVR.HmdMatrix34>(transform, OpenVR.HmdMatrix34Struct);
    overlay.SetOverlayTransformAbsolute(
        overlayHandle,
        OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding,
        transformPtr
    );
}

/**
 * Get overlay transform in absolute coordinates
 */
export function getOverlayTransformAbsolute(
    overlay: OpenVR.IVROverlay,
    overlayHandle: OpenVR.OverlayHandle
): OpenVR.HmdMatrix34 {
    const TrackingUniverseOriginPTR = P.Int32P<OpenVR.TrackingUniverseOrigin>();
    const [m34ptr, hmd34view] = createStruct<OpenVR.HmdMatrix34>(null, OpenVR.HmdMatrix34Struct);
    const error = overlay.GetOverlayTransformAbsolute(
        overlayHandle,
        TrackingUniverseOriginPTR,
        m34ptr
    );

    if (error !== OpenVR.OverlayError.VROverlayError_None) {
        throw new Error(`Failed to get overlay transform: ${OpenVR.OverlayError[error]}`);
    }

    return OpenVR.HmdMatrix34Struct.read(hmd34view) as OpenVR.HmdMatrix34;
}