import * as THREE from "three";
import { PostalService } from "../submodules/stageforge/mod.ts";
import { attachOpenVrDriverProxy } from "./petplayOpenVrDriverProxy.ts";
export type ControllerHand = "left" | "right";
export type ControllerPose = {
  position: [number, number, number];
  rotation: [number, number, number, number];
};
export type ControllerSnapshot = {
  hands: {
    role: ControllerHand;
    active: boolean;
    held: boolean;
    pose: {
      vecPosition: [number, number, number];
      qRotation: { x: number; y: number; z: number; w: number };
    };
  }[];
};
/** Convert world-space gizmo output to the driver's raw tracking space. Scaling is unsupported. */
export function controllerTrackingPose(
  target: THREE.Object3D,
  trackingToWorld = new THREE.Matrix4(),
): ControllerPose {
  target.updateWorldMatrix(true, false);
  const transform = trackingToWorld.clone().invert().multiply(target.matrixWorld);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  transform.decompose(p, q, s);
  const x = new THREE.Vector3().setFromMatrixColumn(transform, 0);
  const y = new THREE.Vector3().setFromMatrixColumn(transform, 1);
  const z = new THREE.Vector3().setFromMatrixColumn(transform, 2);
  if (
    ![...transform.elements, ...s.toArray()].every(Number.isFinite) ||
    s.toArray().some((n) => Math.abs(n - 1) > 1e-5) ||
    Math.abs(transform.determinant() - 1) > 1e-5 ||
    Math.max(Math.abs(x.dot(y)), Math.abs(y.dot(z)), Math.abs(z.dot(x))) > 1e-5
  ) throw Error("Controller transforms must be rigid");
  q.normalize();
  return { position: p.toArray(), rotation: q.toArray() };
}
/** One request in flight, with only the latest pending pose per hand. */
export class ControllerPoseWriter {
  private pending = new Map<ControllerHand, ControllerPose>();
  private running: Promise<void> | null = null;
  constructor(private send: (hand: ControllerHand, pose: ControllerPose) => Promise<unknown>) {}
  set(hand: ControllerHand, pose: ControllerPose): Promise<void> {
    this.pending.set(hand, pose);
    return this.running ??= this.drain().finally(() => {
      this.running = null;
    });
  }
  private async drain() {
    while (this.pending.size) {
      const [hand, pose] = this.pending.entries().next().value!;
      this.pending.delete(hand);
      try {
        await this.send(hand, pose);
      } catch (error) {
        this.pending.clear();
        throw error;
      }
    }
  }
}
export async function connectControllerControl(socket: string) {
  const postal = new PostalService();
  const id = await attachOpenVrDriverProxy(postal, socket);
  const send = async <T>(type: string, payload: unknown = null): Promise<T> => {
    const value = await postal.PostMessage({ target: id, type, payload }, true) as T & {
      __actorError?: { message: string };
    };
    if (value?.__actorError) throw Error(value.__actorError.message);
    return value;
  };
  const writer = new ControllerPoseWriter((hand, pose) =>
    send("SETCONTROLLERPOSE", { hand, ...pose })
  );
  return {
    state: () => send<ControllerSnapshot>("GETCONTROLLERSTATE"),
    writer,
    close: () => postal.murder(id),
  };
}
