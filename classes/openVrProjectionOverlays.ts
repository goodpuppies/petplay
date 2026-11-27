/**
 * The scene as two OpenVR **projection overlays**, one per eye
 * (`IVROverlay::SetOverlayTransformProjection`, `VROverlayTransform_Projection`).
 *
 * The stereo panorama is head-locked: the world is baked into it with the HMD pose predicted a
 * whole frame ahead, and the compositor shows it glued to the head. Any prediction error, and any
 * frame that reaches the compositor late, moves every window, toolbar and laser with the head —
 * the constant slight judder that world-locked overlays (the desktop mirrors, WayVR, XSOverlay)
 * never have. A projection overlay instead tells the compositor which eye pose and frustum the
 * texture was rendered from, so it reprojects the texture to the pose it actually displays, the
 * same way it treats a scene application's eye buffers.
 */
import { FLIP_OVERLAY_Y } from "./overlayTextureFlip.ts";
import { playspaceFrame } from "./playspaceFrame.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import {
  createOpenVrOverlayWithCleanup,
  releaseAndDestroyOpenVrOverlay,
} from "./openVrOverlayTexture.ts";

/** Knobs for the conventions that are easiest to confirm in the headset; live-editable. */
export type ProjectionOverlayConventions = {
  /** `VROverlayProjection_t` top/bottom as `GetProjectionRaw` reports them: up is negative. */
  yDownTangents: boolean;
  /** Sample the texture with v flipped (`TextureBounds` vMin=1, vMax=0). */
  flipV: boolean;
};

export const DEFAULT_PROJECTION_OVERLAY_CONVENTIONS: ProjectionOverlayConventions = {
  yDownTangents: true,
  flipV: false,
};

export type ProjectionOverlayEye = {
  /** GL texture name of this eye's render target. */
  texture: number;
  /** Column-major world-to-eye view matrix the texture was rendered with (world = standing space). */
  viewMatrix: ArrayLike<number>;
  /** Column-major projection matrix the texture was rendered with. */
  projectionMatrix: ArrayLike<number>;
};

type EyeOverlay = {
  eye: OpenVR.Eye;
  handle: OpenVR.OverlayHandle;
  texture: number;
  textureStructPtr: Deno.PointerValue<OpenVR.Texture>;
  textureView: DataView<ArrayBuffer>;
};

export class OpenVrProjectionOverlays {
  private readonly overlayClass: OpenVR.IVROverlay;
  private eyes: EyeOverlay[] = [];
  private visible = false;
  private appliedFlipV: boolean | null = null;
  private readonly transform = new Float32Array(12);
  private readonly transformPtr = Deno.UnsafePointer.of(this.transform) as Deno.PointerValue<
    OpenVR.HmdMatrix34
  >;
  private readonly projection = new Float32Array(4);
  private readonly projectionPtr = Deno.UnsafePointer.of(this.projection) as Deno.PointerValue<
    OpenVR.OverlayProjection
  >;
  private readonly bounds = new Float32Array(4);
  private readonly boundsPtr = Deno.UnsafePointer.of(this.bounds) as Deno.PointerValue<
    OpenVR.TextureBounds
  >;
  /** Wall ms of the last present's calls, for judging how wide a compositor race window is. */
  readonly lastTimings = { transformMs: 0, textureMs: 0, totalMs: 0 };
  readonly conventions: ProjectionOverlayConventions = {
    ...DEFAULT_PROJECTION_OVERLAY_CONVENTIONS,
  };

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

  initialize(options: { key: string; name: string; sortOrder?: number; staleKeys?: string[] }) {
    if (this.eyes.length > 0) {
      return;
    }
    const sides: [OpenVR.Eye, string][] = [
      [OpenVR.Eye.Eye_Left, "left"],
      [OpenVR.Eye.Eye_Right, "right"],
    ];
    for (const [eye, side] of sides) {
      const key = `${options.key}.${side}`;
      const handle = createOpenVrOverlayWithCleanup(
        this.overlayClass,
        key,
        `${options.name} (${side} eye)`,
        { staleKeys: (options.staleKeys ?? []).map((k) => `${k}.${side}`) },
      );
      this.check(
        this.overlayClass.SetOverlaySortOrder(handle, options.sortOrder ?? 0),
        "SetOverlaySortOrder",
      );
      this.check(
        this.overlayClass.SetOverlayFlag(
          handle,
          OpenVR.OverlayFlags.VROverlayFlags_IsPremultiplied,
          true,
        ),
        "SetOverlayFlag(IsPremultiplied=true)",
      );
      const [textureStructPtr, textureView] = createStruct<OpenVR.Texture>(
        {
          handle: 0n,
          eType: OpenVR.TextureType.TextureType_OpenGL,
          eColorSpace: OpenVR.ColorSpace.ColorSpace_Auto,
        },
        OpenVR.TextureStruct,
      );
      this.eyes.push({ eye, handle, texture: 0, textureStructPtr, textureView });
    }
  }

