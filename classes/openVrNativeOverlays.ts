/**
 * The SteamVR side of native overlays (`docs/NATIVE_OVERLAYS.md`): one quad overlay per key, placed
 * in the room by SteamVR itself. A quad's transform is absolute, so the compositor redraws it for
 * the newest head pose at display rate however rarely this process updates it. That is what holds
 * a panel still while the head moves, unlike the head-locked panorama.
 *
 * Calls reach SteamVR only when something changed: a panel that neither moves nor changes its
 * picture costs nothing per frame.
 *
 * **A SteamVR overlay only ever shows textures of one size.** Measured on SteamVR 2.18 with OpenGL
 * textures (`tests/native_overlays/steamvr_handle_probe.ts`): an overlay's picture keeps the size
 * of the first texture it was given. A texture of another size is accepted without an error, but
 * one at least as large both ways is cut down to its lower-left corner of the old size, and one
 * smaller either way is not taken at all: the overlay keeps its last picture. Nothing resets that
 * (`ClearOverlayTexture`, `SetOverlayRaw`, hiding), and destroying the overlay does not either:
 * the size belongs to the overlay's slot (the low half of its handle), and the next overlay
 * created gets that slot and with it the size. Only the process ending clears it.
 *
 * So the overlays here are tied to a texture size. A quad whose picture changes size moves to
 * another overlay; an overlay no quad needs is parked, hidden, for the next quad with a picture of
 * its size. And because a slot may have been used before (by a destroyed overlay of ours or of
 * anything else in the process), SteamVR is asked what it holds right after an overlay's first
 * texture (`GetOverlayTextureSize` answers at once): an overlay that turns out to belong to
 * another size is parked under that size and the next one is tried.
 */
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { releaseAndDestroyOpenVrOverlay } from "./openVrOverlayTexture.ts";
import { withOverlayFlipY } from "./overlayTextureFlip.ts";
import { playspaceFrame } from "./playspaceFrame.ts";

export type NativeOverlayFrame = {
  key: string;
  /** Centre of the quad in PetPlay's frame, column-major rigid 4×4: +Z faces the viewer. */
  pose: ArrayLike<number>;
  /**
   * Attach the quad to a tracked device instead: `relative` is its centre in the device's own
   * frame. SteamVR then composes it with its newest pose of that device at display rate, so a
   * wrist menu moves with the hand and a head-locked card with the head, without waiting for
   * this process. `pose` is ignored while this is set.
   */
  device?: { index: number; relative: ArrayLike<number> };
  widthMeters: number;
  /**
   * Width over height of a texel on the quad, when not 1. For a stereo quad it is that of one
   * eye's picture.
   */
  texelAspect?: number;
  /** GL texture holding a new picture, and its size; leave out while the picture is unchanged. */
  texture?: { id: number; width: number; height: number };
  /** The texture holds the left eye's image in its left half and the right eye's in its right. */
  stereo?: boolean;
  /**
   * SteamVR draws overlays of a higher sort order over lower ones, and those of the same order
   * far to near. Panels are 0 like the desktop screens, the head-locked image is 1.
   */
  sortOrder?: number;
};

/**
 * How SteamVR derives the height of a side-by-side quad from its texture, which is twice as wide
 * as one eye's picture: `halved` = from one eye's half, so the quad has the picture's shape as it
 * is; `full` = from the whole texture, so the quad comes out half as tall and needs a texel aspect
 * of 0.5 to get its shape back.
 *
 * OpenVR does not say which, and SteamVR cannot be asked: `ComputeOverlayIntersection` follows
 * the overlay's mouse scale, not what is drawn (it reports a square for every quad left at the
 * default), and the compositor's eye mirror is not available to an OpenGL client here. So it is a
 * setting, to be judged by eye in the headset (Settings → Debug → Stereo Quad Shape). On SteamVR
 * 2.18.4 `halved` is the one that looks right.
 */
export type StereoSizing = "halved" | "full";

