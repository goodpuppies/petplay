/**
 * WebXR client → synthetic OpenVR devices. A browser headset streams its head pose, controller
 * poses and gamepad state; the synthetic driver holds them as the SteamVR HMD and controllers.
 *
 * WebXR `local-floor` and the driver's raw standing space are both right-handed, y-up,
 * −z-forward metres with the origin on the floor, so poses pass through unchanged.
 */
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type XrHand = "left" | "right";
export type XrPose = { position: Vec3; rotation: Quat; velocity?: Vec3; angularVelocity?: Vec3 };
/** The driver's SETCONTROLLERINPUT payload, minus `hand`. */
export type XrHandInput = {
  trigger: number;
  grip: number;
  joystick: [number, number];
  joystickClick: boolean;
  a: boolean;
  b: boolean;
};
export type XrHandState = { pose?: XrPose; input?: XrHandInput };
export type XrFrameMessage = {
  version: 1;
  type: "xr-frame";
  sequence: number;
  head?: XrPose;
  left?: XrHandState;
  right?: XrHandState;
};
/** One eye as WebXR reports it: column-major projection and view-from-eye offset. */
export type XrViewMessage = {
  version: 1;
  type: "xr-views";
  views: { eye: XrHand; projection: number[]; position: Vec3; rotation: Quat }[];
  recommendedWidth?: number;
  recommendedHeight?: number;
};
/** Driver display-profile settings that would make the streamed eyes match this headset. */
export type SuggestedProfile = {
  fovTanLeft: number;
  fovTanRight: number;
  fovTanUp: number;
  fovTanDown: number;
  ipdMeters: number;
  renderWidth?: number;
  renderHeight?: number;
};

const finite = (value: unknown, limit: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
function vector<N extends number>(value: unknown, n: N, limit: number): number[] {
  if (!Array.isArray(value) || value.length !== n || !value.every((x) => finite(x, limit))) {
    throw Error("Invalid vector");
  }
  return value as number[];
}
function pose(value: unknown): XrPose {
  if (!value || typeof value !== "object") throw Error("Invalid pose");
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["position", "rotation", "velocity", "angularVelocity"].includes(key)) {
      throw Error(`Unknown pose field ${key}`);
    }
  }
  const rotation = vector(v.rotation, 4, 2) as Quat;
  const length = Math.hypot(...rotation);
  if (length < 0.5) throw Error("Invalid rotation");
  return {
    position: vector(v.position, 3, 100) as Vec3,
    rotation: rotation.map((x) => x / length) as Quat,
    ...(v.velocity === undefined ? {} : { velocity: vector(v.velocity, 3, 20) as Vec3 }),
    ...(v.angularVelocity === undefined
      ? {}
      : { angularVelocity: vector(v.angularVelocity, 3, 40) as Vec3 }),
  };
}
const unit = (value: unknown) => {
  if (!finite(value, 1) || value < 0) throw Error("Invalid axis");
  return value;
};
const flag = (value: unknown) => {
  if (typeof value !== "boolean") throw Error("Invalid button");
  return value;
};
function hand(value: unknown): XrHandState | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw Error("Invalid hand");
  const v = value as Record<string, unknown>;
  const out: XrHandState = {};
  if (v.pose !== undefined) out.pose = pose(v.pose);
  if (v.input !== undefined) {
    const i = v.input as Record<string, unknown>;
    if (!i || typeof i !== "object") throw Error("Invalid input");
    out.input = {
      trigger: unit(i.trigger),
      grip: unit(i.grip),
      joystick: vector(i.joystick, 2, 1) as [number, number],
      joystickClick: flag(i.joystickClick),
      a: flag(i.a),
      b: flag(i.b),
    };
  }
  return out;
}

/** Validates one browser packet. Unknown types and malformed numbers throw. */
export function parseXrMessage(value: unknown): XrFrameMessage | XrViewMessage {
  if (!value || typeof value !== "object") throw Error("Invalid XR message");
  const m = value as Record<string, unknown>;
  if (m.version !== 1) throw Error("Unsupported XR message version");
  if (m.type === "xr-frame") {
    if (!Number.isSafeInteger(m.sequence) || (m.sequence as number) < 0) {
      throw Error("Invalid sequence");
    }
    return {
      version: 1,
      type: "xr-frame",
      sequence: m.sequence as number,
      head: m.head === undefined ? undefined : pose(m.head),
      left: hand(m.left),
      right: hand(m.right),
    };
  }
  if (m.type === "xr-views") {
    if (!Array.isArray(m.views) || m.views.length !== 2) throw Error("Expected two views");
    const views = m.views.map((raw) => {
      const v = raw as Record<string, unknown>;
      if (v.eye !== "left" && v.eye !== "right") throw Error("Invalid eye");
      return {
        eye: v.eye as XrHand,
        projection: vector(v.projection, 16, 1e6),
        position: vector(v.position, 3, 1) as Vec3,
        rotation: vector(v.rotation, 4, 2) as Quat,
      };
    });
    const size = (n: unknown) =>
      n === undefined ? undefined : Number.isInteger(n) && (n as number) >= 16 &&
          (n as number) <= 8192
        ? n as number
        : (() => {
          throw Error("Invalid size");
        })();
    return {
      version: 1,
      type: "xr-views",
      views,
      recommendedWidth: size(m.recommendedWidth),
      recommendedHeight: size(m.recommendedHeight),
    };
  }
  throw Error("Unknown XR message type");
}

