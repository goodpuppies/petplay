/**
 * Pointer input from a view that owns its own camera (the browser scene viewer; later the raylib
 * desktop preview). The view sends ordinary pointer events plus the exact camera it drew the
 * frame with; this poses a per-view camera from that and feeds the same pmndrs
 * `forwardHtmlEvents` bridge the local raylib window uses. Picking therefore matches what the
 * user saw, whatever the view's camera, and every view shares one interaction path in the scene.
 */
import * as THREE from "three";
import { forwardHtmlEvents } from "@pmndrs/pointer-events";
import { type DesktopPointerMessage, DesktopRemotePointer } from "./desktopRemotePointer.ts";
import { installSyntheticDomEventPolyfills, SyntheticCanvas } from "./desktopPointerSurface.ts";

/** The camera a view drew with: world matrix and projection, column-major. */
export type ViewCamera = { matrixWorld: number[]; projection: number[] };

export type ViewPointerMessage = DesktopPointerMessage & { camera: ViewCamera };

const VIEWPORT = "scene-view";

export function isViewCamera(value: unknown): value is ViewCamera {
  const c = value as ViewCamera | null;
  return c != null && typeof c === "object" &&
    [c.matrixWorld, c.projection].every((m) =>
      Array.isArray(m) && m.length === 16 && m.every((v) => Number.isFinite(v))
    );
}

export function createViewRemotePointer(scene: THREE.Object3D, label: string) {
  installSyntheticDomEventPolyfills();
  const surface = new SyntheticCanvas(1000, 1000, `[${label}]`);
  const camera = new THREE.PerspectiveCamera();
  camera.matrixAutoUpdate = false;
  const bridge = forwardHtmlEvents(surface as never, () => camera, scene as THREE.Scene, {
    batchEvents: false,
    intersectEveryFrame: true,
  });
  const input = new DesktopRemotePointer(surface, VIEWPORT);
  let destroyed = false;

  const pose = (view: ViewCamera) => {
    camera.matrix.fromArray(view.matrixWorld);
    camera.matrixWorld.copy(camera.matrix);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    camera.projectionMatrix.fromArray(view.projection);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  };

  return {
    receive(value: unknown): void {
      if (destroyed) return;
      const message = value as ViewPointerMessage | null;
      if (!message || typeof message !== "object" || !isViewCamera(message.camera)) {
        throw Error("Invalid view pointer message");
      }
      pose(message.camera);
      input.receive({ ...message, viewport: VIEWPORT });
      bridge.update();
    },
    /** Once per scene frame: keeps hover current while the pointer rests and the scene moves. */
    update(): void {
      if (!destroyed) bridge.update();
    },
    cancel(): void {
      input.cancel();
    },
    destroy(): void {
      if (destroyed) return;
      input.cancel();
      bridge.destroy();
      destroyed = true;
    },
  };
}

export type ViewRemotePointer = ReturnType<typeof createViewRemotePointer>;