export type NativeOverlayStatus = {
  width: number;
  /** Pictures handed to SteamVR so far. */
  presents: number;
  /** Times SteamVR was told where the quad is: 1 for a quad that stays put or rides a device. */
  transforms: number;
  /** Tracked device the quad is attached to; absent while it is placed in the room. */
  device?: number;
  /** Out of the scene for now: hidden, kept with its picture for when it comes back. */
  hidden?: true;
  stereo?: true;
};

/** One SteamVR overlay, and the only texture size it shows. */
type Quad = {
  handle: OpenVR.OverlayHandle;
  /** `width x height`; empty until its first texture. */
  size: string;
  /** Order of parking, to tell which spare has waited longest. */
  parkedAt: number;
};

type Entry = {
  quad: Quad;
  transform: Float32Array<ArrayBuffer>;
  transformPointer: Deno.PointerValue<OpenVR.HmdMatrix34>;
  hasTransform: boolean;
  universe: OpenVR.TrackingUniverseOrigin;
  /** Index of the tracked device the quad is attached to, or -1 while it is placed in the room. */
  device: number;
  texelAspect: number;
  width: number;
  sortOrder: number;
  shown: boolean;
  /** Frames since the quad was last wanted; 0 while it is in the scene. */
  unusedFrames: number;
  stereo: boolean;
  presents: number;
  transforms: number;
};

/** SteamVR frees an overlay key a frame after the key's owner is destroyed. */
const KEY_IN_USE_RETRIES = 4;
const KEY_RELEASE_WAIT_MS = 120;
/**
 * Frames a quad that left the scene keeps its overlay and its picture, hidden (about ten
 * seconds). A wrist menu or a toolbar comes and goes all the time: showing it again is one call.
 */
const UNUSED_FRAMES_BEFORE_PARKING = 900;
/** More hidden quads than this and the longest-unused ones give up their overlays early. */
const MAX_HIDDEN = 16;
/**
 * Spare overlays kept for their sizes. SteamVR has room for 128 overlays, all programs together,
 * so they cannot pile up for ever; beyond this the one that has waited longest is destroyed. Its
 * slot keeps its size, which the check after an overlay's first texture then finds out.
 */
const MAX_PARKED = 16;
/** Overlays tried for one picture before giving up: each try uses up a slot of another size. */
const MAX_ACQUIRE_ATTEMPTS = 48;

export class OpenVrNativeOverlays {
  private readonly overlay: OpenVR.IVROverlay;
  private readonly entries = new Map<string, Entry>();
  /** Overlays no quad uses, by the texture size they show. */
  private readonly parked = new Map<string, Quad[]>();
  private parkedCount = 0;
  private parkSerial = 0;
  private created = 0;
  private readonly universePose = new Float32Array(12);
  private readonly heldSize = new Uint32Array(2);
  // Kept referenced: createStruct backs a native pointer.
  private readonly bounds = createStruct<OpenVR.TextureBounds>(
    withOverlayFlipY({ uMin: 0, uMax: 1, vMin: 0, vMax: 1 }),
    OpenVR.TextureBoundsStruct,
  );
  /** One struct per GL texture, kept referenced: SteamVR is handed pointers into them. */
  private readonly textures = new Map<
    number,
    [Deno.PointerValue<OpenVR.Texture>, DataView<ArrayBuffer>]
  >();
  /** Frames a quad that left the scene keeps its overlay, hidden, before that is parked. */
  unusedFramesBeforeParking = UNUSED_FRAMES_BEFORE_PARKING;
  /** How SteamVR is taken to size side-by-side quads; switchable while they are shown. */
  stereoSizing: StereoSizing = "halved";
  /** Stands in for what {@link stereoSizing} says about stereo quads; `null` does not. */
  stereoTexelAspect: number | null = null;
  /** Overlays that turned out to belong to another texture size than the one they were made for. */
  mismatches = 0;

  constructor(
    overlayPointer: Deno.PointerValue,
    private readonly keyPrefix: string,
    private readonly namePrefix: string,
  ) {
    if (!overlayPointer) throw new Error("Invalid IVROverlay pointer");
    this.overlay = new OpenVR.IVROverlay(overlayPointer);
  }

