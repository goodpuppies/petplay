/**
 * Invisible SteamVR overlays that take a hand's input focus while its laser is on PetPlay UI.
 *
 * Displays are real mouse-input overlays, so SteamVR itself keeps clicks on them from reaching
 * the game. The keyboard, menus and toolbars are drawn into PetPlay's one big overlay and have
 * no such overlay. One transparent mouse-input quad per hand sits at that hand's laser hit
 * (`gameInputBlocking.focusTarget`), facing the controller, so SteamVR's laser meets it and the
 * game stops seeing that controller, as with displays. It hides when the laser leaves the UI.
 */
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { type FocusTarget, gameInputBlocking } from "./environment/gameInputBlocking.ts";
import { playspaceFrame } from "./playspaceFrame.ts";

type Hand = "left" | "right";
const HANDS: readonly Hand[] = ["left", "right"];
/** Wide enough that SteamVR's ray, from a slightly different origin than PetPlay's, lands on it. */
const FOCUS_OVERLAY_WIDTH_M = 0.5;

type FocusOverlay = { handle: OpenVR.OverlayHandle; shown: boolean };

/**
 * Overlay pose rows facing `origin` from `point`: +Z (the overlay's front) points back along the
 * laser, so the quad is square to the ray whatever the UI's own orientation. Row-major 3×4.
 */
export function focusOverlayRows(target: FocusTarget, out: Float32Array): boolean {
  const [px, py, pz] = target.point;
  let zx = target.origin[0] - px, zy = target.origin[1] - py, zz = target.origin[2] - pz;
  const zl = Math.hypot(zx, zy, zz);
  if (zl < 1e-6) return false;
  zx /= zl, zy /= zl, zz /= zl;
  // x = up × z; for a vertical ray, use forward as "up".
  let ux = 0, uy = 1, uz = 0;
  if (Math.abs(zy) > 0.99) uy = 0, uz = -1;
  let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
  const xl = Math.hypot(xx, xy, xz);
  xx /= xl, xy /= xl, xz /= xl;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  out.set([xx, yx, zx, px, xy, yy, zy, py, xz, yz, zz, pz]);
  return true;
}

export class InputFocusOverlays {
  private readonly overlay: OpenVR.IVROverlay;
  private readonly hands = new Map<Hand, FocusOverlay>();
  private readonly rows = new Float32Array(12);
  private readonly rowsPtr = Deno.UnsafePointer.of(this.rows) as Deno.PointerValue<
    OpenVR.HmdMatrix34
  >;
  private readonly matrixRows: number[][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  private failed = false;

  constructor(overlayPointer: number | bigint, private readonly keyBase: string) {
    const ptr = Deno.UnsafePointer.create(
      typeof overlayPointer === "bigint" ? overlayPointer : BigInt(overlayPointer),
    );
    if (!ptr) throw new Error("Invalid IVROverlay pointer");
    this.overlay = new OpenVR.IVROverlay(ptr);
  }

  /** Once per frame, after `updateActionState` has refreshed the blocking targets. */
  sync(): void {
    if (this.failed) return;
    try {
      for (const hand of HANDS) this.syncHand(hand, gameInputBlocking.focusTarget(hand));
    } catch (error) {
      // Input focus is a nicety: never let it take the frame loop down.
      this.failed = true;
      LogChannel.log("webxrv2", `[input focus] disabled: ${error}`);
    }
  }

  dispose(): void {
    for (const entry of this.hands.values()) {
      try {
        this.overlay.DestroyOverlay(entry.handle);
      } catch {
        // SteamVR may already be stopping.
      }
    }
    this.hands.clear();
  }

  private syncHand(hand: Hand, target: FocusTarget | null): void {
    let entry = this.hands.get(hand);
    if (!target || !focusOverlayRows(target, this.rows)) {
      if (entry?.shown) {
        this.overlay.HideOverlay(entry.handle);
        entry.shown = false;
      }
      return;
    }
    entry ??= this.create(hand);
    if (playspaceFrame.active) {
      const m = this.matrixRows;
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) m[r][c] = this.rows[r * 4 + c];
      playspaceFrame.poseRowsToUniverse(m);
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) this.rows[r * 4 + c] = m[r][c];
    }
    this.overlay.SetOverlayTransformAbsolute(entry.handle, playspaceFrame.universe, this.rowsPtr);
    if (!entry.shown) {
      this.overlay.ShowOverlay(entry.handle);
      entry.shown = true;
    }
  }

  private create(hand: Hand): FocusOverlay {
    const key = `${this.keyBase}.${hand}`;
    const handlePtr = P.BigUint64P<OpenVR.OverlayHandle>();
    // A webxr reload leaves this process's overlay behind: take it over.
    let error = this.overlay.FindOverlay(key, handlePtr);
    if (error !== OpenVR.OverlayError.VROverlayError_None) {
      error = this.overlay.CreateOverlay(key, `PetPlay input focus (${hand})`, handlePtr);
      if (error !== OpenVR.OverlayError.VROverlayError_None) {
        throw new Error(`CreateOverlay(${key}): ${OpenVR.OverlayError[error]}`);
      }
    }
    const handle = new Deno.UnsafePointerView(handlePtr).getBigUint64();
    // One fully transparent texel: nothing to see, but SteamVR still hit-tests the quad.
    const texel = new Uint8Array(4);
    this.overlay.SetOverlayRaw(handle, Deno.UnsafePointer.of(texel), 1, 1, 4);
    this.overlay.SetOverlayWidthInMeters(handle, FOCUS_OVERLAY_WIDTH_M);
    this.overlay.SetOverlayInputMethod(
      handle,
      OpenVR.OverlayInputMethod.VROverlayInputMethod_Mouse,
    );
    this.overlay.SetOverlayFlag(
      handle,
      OpenVR.OverlayFlags.VROverlayFlags_HideLaserIntersection,
      true,
    );
    const entry = { handle, shown: false };
    this.hands.set(hand, entry);
    LogChannel.log("webxrv2", `[input focus] ${hand} overlay ready (${key})`);
    return entry;
  }
}

let active: InputFocusOverlays | null = null;

/** The webxr actor's overlay lifetime: `null` disposes. */
export function configureInputFocusOverlays(
  overlayPointer: number | bigint | null,
  keyBase?: string,
): void {
  active?.dispose();
  active = overlayPointer == null || !keyBase
    ? null
    : new InputFocusOverlays(overlayPointer, keyBase);
}

export function syncInputFocusOverlays(): void {
  active?.sync();
}
