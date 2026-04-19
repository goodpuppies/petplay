import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";

type OverlayOptions = {
  key?: string;
  name?: string;
  widthInMeters?: number;
  distance?: number;
  mode?: "quad" | "stereo-panorama";
  sortOrder?: number;
  attachToHmd?: boolean;
};

export class OpenVrOverlayTexture {
  private readonly overlayClass: OpenVR.IVROverlay;
  private overlayHandle: OpenVR.OverlayHandle | null = null;
  private textureStructPtr: Deno.PointerValue<OpenVR.Texture> | null = null;
  private textureStructView: DataView<ArrayBuffer> | null = null;
  private boundsView: DataView<ArrayBuffer> | null = null;
  private transformView: DataView<ArrayBuffer> | null = null;

  constructor(overlayPointerNumeric: number | bigint) {
    const overlayPointer = Deno.UnsafePointer.create(
      typeof overlayPointerNumeric === "bigint"
        ? overlayPointerNumeric
        : BigInt(overlayPointerNumeric),
    );
    if (!overlayPointer) {
      throw new Error("Invalid IVROverlay pointer");
    }
    this.overlayClass = new OpenVR.IVROverlay(overlayPointer);
  }

  initialize(textureHandle: number, options: OverlayOptions = {}) {
    if (this.overlayHandle) {
      return;
    }

    const overlayHandlePtr = P.BigUint64P<OpenVR.OverlayHandle>();
    const key = options.key ?? `petplay.webxr.${crypto.randomUUID()}`;
    const name = options.name ?? "PetPlay WebXR";
    const createError = this.overlayClass.CreateOverlay(key, name, overlayHandlePtr);

    this.assertOverlayOk(createError, "CreateOverlay");

    this.overlayHandle = new Deno.UnsafePointerView(overlayHandlePtr).getBigUint64();
    const mode = options.mode ?? "quad";
    const widthInMeters = mode === "stereo-panorama"
      ? Math.max(options.widthInMeters ?? 3, 3)
      : (options.widthInMeters ?? 1.4);
    this.assertOverlayOk(
      this.overlayClass.SetOverlayWidthInMeters(
        this.overlayHandle,
        widthInMeters,
      ),
      "SetOverlayWidthInMeters",
    );
    if (mode === "stereo-panorama") {
      this.assertOverlayOk(
        this.overlayClass.SetOverlayFlag(
          this.overlayHandle,
          OpenVR.OverlayFlags.VROverlayFlags_Panorama,
          false,
        ),
        "SetOverlayFlag(Panorama=false)",
      );
      this.assertOverlayOk(
        this.overlayClass.SetOverlayFlag(
          this.overlayHandle,
          OpenVR.OverlayFlags.VROverlayFlags_StereoPanorama,
          true,
        ),
        "SetOverlayFlag(StereoPanorama=true)",
      );
      this.assertOverlayOk(
        this.overlayClass.SetOverlaySortOrder(this.overlayHandle, options.sortOrder ?? 0),
        "SetOverlaySortOrder",
      );
    }

    if (options.attachToHmd ?? true) {
      const distance = -(options.distance ?? 1);
      const transform: OpenVR.HmdMatrix34 = {
        m: [
          [1, 0, 0, 0],
          [0, 1, 0, 0],
          [0, 0, 1, distance],
        ],
      };
      const [transformPtr, transformView] = createStruct<OpenVR.HmdMatrix34>(
        transform,
        OpenVR.HmdMatrix34Struct,
      );
      this.transformView = transformView;
      this.assertOverlayOk(
        this.overlayClass.SetOverlayTransformTrackedDeviceRelative(
          this.overlayHandle,
          OpenVR.k_unTrackedDeviceIndex_Hmd,
          transformPtr,
        ),
        "SetOverlayTransformTrackedDeviceRelative",
      );
    }

    const bounds = { uMin: 0, uMax: 1, vMin: 1, vMax: 0 };
    const [boundsPtr, boundsView] = createStruct<OpenVR.TextureBounds>(
      bounds,
      OpenVR.TextureBoundsStruct,
    );
    this.boundsView = boundsView;
    this.assertOverlayOk(
      this.overlayClass.SetOverlayTextureBounds(this.overlayHandle, boundsPtr),
      "SetOverlayTextureBounds",
    );

    this.setTextureHandle(textureHandle);

    this.assertOverlayOk(this.overlayClass.ShowOverlay(this.overlayHandle), "ShowOverlay");
  }

  setTextureHandle(textureHandle: number) {
    const textureData = {
      handle: BigInt(textureHandle),
      eType: OpenVR.TextureType.TextureType_OpenGL,
      eColorSpace: OpenVR.ColorSpace.ColorSpace_Auto,
    };
    const [textureStructPtr, textureStructView] = createStruct<OpenVR.Texture>(
      textureData,
      OpenVR.TextureStruct,
    );

    this.textureStructPtr = textureStructPtr;
    this.textureStructView = textureStructView;
  }

  present() {
    if (!this.overlayHandle || !this.textureStructPtr) {
      throw new Error("OpenVR overlay not initialized");
    }

    const error = this.overlayClass.SetOverlayTexture(this.overlayHandle, this.textureStructPtr);
    if (error !== OpenVR.OverlayError.VROverlayError_None) {
      throw new Error(`SetOverlayTexture failed: ${OpenVR.OverlayError[error]}`);
    }
  }

  cleanup() {
    if (this.overlayHandle) {
      try {
        this.overlayClass.DestroyOverlay(this.overlayHandle);
      } catch {
        // Ignore OpenVR shutdown races.
      }
      this.overlayHandle = null;
    }

    this.textureStructPtr = null;
    this.textureStructView = null;
    this.boundsView = null;
    this.transformView = null;
  }

  private assertOverlayOk(error: OpenVR.OverlayError, operation: string) {
    if (error !== OpenVR.OverlayError.VROverlayError_None) {
      throw new Error(`${operation} failed: ${OpenVR.OverlayError[error]}`);
    }
  }
}
