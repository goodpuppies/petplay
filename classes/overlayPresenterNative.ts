import { IVROverlay_Version } from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { fromFileUrl } from "@std/path";
import { writeEyeFromTracking, writeProjectionTangents } from "./openVrProjectionOverlays.ts";
export type RenderCameras = {
  leftEyeViewMatrix: Float32Array;
  rightEyeViewMatrix: Float32Array;
  leftEyeProjectionMatrix: Float32Array;
  rightEyeProjectionMatrix: Float32Array;
};
const symbols = {
  pp_overlay_abi: { parameters: [], result: "u32" },
  pp_overlay_present: {
    parameters: ["pointer", "u64", "u64", "u32", "u32", "buffer", "buffer", "u32", "u32", "buffer"],
    result: "i32",
  },
  pp_overlay_present_texture: {
    parameters: ["pointer", "u64", "u32", "u32", "buffer"],
    result: "i32",
  },
  // Split phases (optional: older builds lack them and keep the blocking path).
  pp_overlay_finish: { parameters: ["buffer"], result: "i32", optional: true },
  pp_overlay_wait_blocking: {
    name: "pp_overlay_wait",
    parameters: ["pointer", "u32"],
    result: "i32",
    optional: true,
  },
  pp_overlay_publish: {
    parameters: ["pointer", "u64", "u64", "u32", "u32", "buffer", "buffer", "u32", "buffer"],
    result: "i32",
    optional: true,
  },
  pp_overlay_publish_texture: {
    parameters: ["pointer", "u64", "u32", "buffer"],
    result: "i32",
    optional: true,
  },
  // Linux DMA-BUF bank pool + visibility-flip presenter (optional).
  pp_dmabuf_bank_last_error: { parameters: [], result: "pointer", optional: true },
  pp_dmabuf_bank_create: {
    parameters: [
      "pointer",
      "u32",
      "u32",
      "u32",
      "u32",
      "buffer",
      "buffer",
      "buffer",
      "buffer",
    ],
    result: "pointer",
    optional: true,
  },
  pp_dmabuf_bank_destroy: { parameters: ["pointer"], result: "void", optional: true },
  pp_dmabuf_bank_bind_overlay: {
    parameters: ["pointer", "u64", "u64"],
    result: "i32",
    optional: true,
  },
  pp_overlay_fence_finish: { parameters: ["buffer"], result: "i32", optional: true },
  pp_overlay_set_projection: {
    parameters: ["pointer", "u64", "u64", "buffer", "buffer"],
    result: "i32",
    optional: true,
  },
  pp_overlay_flip_banks: {
    parameters: ["pointer", "u64", "u64", "u64", "u64", "buffer"],
    result: "i32",
    optional: true,
  },
} as const;

export type DmabufBankSlot = {
  fbo: number;
  colorTexture: number;
  depthRbo: number;
  sharedHandle: bigint;
};

export type DmabufBankPool = {
  readonly width: number;
  readonly height: number;
  readonly bankCount: 2 | 3;
  readonly eyeCount: 1 | 2;
  readonly slots: readonly DmabufBankSlot[];
  destroy(): void;
};
const WAIT_TIMEOUT_MS = 100;
/**
 * GL finish, the `WaitFrameSync` wait and OpenVR submission, all on the context owner's thread.
 * (Running the wait on an FFI worker thread was tried and did not reduce pacing slips.)
 */
