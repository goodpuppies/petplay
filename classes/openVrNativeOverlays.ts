/**
 * SteamVR quad overlay manager for native UI panels.
 *
 * - Sends SteamVR calls only when pose, width, texel aspect, sort order, or texture actually
 *   changed.
 * - Attaches single-device panels via `SetOverlayTransformTrackedDeviceRelative` so SteamVR tracks
 *   them at display rate.
 * - Handles platform differences cleanly: on Linux SteamVR 2.18.4, GL overlays resize in place
 *   without slot lock; on Windows SteamVR 2.18.4, `vrclient` locks an overlay slot to its first GL
 *   texture size. We try in-place update first and only fall back to size-keyed slot parking when
 *   `GetOverlayTextureSize` reports a mismatch.
 */
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import {
  createOpenVrOverlayWithCleanup,
  releaseAndDestroyOpenVrOverlay,
} from "./openVrOverlayTexture.ts";
import { withOverlayFlipY } from "./overlayTextureFlip.ts";
import { playspaceFrame } from "./playspaceFrame.ts";

export type NativeOverlayTextureInput =
  | { id: number; sharedHandle?: undefined; width: number; height: number }
  | { sharedHandle: bigint; id?: undefined; width: number; height: number };

export type NativeOverlayFrame = {
  key: string;
  /** Centre of the quad in PetPlay's frame, column-major rigid 4×4: +Z faces the viewer. */
  pose: ArrayLike<number>;
  /** Attach to a tracked device instead of placing in the room. */
  device?: { index: number; relative: ArrayLike<number> };
  widthMeters: number;
  texelAspect?: number;
  /** GL texture or zero-copy DMA-BUF/DXGI shared handle holding a new picture; omit while unchanged. */
  texture?: NativeOverlayTextureInput;
  sortOrder?: number;
};

export type NativeOverlayStatus = {
  width: number;
  presents: number;
  transforms: number;
  device?: number;
  hidden?: true;
};

type Quad = {
  handle: OpenVR.OverlayHandle;
  size: string;
  parkedAt: number;
};

type Entry = {
  quad: Quad;
  transform: Float32Array;
  transformPointer: Deno.PointerValue<OpenVR.HmdMatrix34>;
  hasTransform: boolean;
  universe: OpenVR.TrackingUniverseOrigin;
  device: number;
  texelAspect: number;
  width: number;
  sortOrder: number;
  shown: boolean;
  hiddenAt: number;
  unusedFrames: number;
  presents: number;
  transforms: number;
};

const UNUSED_FRAMES_BEFORE_PARKING = 900;
const MAX_HIDDEN_ENTRIES = 12;
const MAX_PARKED = 12;
const MAX_TOTAL_OVERLAYS = 48;
const MAX_ACQUIRE_ATTEMPTS = 12;

export class OpenVrNativeOverlays {
  private readonly overlay: OpenVR.IVROverlay;
  private readonly entries = new Map<string, Entry>();
  private readonly parked = new Map<string, Quad[]>();
  private parkedCount = 0;
  private parkSerial = 0;
  private hiddenSerial = 0;
  private created = 0;
  private readonly universePose = new Float32Array(12);
  private readonly heldSize = new Uint32Array(2);
  private readonly glBounds = createStruct<OpenVR.TextureBounds>(
    withOverlayFlipY({ uMin: 0, uMax: 1, vMin: 0, vMax: 1 }),
    OpenVR.TextureBoundsStruct,
  );
  // OpenGL FBO is bottom-up while Vulkan/DMA-BUF and D3D11/DXGI sample top-down.
  private readonly sharedBounds = createStruct<OpenVR.TextureBounds>(
    withOverlayFlipY({ uMin: 0, uMax: 1, vMin: 1, vMax: 0 }),
    OpenVR.TextureBoundsStruct,
  );
  private readonly textures = new Map<
    number,
    [Deno.PointerValue<OpenVR.Texture>, DataView<ArrayBuffer>]
  >();
  unusedFramesBeforeParking = UNUSED_FRAMES_BEFORE_PARKING;
  mismatches = 0;

  constructor(
    overlayPointer: Deno.PointerValue,
    private readonly keyPrefix: string,
    private readonly namePrefix: string,
    private readonly bindSharedOverlay?: (handle: bigint, sharedHandle: bigint) => number,
  ) {
    if (!overlayPointer) throw new Error("Invalid IVROverlay pointer");
    this.overlay = new OpenVR.IVROverlay(overlayPointer);
  }

  get count(): number {
    return this.entries.size;
  }

  get spare(): number {
    return this.parkedCount;
  }

