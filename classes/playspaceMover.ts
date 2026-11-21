/**
 * Space move: hold the left stick click and drag the SteamVR playspace with your hand.
 *
 * Rewrites the live standing zero pose (`IVRChaperoneSetup`) the way WayVR's OpenVR mover does
 * (`wayvr/src/backend/openvr/playspace.rs`), so every game follows the hand. PetPlay itself works
 * in {@link playspaceFrame}, which this anchors at attach, so its own displays and menus travel
 * with the user instead of the world.
 *
 * The drag follows the hand's raw-tracking position since the click, not a per-frame delta of
 * standing poses, so it does not depend on when SteamVR applies each commit. The collision
 * bounds are counter-moved so the guardian stays on the real walls.
 */
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { pulseHand } from "./environment/haptics.ts";
import { invertRigid, multiply, playspaceFrame } from "./playspaceFrame.ts";

/** Floats per `HmdQuad_t`: four `HmdVector3_t` corners. */
const QUAD_FLOATS = 12;
/** A hand cannot move this far (m²) between frames; WayVR's guard against tracking glitches. */
const MAX_STEP_SQ = 1000;

/** The mover of this worker's XR session, for UI in the same worker. */
let activeMover: PlayspaceMover | null = null;

/** Space move's reset, from the wrist menu. `false` when space move is unavailable. */
export function resetPlayspace(): boolean {
  if (!activeMover) return false;
  activeMover.reset();
  return true;
}

/**
 * Re-anchor {@link playspaceFrame} to SteamVR's current standing zero pose after a tracking
 * universe change (e.g. SteamLink reconnect). Ignored during or right after a SpaceDrag commit.
 */
export function reanchorPlayspaceFrame(): boolean {
  if (!activeMover) return false;
  return activeMover.reanchor();
}

type Drag = {
  /** Live standing zero pose at the click (column-major). */
  start: Float32Array;
  /** Hand position in raw tracking at the click. */
  hand: [number, number, number];
  last: [number, number, number];
  /** Live collision bounds at the click (standing coordinates of `start`). */
  bounds: Float32Array | null;
};

export class PlayspaceMover {
  private readonly setup: OpenVR.IVRChaperoneSetup;
  /** Row-major 3×4 scratch, the `HmdMatrix34_t` layout. */
  private readonly rows = new Float32Array(12);
  private readonly rowsPtr = Deno.UnsafePointer.of(this.rows) as Deno.PointerValue<
    OpenVR.HmdMatrix34
  >;
  private readonly zero = new Float32Array(16);
  private readonly boundsXform = new Float32Array(16);
  private readonly inverse = new Float32Array(16);
  private drag: Drag | null = null;
  private lastCommittedAt = 0;

  /** `null` when the runtime has no chaperone interface or no standing zero pose. */
  static tryCreate(pointer: number | bigint | null | undefined): PlayspaceMover | null {
    if (pointer == null) return null;
    const ptr = Deno.UnsafePointer.create(typeof pointer === "bigint" ? pointer : BigInt(pointer));
    if (!ptr) return null;
    const mover = new PlayspaceMover(new OpenVR.IVRChaperoneSetup(ptr));
    const anchor = mover.readZeroPose();
    if (!anchor) {
      LogChannel.log("webxrv2", "[space move] no standing zero pose; staying in Standing");
      return null;
    }
    playspaceFrame.setAnchor(anchor);
    activeMover = mover;
    LogChannel.log(
      "webxrv2",
      `[space move] anchored at standing zero (${anchor[12].toFixed(3)}, ${
        anchor[13].toFixed(3)
      }, ${anchor[14].toFixed(3)})`,
    );
    return mover;
  }

  private constructor(setup: OpenVR.IVRChaperoneSetup) {
    this.setup = setup;
  }

  get dragging(): boolean {
    return this.drag != null;
  }

  /**
   * Once per frame, after input. `leftHand` is the left controller position in PetPlay's frame,
   * `null` when it is not tracked (an active drag pauses rather than ends).
   */
  update(held: boolean, leftHand: ArrayLike<number> | null): void {
    if (!held) {
      if (this.drag) {
        this.drag = null;
        pulseHand("left", "click");
        LogChannel.log("webxrv2", "[space move] end drag");
      }
      return;
    }
    if (!leftHand) return;
    const raw = this.handToRaw(leftHand);
    if (!this.drag) {
      const start = this.readZeroPose();
      if (!start) return;
      this.drag = { start, hand: raw, last: raw, bounds: this.readLiveBounds() };
      pulseHand("left", "click");
      LogChannel.log("webxrv2", "[space move] start drag");
      return;
    }
    const d = this.drag;
    const sx = raw[0] - d.last[0], sy = raw[1] - d.last[1], sz = raw[2] - d.last[2];
    if (sx * sx + sy * sy + sz * sz > MAX_STEP_SQ) return;
    d.last = raw;
    this.zero.set(d.start);
    this.zero[12] += raw[0] - d.hand[0];
    this.zero[13] += raw[1] - d.hand[1];
    this.zero[14] += raw[2] - d.hand[2];
    this.commit(this.zero, d.start, d.bounds);
  }