export class OverlayPresenterNative {
  private readonly library: Deno.DynamicLibrary<typeof symbols>;
  private readonly views = new Float32Array(24);
  private readonly frusta = new Float32Array(8);
  private readonly stats = new Float64Array(6);
  private visible = false;
  constructor(private readonly table: Deno.PointerValue) {
    if (IVROverlay_Version !== "FnTable:IVROverlay_027") {
      throw new Error("Native presenter requires FnTable:IVROverlay_027");
    }
    const path = Deno.env.get("PETPLAY_OVERLAY_PRESENTER_LIBRARY") ??
      fromFileUrl(new URL("../resources/libpetplay_overlay_presenter.so", import.meta.url));
    this.library = Deno.dlopen(path, symbols);
    if (this.library.symbols.pp_overlay_abi() !== 27) {
      this.library.close();
      throw new Error("Native presenter ABI mismatch");
    }
  }
  /**
   * `beforePublish` runs after the frame-sync wait; returning false drops the frame instead of
   * submitting it late (the compositor reprojects the previous one).
   */
  present(
    handles: readonly [bigint, bigint],
    textures: { left: number; right: number },
    cameras: RenderCameras,
    beforePublish?: () => boolean,
  ) {
    writeEyeFromTracking(cameras.leftEyeViewMatrix, this.views.subarray(0, 12));
    writeEyeFromTracking(cameras.rightEyeViewMatrix, this.views.subarray(12));
    writeProjectionTangents(cameras.leftEyeProjectionMatrix, true, this.frusta.subarray(0, 4));
    writeProjectionTangents(cameras.rightEyeProjectionMatrix, true, this.frusta.subarray(4));
    if (beforePublish && this.hasSplitPhases) {
      let error = this.finishAndWaitBlocking();
      if (!error && !beforePublish()) return { ...this.result(0, false), dropped: true };
      if (!error) error = this.publishProjection(handles, textures);
      return { ...this.result(error, error !== 0 && this.stats[3] > 0), dropped: false };
    }
    const error = this.library.symbols.pp_overlay_present(
      this.table,
      handles[0],
      handles[1],
      textures.left,
      textures.right,
      this.views,
      this.frusta,
      100,
      this.visible ? 0 : 1,
      this.stats,
    );
    if (!error) this.visible = true;
    return { ...this.result(error, error !== 0 && this.stats[3] > 0), dropped: false };
  }
  /** One overlay's texture through the same finish, frame-sync and publish sequence. */
  presentTexture(handle: bigint, texture: number, beforePublish?: () => boolean) {
    if (beforePublish && this.hasSplitPhases) {
      let error = this.finishAndWaitBlocking();
      if (!error && !beforePublish()) return { ...this.result(0, false), dropped: true };
      if (!error) {
        error = this.library.symbols.pp_overlay_publish_texture!(
          this.table,
          handle,
          texture,
          this.stats,
        );
      }
      return { ...this.result(error, false), dropped: false };
    }
    const error = this.library.symbols.pp_overlay_present_texture(
      this.table,
      handle,
      texture,
      100,
      this.stats,
    );
    return { ...this.result(error, false), dropped: false };
  }
  /** Whether the library exports the split phases that dropping late frames needs. */
  private get hasSplitPhases(): boolean {
    const s = this.library.symbols;
    return !!(s.pp_overlay_finish && s.pp_overlay_wait_blocking && s.pp_overlay_publish &&
      s.pp_overlay_publish_texture);
  }
  /** Whether the library exports the Linux DMA-BUF bank pool + visibility-flip path. */
  get hasDmabufBanks(): boolean {
    const s = this.library.symbols;
    return !!(s.pp_dmabuf_bank_create && s.pp_dmabuf_bank_destroy &&
      s.pp_dmabuf_bank_bind_overlay && s.pp_overlay_fence_finish &&
      s.pp_overlay_wait_blocking && s.pp_overlay_set_projection &&
      s.pp_overlay_flip_banks);
  }
  getDmabufBankLastError(): string {
    const ptr = this.library.symbols.pp_dmabuf_bank_last_error?.();
    return ptr ? new Deno.UnsafePointerView(ptr).getCString() : "";
  }
  createDmabufBankPool(
    ipcClientPtr: Deno.PointerValue,
    width: number,
    height: number,
    bankCount: 2 | 3,
    eyeCount: 1 | 2,
  ): DmabufBankPool | null {
    if (!this.hasDmabufBanks || !ipcClientPtr) return null;
    const total = bankCount * eyeCount;
    const fbos = new Uint32Array(total);
    const colorTextures = new Uint32Array(total);
    const depthRbos = new Uint32Array(total);
    const sharedHandles = new BigUint64Array(total);
    const ptr = this.library.symbols.pp_dmabuf_bank_create!(
      ipcClientPtr,
      width,
      height,
      bankCount,
      eyeCount,
      fbos,
      colorTextures,
      depthRbos,
      sharedHandles,
    );
    if (!ptr) return null;
    const slots: DmabufBankSlot[] = [];
    for (let i = 0; i < total; i++) {
      slots.push({
        fbo: fbos[i],
        colorTexture: colorTextures[i],
        depthRbo: depthRbos[i],
        sharedHandle: sharedHandles[i],
      });
    }
    let destroyed = false;
    const destroyFn = this.library.symbols.pp_dmabuf_bank_destroy!;
    return {
      width,
      height,
      bankCount,
      eyeCount,
      slots,
      destroy: () => {
        if (destroyed) return;
        destroyed = true;
        destroyFn(ptr);
      },
    };
  }
  bindDmabufOverlay(overlayHandle: bigint, sharedHandle: bigint): number {
    if (!this.library.symbols.pp_dmabuf_bank_bind_overlay) return -1;
    return this.library.symbols.pp_dmabuf_bank_bind_overlay(
      this.table,
      overlayHandle,
      sharedHandle,
    );
  }
  /**
   * Bank-flipped projection present:
   * 1. Wait for producer GPU fence on the hidden bank's DMA-BUFs.
   * 2. Update projection poses on the hidden bank (never touching the visible bank).
   * 3. Wait for `WaitFrameSync`.
   * 4. Optionally drop if late (`beforePublish() === false`).
   * 5. Flip `ShowOverlay(show)` / `HideOverlay(hide)` back-to-back in ~1 us.
   */
  presentProjectionBank(
    showHandles: readonly [bigint, bigint],
    hideHandles: readonly [bigint, bigint] | null,
    cameras: RenderCameras,
    beforePublish?: () => boolean,
  ) {
    const s = this.library.symbols;
    writeEyeFromTracking(cameras.leftEyeViewMatrix, this.views.subarray(0, 12));
    writeEyeFromTracking(cameras.rightEyeViewMatrix, this.views.subarray(12));
    writeProjectionTangents(cameras.leftEyeProjectionMatrix, true, this.frusta.subarray(0, 4));
    writeProjectionTangents(cameras.rightEyeProjectionMatrix, true, this.frusta.subarray(4));

    let error = s.pp_overlay_fence_finish!(this.stats);
    if (!error) {
      error = s.pp_overlay_set_projection!(
        this.table,
        showHandles[0],
        showHandles[1],
        this.views,
        this.frusta,
      );
      if (error) this.stats[4] = error;
    }
    if (!error) {
      const start = performance.now();
      const wait = s.pp_overlay_wait_blocking!(this.table, WAIT_TIMEOUT_MS);
      this.stats[1] = performance.now() - start;
      this.stats[5] = wait;
      if (wait) {
        this.stats[4] = wait;
        error = wait;
      }
    }
    if (!error && beforePublish && !beforePublish()) {
      return { ...this.result(0, false), dropped: true };
    }
    if (!error) {
      error = s.pp_overlay_flip_banks!(
        this.table,
        showHandles[0],
        showHandles[1],
        hideHandles ? hideHandles[0] : 0n,
        hideHandles ? hideHandles[1] : 0n,
        this.stats,
      );
    }
    return { ...this.result(error, error !== 0 && this.stats[3] > 0), dropped: false };
  }
  /**
   * Bank-flipped stereo-panorama present:
   * 1. Wait for producer GPU fence on the hidden bank's DMA-BUF.
   * 2. Optionally wait for `WaitFrameSync` (`waitForSync = true` for `panoramaPacing: "presenter"`).
   * 3. Optionally drop if late (`beforePublish() === false`).
   * 4. Flip `ShowOverlay(show)` / `HideOverlay(hide)` back-to-back in ~1 us.
   */
  presentPanoramaBank(
    showHandle: bigint,
    hideHandle: bigint | null,
    waitForSync: boolean,
    beforePublish?: () => boolean,
  ) {
    const s = this.library.symbols;
    let error = s.pp_overlay_fence_finish!(this.stats);
    if (!error && waitForSync) {
      const start = performance.now();
      const wait = s.pp_overlay_wait_blocking!(this.table, WAIT_TIMEOUT_MS);
      this.stats[1] = performance.now() - start;
      this.stats[5] = wait;
      if (wait) {
        this.stats[4] = wait;
        error = wait;
      }
    }
    if (!error && beforePublish && !beforePublish()) {
      return { ...this.result(0, false), dropped: true };
    }
    if (!error) {
      error = s.pp_overlay_flip_banks!(
        this.table,
        showHandle,
        0n,
        hideHandle ?? 0n,
        0n,
        this.stats,
      );
    }
    return { ...this.result(error, error !== 0 && this.stats[3] > 0), dropped: false };
  }
  private publishProjection(
    handles: readonly [bigint, bigint],
    textures: { left: number; right: number },
  ): number {
    const error = this.library.symbols.pp_overlay_publish!(
      this.table,
      handles[0],
      handles[1],
      textures.left,
      textures.right,
      this.views,
      this.frusta,
      this.visible ? 0 : 1,
      this.stats,
    );
    if (!error) this.visible = true;
    return error;
  }
  private finishAndWaitBlocking(): number {
    const s = this.library.symbols;
    const finished = s.pp_overlay_finish!(this.stats);
    if (finished) return finished;
    const start = performance.now();
    const wait = s.pp_overlay_wait_blocking!(this.table, WAIT_TIMEOUT_MS);
    this.stats[1] = performance.now() - start;
    this.stats[5] = wait;
    if (wait) this.stats[4] = wait;
    return wait;
  }

  private result(error: number, partial: boolean) {
    return {
      error,
      gpuFinishMs: this.stats[0],
      waitMs: this.stats[1],
      publicationMs: this.stats[2],
      completedSetters: this.stats[3],
      waitResult: this.stats[5],
      partial,
    };
  }
  /** The overlays were destroyed or hidden elsewhere; show them again on the next present. */
  resetVisibility() {
    this.visible = false;
  }
  close() {
    this.library.close();
  }
}