  /** Keys of quads that have a texture and are ready to show. */
  readyKeys(): Set<string> {
    const out = new Set<string>();
    for (const [key, entry] of this.entries) {
      if (entry.presents > 0 && entry.shown) out.add(key);
    }
    return out;
  }

  /** Keys of every quad still held (including hidden ones whose textures must stay alive). */
  keys(): Set<string> {
    return new Set(this.entries.keys());
  }

  present(frame: NativeOverlayFrame): boolean {
    let entry = this.entries.get(frame.key);
    const texture = frame.texture;
    let replaced: Quad | null = null;
    let textured = false;

    if (texture) {
      const size = `${texture.width}x${texture.height}`;
      if (!entry) {
        if (this.entries.size + this.parkedCount >= MAX_TOTAL_OVERLAYS) {
          this.evictOneSpareOrHidden();
        }
        if (this.entries.size >= MAX_TOTAL_OVERLAYS) return false;
        const quad = this.acquire(size, texture, frame.key);
        textured = true;
        entry = this.createEntry(quad);
        this.entries.set(frame.key, entry);
      } else if (entry.quad.size !== size) {
        // Try updating in place first (works natively on Linux SteamVR 2.18.4 & shared textures);
        // only swap overlays if SteamVR reports it locked the slot to the old size (Windows GL).
        this.applyTexture(entry.quad.handle, texture);
        const held = texture.sharedHandle !== undefined ? size : this.sizeHeld(entry.quad.handle);
        if (held == null || held === size) {
          entry.quad.size = size;
          textured = true;
        } else {
          this.mismatches++;
          const quad = this.acquire(size, texture, frame.key);
          textured = true;
          replaced = entry.quad;
          entry.quad = quad;
          entry.hasTransform = false;
          entry.device = -1;
          entry.width = -1;
          entry.texelAspect = -1;
          entry.sortOrder = -1;
          entry.shown = false;
        }
      }
    }

    if (!entry) return false;
    const handle = entry.quad.handle;
    try {
      if (Math.abs(entry.width - frame.widthMeters) > 1e-5) {
        this.check(
          this.overlay.SetOverlayWidthInMeters(handle, frame.widthMeters),
          "SetOverlayWidthInMeters",
        );
        entry.width = frame.widthMeters;
      }
      const sortOrder = frame.sortOrder ?? 0;
      if (entry.sortOrder !== sortOrder) {
        this.check(this.overlay.SetOverlaySortOrder(handle, sortOrder), "SetOverlaySortOrder");
        entry.sortOrder = sortOrder;
      }
      if (frame.device) this.setDeviceTransform(entry, frame.device.index, frame.device.relative);
      else this.setTransform(entry, frame.pose);

      const texelAspect = frame.texelAspect ?? 1;
      if (Math.abs(texelAspect - entry.texelAspect) > 0.001 * Math.abs(entry.texelAspect)) {
        this.check(
          this.overlay.SetOverlayTexelAspect(handle, texelAspect),
          "SetOverlayTexelAspect",
        );
        entry.texelAspect = texelAspect;
      }
      if (texture) {
        if (!textured) {
          this.applyTexture(handle, texture);
        }
        entry.presents++;
      }
      entry.unusedFrames = 0;
      entry.hiddenAt = 0;
      if (!entry.shown && entry.presents > 0) {
        this.check(this.overlay.ShowOverlay(handle), "ShowOverlay");
        entry.shown = true;
      }
      return entry.shown;
    } finally {
      if (replaced) {
        this.overlay.HideOverlay(replaced.handle);
        this.park(replaced);
        this.trimParked();
      }
    }
  }

  retain(keep: ReadonlySet<string>): void {
    const hidden: Array<[string, Entry]> = [];
    for (const [key, entry] of this.entries) {
      if (keep.has(key)) continue;
      if (entry.shown) {
        this.overlay.HideOverlay(entry.quad.handle);
        entry.shown = false;
        entry.hiddenAt = ++this.hiddenSerial;
      }
      entry.unusedFrames++;
      if (entry.unusedFrames > this.unusedFramesBeforeParking) {
        this.entries.delete(key);
        this.park(entry.quad);
      } else {
        hidden.push([key, entry]);
      }
    }
    // Evict oldest hidden entries cleanly by FIFO `hiddenAt` serial (handles ties on same frame).
    if (hidden.length > MAX_HIDDEN_ENTRIES) {
      hidden.sort((a, b) => a[1].hiddenAt - b[1].hiddenAt);
      const drop = hidden.length - MAX_HIDDEN_ENTRIES;
      for (let i = 0; i < drop; i++) {
        const [key, entry] = hidden[i]!;
        this.entries.delete(key);
        this.park(entry.quad);
      }
    }
    this.trimParked();
  }

