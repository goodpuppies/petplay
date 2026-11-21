/** One feed owns one overlay; the display graph gives each feed one assigned instance. */
import * as VR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
export type RemoteDisplaySync = {
  id: string;
  hmd: VR.HmdMatrix34;
  widthMeters: number;
  crop: { x: number; y: number; width: number; height: number };
  opacity?: number;
  curvature?: number;
  deviceIndex?: number;
  rawUniverse?: boolean;
};
export class RemoteDisplayBinding {
  private overlay: VR.IVROverlay | undefined;
  private handle = 0n;
  private syncValue: RemoteDisplaySync | null = null;
  private managed = false;
  /** A display let go: hidden at once, so it never overlaps the feed that display switched to. */
  private released = false;
  private ready = false;
  private visible = false;
  private removal: ReturnType<typeof setTimeout> | undefined;
  attach(overlay: VR.IVROverlay, handle: bigint) {
    this.overlay = overlay;
    this.handle = handle;
    this.ready = false;
    this.visible = false;
    this.apply();
  }
  /** Show only where a display puts it: no default placement in front of the headset. */
  awaitDisplay() {
    this.managed = true;
    this.updateVisibility();
  }
  detach() {
    if (this.removal) clearTimeout(this.removal);
    this.removal = undefined;
    this.overlay = undefined;
    this.handle = 0n;
    this.ready = false;
    this.visible = false;
  }
  sync(value: RemoteDisplaySync) {
    if (
      !value.id || !Number.isFinite(value.widthMeters) || value.widthMeters <= 0 ||
      value.hmd?.m?.length !== 3 ||
      value.hmd.m.some((r) => r.length !== 4 || r.some((n) => !Number.isFinite(n)))
    ) throw Error("Invalid remote display pose");
    const c = value.crop;
    if (
      !c || ![c.x, c.y, c.width, c.height].every(Number.isFinite) || c.x < 0 || c.y < 0 ||
      c.width <= 0 || c.height <= 0 || c.x + c.width > 1.000001 || c.y + c.height > 1.000001
    ) throw Error("Invalid remote display crop");
    if (this.removal) clearTimeout(this.removal);
    this.removal = undefined;
    this.managed = true;
    this.released = false;
    this.syncValue = value;
    this.apply();
  }
  remove(id: string) {
    if (this.syncValue?.id !== id) return;
    if (this.removal) clearTimeout(this.removal);
    this.released = true;
    this.updateVisibility();
    // Match display host's StrictMode/unmount grace; a replacement sync cancels removal.
    this.removal = setTimeout(() => {
      this.removal = undefined;
      if (this.syncValue?.id === id) {
        this.syncValue = null;
        this.apply();
      }
    }, 250);
  }
  presented() {
    this.ready = true;
    this.updateVisibility();
  }
  private ok(error: number, operation: string) {
    if (error) throw Error(`${operation}: ${VR.OverlayError[error]}`);
  }
  private updateVisibility() {
    if (!this.overlay || !this.handle) return;
    const show = this.ready && !this.released && (!this.managed || this.syncValue !== null);
    if (show === this.visible) return;
    this.ok(
      show ? this.overlay.ShowOverlay(this.handle) : this.overlay.HideOverlay(this.handle),
      "remote display visibility",
    );
    this.visible = show;
  }
  private apply() {
    const overlay = this.overlay, value = this.syncValue;
    if (!overlay || !this.handle) return;
    if (value) {
      this.ok(
        overlay.SetOverlayWidthInMeters(this.handle, value.widthMeters),
        "remote display width",
      );
      this.ok(
        overlay.SetOverlayAlpha(this.handle, Math.max(0, Math.min(1, value.opacity ?? 1))),
        "remote display opacity",
      );
      this.ok(
        overlay.SetOverlayCurvature(this.handle, Math.max(0, Math.min(1, value.curvature ?? 0))),
        "remote display curvature",
      );
      const [, pose] = createStruct(value.hmd, VR.HmdMatrix34Struct);
      const pointer = Deno.UnsafePointer.of(pose.buffer) as Deno.PointerValue<VR.HmdMatrix34>;
      this.ok(
        value.deviceIndex == null
          ? overlay.SetOverlayTransformAbsolute(
            this.handle,
            value.rawUniverse
              ? VR.TrackingUniverseOrigin.TrackingUniverseRawAndUncalibrated
              : VR.TrackingUniverseOrigin.TrackingUniverseStanding,
            pointer,
          )
          : overlay.SetOverlayTransformTrackedDeviceRelative(
            this.handle,
            value.deviceIndex,
            pointer,
          ),
        "remote display pose",
      );
      const c = value.crop;
      const [, bounds] = createStruct({
        uMin: c.x,
        uMax: c.x + c.width,
        vMin: c.y,
        vMax: c.y + c.height,
      }, VR.TextureBoundsStruct);
      this.ok(
        overlay.SetOverlayTextureBounds(
          this.handle,
          Deno.UnsafePointer.of(bounds.buffer) as Deno.PointerValue<VR.TextureBounds>,
        ),
        "remote display crop",
      );
    }
    this.updateVisibility();
  }
}