/**
 * Frustum tangents of a WebGL-style column-major perspective matrix (possibly off-centre).
 * Returns positive magnitudes: left = tan of the angle to the left edge, and so on.
 */
export function projectionTangents(m: number[]) {
  // x_ndc = (m0 x + m8 z) / -z → at the edges x/-z = (±1 + m8) / m0, likewise for y.
  const [a, b, c, d] = [m[0], m[5], m[8], m[9]];
  if (!(a > 0 && b > 0)) throw Error("Not a perspective projection");
  return {
    left: (1 - c) / a,
    right: (1 + c) / a,
    down: (1 - d) / b,
    up: (1 + d) / b,
  };
}

/**
 * The driver is configured with one left-eye frustum mirrored for the right eye. Use the
 * union of both eyes (after mirroring) so the stream never shows less than the headset.
 */
export function suggestProfile(views: XrViewMessage): SuggestedProfile {
  const left = views.views.find((v) => v.eye === "left")!;
  const right = views.views.find((v) => v.eye === "right")!;
  const l = projectionTangents(left.projection), r = projectionTangents(right.projection);
  const round = (n: number) => Math.round(n * 1e4) / 1e4;
  return {
    fovTanLeft: round(Math.max(l.left, r.right)),
    fovTanRight: round(Math.max(l.right, r.left)),
    fovTanUp: round(Math.max(l.up, r.up)),
    fovTanDown: round(Math.max(l.down, r.down)),
    ipdMeters: round(Math.hypot(
      right.position[0] - left.position[0],
      right.position[1] - left.position[1],
      right.position[2] - left.position[2],
    )),
    ...(views.recommendedWidth && views.recommendedHeight
      ? { renderWidth: views.recommendedWidth, renderHeight: views.recommendedHeight }
      : {}),
  };
}

type Send = (type: string, payload: unknown) => Promise<unknown>;
/**
 * Latest-wins driver writer: one request in flight; each device channel keeps only its newest
 * pending command, so a slow socket drops intermediate poses instead of queueing latency.
 */
export class XrDriverWriter {
  private pending = new Map<string, [string, unknown]>();
  private running: Promise<void> | null = null;
  private lastInput = new Map<XrHand, string>();
  failures = 0;
  lastError: string | undefined;
  constructor(private send: Send) {}
  apply(frame: XrFrameMessage): Promise<void> {
    if (frame.head) this.pending.set("head", ["SETHMDPOSE", frame.head]);
    for (const side of ["left", "right"] as const) {
      const state = frame[side];
      if (state?.pose) {
        this.pending.set(`${side}:pose`, ["SETCONTROLLERPOSE", {
          hand: side,
          position: state.pose.position,
          rotation: state.pose.rotation,
        }]);
      }
      if (state?.input) {
        const key = JSON.stringify(state.input);
        if (this.lastInput.get(side) !== key) {
          this.lastInput.set(side, key);
          this.pending.set(`${side}:input`, ["SETCONTROLLERINPUT", { hand: side, ...state.input }]);
        }
      }
    }
    return this.running ??= this.drain().finally(() => {
      this.running = null;
    });
  }
  /** Returns the head and hands to the driver's own defaults and releases all inputs. */
  async release(): Promise<void> {
    this.pending.clear();
    await this.running;
    this.lastInput.clear();
    const results = await Promise.allSettled([
      this.send("SETHMDPOSE", { clear: true }),
      ...(["left", "right"] as const).flatMap((hand) => [
        this.send("SETCONTROLLERPOSE", { hand, clear: true }),
        this.send("SETCONTROLLERINPUT", { hand }),
      ]),
    ]);
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
  }
  private async drain() {
    while (this.pending.size) {
      const [key, [type, payload]] = this.pending.entries().next().value!;
      this.pending.delete(key);
      try {
        await this.send(type, payload);
      } catch (error) {
        // A disabled device (e.g. no synthetic controllers) must not stall the head.
        this.failures++;
        this.lastError = `${type}: ${error instanceof Error ? error.message : error}`;
      }
    }
  }
}