  cleanup(): void {
    const quads: Quad[] = [];
    for (const entry of this.entries.values()) quads.push(entry.quad);
    for (const list of this.parked.values()) for (const quad of list) quads.push(quad);
    this.entries.clear();
    this.parked.clear();
    this.parkedCount = 0;
    this.textures.clear();
    if (quads.length === 0) return;
    for (const quad of quads) {
      try {
        this.overlay.HideOverlay(quad.handle);
        this.overlay.ClearOverlayTexture(quad.handle);
      } catch { /* shutting down */ }
    }
    try {
      this.overlay.WaitFrameSync(100);
    } catch { /* shutting down */ }
    for (const quad of quads) {
      try {
        this.overlay.DestroyOverlay(quad.handle);
      } catch { /* shutting down */ }
    }
  }

  status(): Record<string, NativeOverlayStatus> {
    const out: Record<string, NativeOverlayStatus> = {};
    for (const [key, entry] of this.entries) {
      out[key] = {
        width: entry.width,
        presents: entry.presents,
        transforms: entry.transforms,
        ...(entry.unusedFrames > 0 ? { hidden: true } : {}),
        ...(entry.device >= 0 ? { device: entry.device } : {}),
      };
    }
    return out;
  }

  private createEntry(quad: Quad): Entry {
    const transform = new Float32Array(12);
    return {
      quad,
      transform,
      transformPointer: Deno.UnsafePointer.of(transform) as Deno.PointerValue<OpenVR.HmdMatrix34>,
      hasTransform: false,
      universe: playspaceFrame.universe,
      device: -1,
      texelAspect: -1,
      width: -1,
      sortOrder: -1,
      shown: false,
      hiddenAt: 0,
      unusedFrames: 0,
      presents: 0,
      transforms: 0,
    };
  }

  private evictOneSpareOrHidden(): void {
    if (this.parkedCount > 0) {
      this.destroyOldestParked();
      return;
    }
    let oldestKey: string | null = null;
    let oldestSerial = Infinity;
    for (const [key, entry] of this.entries) {
      if (!entry.shown && entry.hiddenAt > 0 && entry.hiddenAt < oldestSerial) {
        oldestSerial = entry.hiddenAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const entry = this.entries.get(oldestKey)!;
      this.entries.delete(oldestKey);
      this.overlay.ClearOverlayTexture(entry.quad.handle);
      this.overlay.DestroyOverlay(entry.quad.handle);
    }
  }

  private applyTexture(handle: OpenVR.OverlayHandle, texture: NativeOverlayTextureInput): void {
    const bounds = texture.sharedHandle !== undefined ? this.sharedBounds[0] : this.glBounds[0];
    this.check(this.overlay.SetOverlayTextureBounds(handle, bounds), "SetOverlayTextureBounds");
    if (texture.sharedHandle !== undefined) {
      if (!this.bindSharedOverlay) {
        throw new Error("Shared-texture native overlay submitted without bindSharedOverlay");
      }
      const err = this.bindSharedOverlay(handle, texture.sharedHandle);
      if (err !== 0) {
        throw new Error(`bindDmabufOverlay failed: ${OpenVR.OverlayError[err] ?? err}`);
      }
    } else {
      this.check(
        this.overlay.SetOverlayTexture(handle, this.textureStruct(texture.id)),
        "SetOverlayTexture",
      );
    }
  }

  private acquire(size: string, texture: NativeOverlayTextureInput, key: string): Quad {
    const mismatched: Quad[] = [];
    try {
      for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
        const quad = this.unpark(size) ?? this.create();
        try {
          this.applyTexture(quad.handle, texture);
        } catch (error) {
          releaseAndDestroyOpenVrOverlay(this.overlay, quad.handle);
          throw error;
        }
        const held = texture.sharedHandle !== undefined ? size : this.sizeHeld(quad.handle);
        if (held == null || held === size) {
          quad.size = size;
          this.overlay.SetOverlayName(quad.handle, `${this.namePrefix} (${key})`);
          return quad;
        }
        this.mismatches++;
        quad.size = held;
        mismatched.push(quad);
      }
      throw new Error(`SteamVR has no overlay slot available for a ${size} picture`);
    } finally {
      for (const quad of mismatched) this.park(quad);
      this.trimParked();
    }
  }

  private sizeHeld(handle: OpenVR.OverlayHandle): string | null {
    const size = this.heldSize;
    size[0] = size[1] = 0;
    const error = this.overlay.GetOverlayTextureSize(
      handle,
      Deno.UnsafePointer.of(size.subarray(0, 1)) as Deno.PointerValue<number>,
      Deno.UnsafePointer.of(size.subarray(1, 2)) as Deno.PointerValue<number>,
    );
    if (error !== OpenVR.OverlayError.VROverlayError_None || size[0] === 0 || size[1] === 0) {
      return null;
    }
    return `${size[0]}x${size[1]}`;
  }

