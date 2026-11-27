import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { FLIP_OVERLAY_Y } from "./overlayTextureFlip.ts";
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
  flipVertical?: boolean;
  /** Skip initial OpenGL SetOverlayTexture and ShowOverlay (for DMA-BUF bank-flipped overlays). */
  skipInitialTextureAndShow?: boolean;
  /** Keys of overlays whose owning process is gone; destroyed before creating. */
  staleKeys?: string[];
};

type OverlayTextureReleaseApi = Pick<
  OpenVR.IVROverlay,
  "HideOverlay" | "ClearOverlayTexture" | "WaitFrameSync" | "DestroyOverlay"
>;

/** SteamVR frees an overlay key a frame after the key's owner is destroyed. */
const OVERLAY_KEY_IN_USE_RETRIES = 4;
const OVERLAY_KEY_RELEASE_WAIT_MS = 120;

/**
 * Stop compositor use of an imported GL texture before its owning context is
 * destroyed. In particular, actor reloads otherwise race RADV's async import.
 */
export function releaseAndDestroyOpenVrOverlay(
  overlay: OverlayTextureReleaseApi,
  handle: OpenVR.OverlayHandle,
): void {
  try {
    overlay.HideOverlay(handle);
  } catch {
    // SteamVR may already be stopping.
  }
  try {
    overlay.ClearOverlayTexture(handle);
  } catch {
    // The overlay may never have received a texture.
  }
  try {
    overlay.WaitFrameSync(100);
  } catch {
    // SteamVR may already be stopping.
  }
  try {
    overlay.DestroyOverlay(handle);
  } catch {
    // Ignore shutdown races.
  }
}

/**
 * Create an OpenVR overlay, first clearing any `staleKeys` and retrying if `key` is still held by
 * a previous worker/process whose cleanup never ran.
 */
export function createOpenVrOverlayWithCleanup(
  overlay: OpenVR.IVROverlay,
  key: string,
  name: string,
  options: {
    staleKeys?: string[];
    retries?: number;
    releaseWaitMs?: number;
  } = {},
): OpenVR.OverlayHandle {
  const retries = options.retries ?? OVERLAY_KEY_IN_USE_RETRIES;
  const releaseWaitMs = options.releaseWaitMs ?? OVERLAY_KEY_RELEASE_WAIT_MS;

  for (const staleKey of options.staleKeys ?? []) {
    const staleHandlePtr = P.BigUint64P<OpenVR.OverlayHandle>();
    if (
      overlay.FindOverlay(staleKey, staleHandlePtr) !== OpenVR.OverlayError.VROverlayError_None
    ) {
      continue;
    }
    const staleHandle = new Deno.UnsafePointerView(staleHandlePtr).getBigUint64();
    releaseAndDestroyOpenVrOverlay(overlay, staleHandle);
    overlay.WaitFrameSync(releaseWaitMs);
  }

  const overlayHandlePtr = P.BigUint64P<OpenVR.OverlayHandle>();
  let createError = overlay.CreateOverlay(key, name, overlayHandlePtr);
  for (
    let attempt = 0;
    createError === OpenVR.OverlayError.VROverlayError_KeyInUse && attempt < retries;
    attempt++
  ) {
    const staleHandlePtr = P.BigUint64P<OpenVR.OverlayHandle>();
    if (
      overlay.FindOverlay(key, staleHandlePtr) === OpenVR.OverlayError.VROverlayError_None
    ) {
      const staleHandle = new Deno.UnsafePointerView(staleHandlePtr).getBigUint64();
      releaseAndDestroyOpenVrOverlay(overlay, staleHandle);
    }
    overlay.WaitFrameSync(releaseWaitMs);
    createError = overlay.CreateOverlay(key, name, overlayHandlePtr);
  }

  if (createError !== OpenVR.OverlayError.VROverlayError_None) {
    throw new Error(
      `OpenVR CreateOverlay(${key}) failed: ${OpenVR.OverlayError[createError] ?? createError}`,
    );
  }
  return new Deno.UnsafePointerView(overlayHandlePtr).getBigUint64();
}

export class OpenVrOverlayTexture {
  private readonly overlayClass: OpenVR.IVROverlay;
  private overlayHandle: OpenVR.OverlayHandle | null = null;
  private textureStructPtr: Deno.PointerValue<OpenVR.Texture> | null = null;
  private textureStructView: DataView<ArrayBuffer> | null = null;
  private textureHandle: number | null = null;
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