  /** Put the playspace back where it was when PetPlay attached. */
  reset(): void {
    this.drag = null;
    const current = this.readZeroPose();
    if (!current) return;
    this.zero.set(playspaceFrame.petplayToRaw);
    this.commit(this.zero, current, this.readLiveBounds());
    LogChannel.log("webxrv2", "[space move] reset");
  }

  /** Re-anchor to the live standing zero pose unless this mover is actively dragging. */
  reanchor(): boolean {
    if (this.drag != null || Date.now() - this.lastCommittedAt < 1500) {
      return false;
    }
    const anchor = this.readZeroPose();
    if (!anchor) return false;
    playspaceFrame.setAnchor(anchor);
    LogChannel.log(
      "webxrv2",
      `[space move] re-anchored at standing zero (${anchor[12].toFixed(3)}, ${
        anchor[13].toFixed(3)
      }, ${anchor[14].toFixed(3)})`,
    );
    return true;
  }

  /** Stop using the chaperone; PetPlay falls back to Standing. */
  dispose(): void {
    this.drag = null;
    if (activeMover === this) activeMover = null;
    playspaceFrame.setAnchor(null);
  }

  /**
   * Write `zero` as the live standing zero pose. `bounds` were in the standing coordinates of
   * `before`; they are rewritten so each corner keeps its physical place.
   */
  private commit(zero: Float32Array, before: Float32Array, bounds: Float32Array | null): void {
    writeRows(zero, this.rows);
    this.setup.SetWorkingStandingZeroPoseToRawTrackingPose(this.rowsPtr);
    if (bounds && bounds.length > 0) {
      multiply(invertRigid(zero, this.inverse), before, this.boundsXform);
      const moved = new Float32Array(bounds.length);
      transformCornersXz(this.boundsXform, bounds, moved);
      this.setup.SetWorkingCollisionBoundsInfo(
        Deno.UnsafePointer.of(moved) as Deno.PointerValue<OpenVR.HmdQuad>,
        moved.length / QUAD_FLOATS,
      );
    }
    this.setup.CommitWorkingCopy(OpenVR.ChaperoneConfigFile.EChaperoneConfigFile_Live);
    this.lastCommittedAt = Date.now();
    playspaceFrame.setStandingZeroPose(zero);
  }

  /** The live standing zero pose, column-major. */
  private readZeroPose(): Float32Array | null {
    this.setup.RevertWorkingCopy();
    if (!this.setup.GetWorkingStandingZeroPoseToRawTrackingPose(this.rowsPtr)) return null;
    const out = new Float32Array(16);
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 4; col++) out[col * 4 + row] = this.rows[row * 4 + col];
    }
    out[15] = 1;
    return out;
  }

  private readLiveBounds(): Float32Array | null {
    const count = P.Uint32P<number>();
    this.setup.GetLiveCollisionBoundsInfo(null, count);
    const n = new Deno.UnsafePointerView(count).getUint32();
    if (n === 0) return null;
    const quads = new Float32Array(n * QUAD_FLOATS);
    const ok = this.setup.GetLiveCollisionBoundsInfo(
      Deno.UnsafePointer.of(quads) as Deno.PointerValue<OpenVR.HmdQuad>,
      count,
    );
    return ok ? quads : null;
  }

  private handToRaw(p: ArrayLike<number>): [number, number, number] {
    const m = playspaceFrame.petplayToRaw;
    return [
      m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
      m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
      m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    ];
  }
}

/** Column-major 4×4 → row-major 3×4 (`HmdMatrix34_t`). */
export function writeRows(m: ArrayLike<number>, out: Float32Array): Float32Array {
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) out[row * 4 + col] = m[col * 4 + row];
  }
  return out;
}

/**
 * Corners (xyz triples) through `m`, keeping each corner's height: SteamVR's bounds are walls
 * whose y is floor/ceiling, and a vertical drag must not stretch them. Like WayVR's.
 */
export function transformCornersXz(
  m: ArrayLike<number>,
  corners: Float32Array,
  out: Float32Array,
): Float32Array {
  for (let i = 0; i < corners.length; i += 3) {
    const x = corners[i], y = corners[i + 1], z = corners[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = y;
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}