  private unpark(size: string): Quad | null {
    const quad = this.parked.get(size)?.pop();
    if (!quad) return null;
    this.parkedCount--;
    return quad;
  }

  private park(quad: Quad): void {
    quad.parkedAt = ++this.parkSerial;
    const list = this.parked.get(quad.size);
    if (list) list.push(quad);
    else this.parked.set(quad.size, [quad]);
    this.parkedCount++;
  }

  private destroyOldestParked(): void {
    let oldest: Quad | null = null;
    for (const list of this.parked.values()) {
      if (list.length > 0 && (!oldest || list[0]!.parkedAt < oldest.parkedAt)) {
        oldest = list[0]!;
      }
    }
    if (!oldest) return;
    const list = this.parked.get(oldest.size)!;
    list.shift();
    if (list.length === 0) this.parked.delete(oldest.size);
    this.parkedCount--;
    this.overlay.ClearOverlayTexture(oldest.handle);
    this.overlay.DestroyOverlay(oldest.handle);
  }

  private trimParked(): void {
    while (this.parkedCount > MAX_PARKED) this.destroyOldestParked();
  }

  private create(): Quad {
    const overlayKey = `${this.keyPrefix}.quad${this.created++}`;
    const handle = createOpenVrOverlayWithCleanup(this.overlay, overlayKey, this.namePrefix);
    try {
      this.check(
        this.overlay.SetOverlayTextureBounds(handle, this.glBounds[0]),
        "SetOverlayTextureBounds",
      );
      this.check(
        this.overlay.SetOverlayFlag(
          handle,
          OpenVR.OverlayFlags.VROverlayFlags_IsPremultiplied,
          true,
        ),
        "SetOverlayFlag(IsPremultiplied=true)",
      );
    } catch (error) {
      releaseAndDestroyOpenVrOverlay(this.overlay, handle);
      throw error;
    }
    return { handle, size: "", parkedAt: 0 };
  }

  private textureStruct(texture: number): Deno.PointerValue<OpenVR.Texture> {
    if (!Number.isInteger(texture) || texture <= 0) {
      throw new Error(`Invalid OpenGL texture handle: ${texture}`);
    }
    let struct = this.textures.get(texture);
    if (!struct) {
      if (this.textures.size >= 512) this.textures.clear();
      struct = createStruct<OpenVR.Texture>({
        handle: BigInt(texture),
        eType: OpenVR.TextureType.TextureType_OpenGL,
        eColorSpace: OpenVR.ColorSpace.ColorSpace_Auto,
      }, OpenVR.TextureStruct);
      this.textures.set(texture, struct);
    }
    return struct[0];
  }

  private setTransform(entry: Entry, pose: ArrayLike<number>): void {
    const rows = this.universePose;
    const universe = playspaceFrame.universe;
    playspaceFrame.poseColumnMajorToRows34(pose, rows);
    let changed = !entry.hasTransform || entry.device >= 0 || entry.universe !== universe;
    for (let i = 0; i < 12 && !changed; i++) {
      if (Math.abs(rows[i]! - entry.transform[i]!) > 1e-6) changed = true;
    }
    if (!changed) return;
    entry.transform.set(rows);
    this.check(
      this.overlay.SetOverlayTransformAbsolute(entry.quad.handle, universe, entry.transformPointer),
      "SetOverlayTransformAbsolute",
    );
    entry.hasTransform = true;
    entry.universe = universe;
    entry.device = -1;
    entry.transforms++;
  }

  private setDeviceTransform(entry: Entry, device: number, relative: ArrayLike<number>): void {
    const rows = this.universePose;
    for (let column = 0; column < 4; column++) {
      for (let row = 0; row < 3; row++) rows[row * 4 + column] = Number(relative[column * 4 + row]);
    }
    let changed = !entry.hasTransform || entry.device !== device;
    for (let i = 0; i < 12 && !changed; i++) {
      if (Math.abs(rows[i]! - entry.transform[i]!) > 1e-6) changed = true;
    }
    if (!changed) return;
    entry.transform.set(rows);
    this.check(
      this.overlay.SetOverlayTransformTrackedDeviceRelative(
        entry.quad.handle,
        device,
        entry.transformPointer,
      ),
      "SetOverlayTransformTrackedDeviceRelative",
    );
    entry.hasTransform = true;
    entry.device = device;
    entry.transforms++;
  }

  private check(error: OpenVR.OverlayError, operation: string): void {
    if (error !== OpenVR.OverlayError.VROverlayError_None) {
      throw new Error(`${operation} failed: ${OpenVR.OverlayError[error]}`);
    }
  }
}