    const key = options.key ?? `petplay.webxr.${crypto.randomUUID()}`;
    const name = options.name ?? "PetPlay WebXR";
    this.overlayHandle = createOpenVrOverlayWithCleanup(this.overlayClass, key, name, {
      staleKeys: options.staleKeys,
    });
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
    this.assertOverlayOk(
      this.overlayClass.SetOverlayFlag(
        this.overlayHandle,
        OpenVR.OverlayFlags.VROverlayFlags_IsPremultiplied,
        true,
      ),
      "SetOverlayFlag(IsPremultiplied=true)",
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

    const flipVertical = (options.flipVertical ?? true) !== FLIP_OVERLAY_Y;
    const bounds = flipVertical
      ? { uMin: 0, uMax: 1, vMin: 1, vMax: 0 }
      : { uMin: 0, uMax: 1, vMin: 0, vMax: 1 };
    const [boundsPtr, boundsView] = createStruct<OpenVR.TextureBounds>(
      bounds,
      OpenVR.TextureBoundsStruct,
    );
    this.boundsView = boundsView;
    this.assertOverlayOk(
      this.overlayClass.SetOverlayTextureBounds(this.overlayHandle, boundsPtr),
      "SetOverlayTextureBounds",
    );

    if (!options.skipInitialTextureAndShow) {
      this.setTextureHandle(textureHandle);
      this.assertOverlayOk(this.overlayClass.ShowOverlay(this.overlayHandle), "ShowOverlay");
    }
  }

  /** Process-local handle, for presenting through the native presenter. */
  getHandle(): bigint {
    if (!this.overlayHandle) throw new Error("OpenVR overlay not initialized");
    return this.overlayHandle;
  }

  /** Update sort order on a live overlay (e.g. yielding behind the SteamVR dashboard). */
  setSortOrder(sortOrder: number): void {
    if (!this.overlayHandle) return;
    this.assertOverlayOk(
      this.overlayClass.SetOverlaySortOrder(this.overlayHandle, sortOrder),
      "SetOverlaySortOrder",
    );
  }

  /** Update HMD-relative Z distance on a live overlay (used as OpenVR's equal-sortOrder tie-breaker). */
  setHmdDistance(distance: number): void {
    if (!this.overlayHandle) return;
    const transform: OpenVR.HmdMatrix34 = {
      m: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, -distance],
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

  setTextureHandle(textureHandle: number) {
    if (!Number.isInteger(textureHandle) || textureHandle <= 0) {
      throw new Error(`Invalid OpenGL texture handle: ${textureHandle}`);
    }
    if (this.textureHandle === textureHandle && this.textureStructPtr) {
      return;
    }
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
    this.textureHandle = textureHandle;
  }

  present(): boolean {
    if (!this.overlayHandle || !this.textureStructPtr) {
      throw new Error("OpenVR overlay not initialized");
    }

    const error = this.overlayClass.SetOverlayTexture(this.overlayHandle, this.textureStructPtr);
    if (error === OpenVR.OverlayError.VROverlayError_InvalidTexture) {
      return false;
    }
    if (error !== OpenVR.OverlayError.VROverlayError_None) {
      throw new Error(`SetOverlayTexture failed: ${OpenVR.OverlayError[error]}`);
    }
    return true;
  }

  /**
   * `IVROverlay::IsOverlayVisible`. `null` means "cannot tell" (no handle yet, or
   * SteamVR refused the query) — callers must not treat that as invisible.
   */
  isVisible(): boolean | null {
    if (!this.overlayHandle) {
      return null;
    }
    try {
      return this.overlayClass.IsOverlayVisible(this.overlayHandle);
    } catch {
      return null;
    }
  }

  /** Re-show an overlay the compositor stopped drawing; `false` when it errors. */
  show(): boolean {
    if (!this.overlayHandle) {
      return false;
    }
    try {
      return this.overlayClass.ShowOverlay(this.overlayHandle) ===
        OpenVR.OverlayError.VROverlayError_None;
    } catch {
      return false;
    }
  }

  cleanup() {
    if (this.overlayHandle) {
      releaseAndDestroyOpenVrOverlay(this.overlayClass, this.overlayHandle);
      this.overlayHandle = null;
    }

    this.textureStructPtr = null;
    this.textureStructView = null;
    this.textureHandle = null;
    this.boundsView = null;
    this.transformView = null;
  }

  private assertOverlayOk(error: OpenVR.OverlayError, operation: string) {
    if (error !== OpenVR.OverlayError.VROverlayError_None) {
      throw new Error(`${operation} failed: ${OpenVR.OverlayError[error]}`);
    }
  }
}