  /** Quads in the scene or hidden for now. */
  get count(): number {
    return this.entries.size;
  }

  /** Overlays kept for their texture size, with no quad to show. */
  get spare(): number {
    return this.parkedCount;
  }

  /** Keys of every quad still held, hidden ones included: their pictures must be kept too. */
  keys(): Set<string> {
    return new Set(this.entries.keys());
  }

  /** The SteamVR overlay that shows quad `key` at the moment. */
  handleOf(key: string): OpenVR.OverlayHandle | null {
    return this.entries.get(key)?.quad.handle ?? null;
  }

  /** Create or update one quad. Throws on a SteamVR error; the caller decides what to fall back to. */
  present(frame: NativeOverlayFrame): void {
    let entry = this.entries.get(frame.key);
    const texture = frame.texture;
    // A picture of another size needs another overlay; the one in use is let go once that shows.
    let replaced: Quad | null = null;
    let textured = false;
    if (texture) {
      const size = `${texture.width}x${texture.height}`;
      if (!entry || entry.quad.size !== size) {
        const stereo = entry?.stereo ?? frame.stereo === true;
        const quad = this.acquire(size, texture.id, stereo, frame.key);
        textured = true;
        if (entry) {
          replaced = entry.quad;
          entry.quad = quad;
          // Nothing of the quad has been said to this overlay yet.
          entry.hasTransform = false;
          entry.device = -1;
          entry.width = -1;
          entry.texelAspect = -1;
          entry.sortOrder = -1;
          entry.shown = false;
        } else {
          entry = this.entry(quad, stereo);
          this.entries.set(frame.key, entry);
        }
      }
    }
    // Nothing to show yet: wait for the first picture.
    if (!entry) return;
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
      // A stereo quad's texture is two pictures wide; see `StereoSizing`.
      const texelAspect = (frame.texelAspect ?? 1) *
        (entry.stereo ? this.stereoTexelAspect ?? (this.stereoSizing === "full" ? 0.5 : 1) : 1);
      // A tenth of a percent is far below what shows; smaller differences are float noise.
      if (Math.abs(texelAspect - entry.texelAspect) > 0.001 * Math.abs(entry.texelAspect)) {
        this.check(
          this.overlay.SetOverlayTexelAspect(handle, texelAspect),
          "SetOverlayTexelAspect",
        );
        entry.texelAspect = texelAspect;
      }
      if (texture) {
        if (!textured) {
          this.check(
            this.overlay.SetOverlayTexture(handle, this.textureStruct(texture.id)),
            "SetOverlayTexture",
          );
        }
        entry.presents++;
      }
      entry.unusedFrames = 0;
      // First picture, or back in the scene with the picture SteamVR still has.
      if (!entry.shown && entry.presents > 0) {
        this.check(this.overlay.ShowOverlay(handle), "ShowOverlay");
        entry.shown = true;
      }
    } finally {
      if (replaced) {
        this.overlay.HideOverlay(replaced.handle);
        this.park(replaced);
        this.trimParked();
      }
    }
  }

  /**
   * Once per frame: hide every quad whose key is not in `keep`, and let go of the ones that have
   * stayed hidden for a while. A hidden quad keeps its picture and comes back with the next
   * {@link present} of its key; one that was let go is drawn anew, on any overlay of its size.
   */
  retain(keep: ReadonlySet<string>): void {
    let hidden = 0;
    for (const [key, entry] of this.entries) {
      if (keep.has(key)) continue;
      if (entry.shown) {
        // Not checked: a quad SteamVR already dropped is as hidden as it gets.
        this.overlay.HideOverlay(entry.quad.handle);
        entry.shown = false;
      }
      entry.unusedFrames++;
      hidden++;
    }
    if (hidden === 0) return;
    let limit = this.unusedFramesBeforeParking;
    if (hidden > MAX_HIDDEN) {
      // Too many: the cut-off drops to the age of the MAX_HIDDEN-th youngest.
      const ages = [...this.entries.values()].filter((entry) => entry.unusedFrames > 0)
        .map((entry) => entry.unusedFrames).sort((a, b) => a - b);
      limit = Math.min(limit, ages[MAX_HIDDEN - 1]!);
    }
    let parked = false;
    for (const [key, entry] of this.entries) {
      if (entry.unusedFrames <= limit) continue;
      this.park(entry.quad);
      this.entries.delete(key);
      parked = true;
    }
    if (parked) this.trimParked();
  }

  /** Destroy every overlay now, waiting once for SteamVR to let go of their textures. */
  cleanup(): void {
    const quads = [...this.entries.values()].map((entry) => entry.quad);
    for (const spare of this.parked.values()) quads.push(...spare);
    this.entries.clear();
    this.parked.clear();
    this.parkedCount = 0;
    if (quads.length === 0) return;
    // SteamVR may already be stopping: nothing here is worth an error.
    for (const quad of quads) {
      try {
        this.overlay.HideOverlay(quad.handle);
        this.overlay.ClearOverlayTexture(quad.handle);
      } catch { /* going away */ }
    }
    try {
      this.overlay.WaitFrameSync(100);
    } catch { /* going away */ }
    for (const quad of quads) {
      try {
        this.overlay.DestroyOverlay(quad.handle);
      } catch { /* going away */ }
    }
  }

  /** For the renderer's health readout. */
  status(): Record<string, NativeOverlayStatus> {
    const status: Record<string, NativeOverlayStatus> = {};
    for (const [key, entry] of this.entries) {
      status[key] = {
        width: entry.width,
        presents: entry.presents,
        transforms: entry.transforms,
        ...(entry.unusedFrames > 0 ? { hidden: true } : {}),
        ...(entry.device >= 0 ? { device: entry.device } : {}),
        ...(entry.stereo ? { stereo: true as const } : {}),
      };
    }
    return status;
  }

  private entry(quad: Quad, stereo: boolean): Entry {
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
      unusedFrames: 0,
      stereo,
      presents: 0,
      transforms: 0,
    };
  }

  /**
   * An overlay that shows textures of `size`, already holding the picture in `texture` and still
   * hidden: a spare one of that size, or a new one that SteamVR confirms takes it.
   */
  private acquire(size: string, texture: number, stereo: boolean, key: string): Quad {
    const struct = this.textureStruct(texture);
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
      const quad = this.unpark(size) ?? this.create();
      try {
        this.check(
          this.overlay.SetOverlayFlag(
            quad.handle,
            OpenVR.OverlayFlags.VROverlayFlags_SideBySide_Parallel,
            stereo,
          ),
          "SetOverlayFlag(SideBySide_Parallel)",
        );
        this.check(this.overlay.SetOverlayTexture(quad.handle, struct), "SetOverlayTexture");
      } catch (error) {
        releaseAndDestroyOpenVrOverlay(this.overlay, quad.handle);
        throw error;
      }
      const held = this.sizeHeld(quad.handle);
      if (held == null || held === size) {
        quad.size = size;
        // Only for whoever lists SteamVR's overlays; not worth an error.
        this.overlay.SetOverlayName(quad.handle, `${this.namePrefix} (${key})`);
        return quad;
      }
      // Its slot was used at another size before, in this process: it stays with that size.
      this.mismatches++;
      quad.size = held;
      this.park(quad);
    }
    throw new Error(`SteamVR has no overlay left for a ${size} picture`);
  }

  /** The size of the picture SteamVR holds for an overlay, or `null` when it does not say. */
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

  /** `quad` is hidden already, or was never shown. */
  private park(quad: Quad): void {
    quad.parkedAt = ++this.parkSerial;
    const spare = this.parked.get(quad.size);
    if (spare) spare.push(quad);
    else this.parked.set(quad.size, [quad]);
    this.parkedCount++;
  }

  /**
   * Never from inside {@link acquire}: an overlay destroyed there would hand its slot, with its
   * size, straight to the next one tried.
   */
  private trimParked(): void {
    while (this.parkedCount > MAX_PARKED) {
      let oldest: Quad | null = null;
      for (const spare of this.parked.values()) {
        // Each list is in parking order.
        if (spare.length > 0 && (!oldest || spare[0]!.parkedAt < oldest.parkedAt)) {
          oldest = spare[0]!;
        }
      }
      if (!oldest) return;
      const spare = this.parked.get(oldest.size)!;
      spare.shift();
      if (spare.length === 0) this.parked.delete(oldest.size);
      this.parkedCount--;
      // Hidden for a long time already, so nothing of it is on screen to wait for.
      this.overlay.ClearOverlayTexture(oldest.handle);
      this.overlay.DestroyOverlay(oldest.handle);
    }
  }

  private create(): Quad {
    const overlayKey = `${this.keyPrefix}.quad${this.created++}`;
    const handlePointer = P.BigUint64P<OpenVR.OverlayHandle>();
    let error = this.overlay.CreateOverlay(overlayKey, this.namePrefix, handlePointer);
    // A renderer that died without cleanup leaves its key behind; see OpenVrOverlayTexture.
    for (
      let attempt = 0;
      error === OpenVR.OverlayError.VROverlayError_KeyInUse && attempt < KEY_IN_USE_RETRIES;
      attempt++
    ) {
      const stalePointer = P.BigUint64P<OpenVR.OverlayHandle>();
      if (
        this.overlay.FindOverlay(overlayKey, stalePointer) ===
          OpenVR.OverlayError.VROverlayError_None
      ) {
        releaseAndDestroyOpenVrOverlay(
          this.overlay,
          new Deno.UnsafePointerView(stalePointer).getBigUint64(),
        );
      }
      this.overlay.WaitFrameSync(KEY_RELEASE_WAIT_MS);
      error = this.overlay.CreateOverlay(overlayKey, this.namePrefix, handlePointer);
    }
    this.check(error, "CreateOverlay");
    const handle = new Deno.UnsafePointerView(handlePointer).getBigUint64();
    try {
      this.check(
        this.overlay.SetOverlayTextureBounds(handle, this.bounds[0]),
        "SetOverlayTextureBounds",
      );
      // The UI is blended over a transparent target, which leaves colour multiplied by coverage.
      this.overlay.SetOverlayFlag(handle, OpenVR.OverlayFlags.VROverlayFlags_IsPremultiplied, true);
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
      // Textures are reused by size, so their numbers are few; this is only a backstop.
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

  /** `pose` (PetPlay frame, column-major) to the rows SteamVR takes, in the universe PetPlay writes in. */
  private setTransform(entry: Entry, pose: ArrayLike<number>): void {
    const rows = this.universePose;
    const universe = playspaceFrame.universe;
    const a = playspaceFrame.active ? playspaceFrame.petplayToRaw : null;
    for (let column = 0; column < 4; column++) {
      const x = Number(pose[column * 4]);
      const y = Number(pose[column * 4 + 1]);
      const z = Number(pose[column * 4 + 2]);
      const w = column === 3 ? 1 : 0;
      for (let row = 0; row < 3; row++) {
        rows[row * 4 + column] = a
          ? a[row]! * x + a[4 + row]! * y + a[8 + row]! * z + a[12 + row]! * w
          : row === 0
          ? x
          : row === 1
          ? y
          : z;
      }
    }
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

  /**
   * `relative` (column-major, the quad's centre in the device's frame) to the rows SteamVR takes.
   * It is the same in every tracking universe. While the quad rides its device this does not
   * change, apart from the float noise of deriving it from two tracked poses, so the threshold
   * is a little wider than for a pose in the room: 20 micrometres, 0.001 degrees.
   */
  private setDeviceTransform(entry: Entry, device: number, relative: ArrayLike<number>): void {
    const rows = this.universePose;
    for (let column = 0; column < 4; column++) {
      for (let row = 0; row < 3; row++) rows[row * 4 + column] = Number(relative[column * 4 + row]);
    }
    let changed = !entry.hasTransform || entry.device !== device;
    for (let i = 0; i < 12 && !changed; i++) {
      if (Math.abs(rows[i]! - entry.transform[i]!) > 2e-5) changed = true;
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