  /**
   * Hand the compositor this frame's eye textures with the exact poses and frusta they were
   * rendered from. Returns false when a texture was rejected (the caller rebuilds its targets).
   */
  present(left: ProjectionOverlayEye, right: ProjectionOverlayEye): boolean {
    if (this.eyes.length !== 2) {
      throw new Error("projection overlays not initialized");
    }
    const flipV = this.conventions.flipV !== FLIP_OVERLAY_Y;
    if (this.appliedFlipV !== flipV) {
      this.bounds.set(flipV ? [0, 1, 1, 0] : [0, 0, 1, 1]);
      for (const eye of this.eyes) {
        this.check(
          this.overlayClass.SetOverlayTextureBounds(eye.handle, this.boundsPtr),
          "SetOverlayTextureBounds",
        );
      }
      this.appliedFlipV = flipV;
    }
    const pairs = [[this.eyes[0], left], [this.eyes[1], right]] as const;
    const t0 = performance.now();
    let transformMs = 0;
    let textureMs = 0;
    const setTransform = (overlay: EyeOverlay, source: ProjectionOverlayEye) => {
      const start = performance.now();
      writeEyeFromTracking(source.viewMatrix, this.transform);
      playspaceFrame.viewRows34ToUniverse(this.transform);
      writeProjectionTangents(
        source.projectionMatrix,
        this.conventions.yDownTangents,
        this.projection,
      );
      this.check(
        this.overlayClass.SetOverlayTransformProjection(
          overlay.handle,
          playspaceFrame.universe,
          this.transformPtr,
          this.projectionPtr,
          overlay.eye,
        ),
        "SetOverlayTransformProjection",
      );
      transformMs += performance.now() - start;
    };
    const setTexture = (overlay: EyeOverlay, source: ProjectionOverlayEye): boolean => {
      const start = performance.now();
      if (overlay.texture !== source.texture) {
        // `Texture_t.handle` is the first field (a void* holding the GL name).
        overlay.textureView.setBigUint64(0, BigInt(source.texture), true);
        overlay.texture = source.texture;
      }
      const error = this.overlayClass.SetOverlayTexture(overlay.handle, overlay.textureStructPtr);
      textureMs += performance.now() - start;
      if (error === OpenVR.OverlayError.VROverlayError_InvalidTexture) {
        return false;
      }
      this.check(error, "SetOverlayTexture");
      return true;
    };
    // Textures first, then both transforms back to back, so the eyes' poses change together.
    for (const [overlay, source] of pairs) if (!setTexture(overlay, source)) return false;
    for (const [overlay, source] of pairs) setTransform(overlay, source);
    this.lastTimings.transformMs = transformMs;
    this.lastTimings.textureMs = textureMs;
    this.lastTimings.totalMs = performance.now() - t0;
    if (!this.visible) {
      for (const eye of this.eyes) {
        this.check(this.overlayClass.ShowOverlay(eye.handle), "ShowOverlay");
      }
      this.visible = true;
    }
    return true;
  }

  /** Process-local handles for the native presenter; never sent through IPC. */
  getHandles(): readonly [bigint, bigint] {
    if (this.eyes.length !== 2) throw new Error("projection overlays not initialized");
    return [this.eyes[0].handle, this.eyes[1].handle];
  }

  /**
   * Apply texture bounds once for pre-bound DMA-BUF overlays. OpenGL renders bottom-up while
   * Vulkan/DMA-BUF samples top-down, so DMA-BUF overlays invert V relative to `TextureType_OpenGL`.
   */
  applyTextureBounds(invertVForDmabuf = false) {
    if (this.eyes.length !== 2) throw new Error("projection overlays not initialized");
    const flipV = (this.conventions.flipV !== FLIP_OVERLAY_Y) !== invertVForDmabuf;
    this.bounds.set(flipV ? [0, 1, 1, 0] : [0, 0, 1, 1]);
    for (const eye of this.eyes) {
      this.check(
        this.overlayClass.SetOverlayTextureBounds(eye.handle, this.boundsPtr),
        "SetOverlayTextureBounds",
      );
    }
    this.appliedFlipV = flipV;
  }

  hide() {
    if (!this.visible) {
      return;
    }
    for (const eye of this.eyes) {
      this.overlayClass.HideOverlay(eye.handle);
    }
    this.visible = false;
  }

  isVisible(): boolean {
    return this.visible;
  }

  cleanup() {
    for (const eye of this.eyes) {
      releaseAndDestroyOpenVrOverlay(this.overlayClass, eye.handle);
    }
    this.eyes = [];
    this.visible = false;
    this.appliedFlipV = null;
  }

  private check(error: OpenVR.OverlayError, operation: string) {
    if (error !== OpenVR.OverlayError.VROverlayError_None) {
      throw new Error(`${operation} failed: ${OpenVR.OverlayError[error]}`);
    }
  }
}

/**
 * The column-major world-to-eye view matrix as the row-major 3x4 `SetOverlayTransformProjection`
 * takes. Despite reading like an overlay pose, the compositor wants the view matrix itself
 * (tracking origin -> eye); handing it the eye pose made the scene swim against head motion.
 */
export function writeEyeFromTracking(view: ArrayLike<number>, out: Float32Array): Float32Array {
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      out[row * 4 + col] = view[col * 4 + row];
    }
  }
  return out;
}

/**
 * `VROverlayProjection_t` (left, right, top, bottom tangents of the half angles) from a
 * column-major GL projection matrix.
 */
export function writeProjectionTangents(
  projection: ArrayLike<number>,
  yDown: boolean,
  out: Float32Array,
): Float32Array {
  const sx = projection[0], ox = projection[8];
  const sy = projection[5], oy = projection[9];
  const left = (ox - 1) / sx;
  const right = (ox + 1) / sx;
  const bottom = (oy - 1) / sy;
  const top = (oy + 1) / sy;
  out[0] = left;
  out[1] = right;
  out[2] = yDown ? -top : top;
  out[3] = yDown ? -bottom : bottom;
  return out;
}
