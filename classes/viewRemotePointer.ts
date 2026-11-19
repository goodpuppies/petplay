/**
 * A remote desktop view of the scene (a browser scene view): pointer input and navigation.
 *
 * The view sends ordinary pointer events plus the exact camera it drew the frame with. Events go
 * through the same pmndrs `forwardHtmlEvents` bridge the raylib window uses, picked with that
 * camera, so interaction matches what the user saw. Navigation is the shared
 * `desktopNavigation.ts` on a camera owned here, restricted to this view's pointers; the view
 * renders with the camera this reports back (`viewMatrix`).
 */
import * as THREE from "three";
import { forwardHtmlEvents } from "@pmndrs/pointer-events";
import { type DesktopPointerMessage, DesktopRemotePointer } from "./desktopRemotePointer.ts";
import { installSyntheticDomEventPolyfills, SyntheticCanvas } from "./desktopPointerSurface.ts";
import { createDesktopNavigation } from "./desktopNavigation.ts";

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

function isVector3(value: unknown): value is THREE.Vector3Tuple {
  return Array.isArray(value) && value.length === 3 && value.every((v) => Number.isFinite(v));
}

export function createViewRemotePointer(scene: THREE.Object3D, label: string) {
  installSyntheticDomEventPolyfills();
  const surface = new SyntheticCanvas(1000, 1000, `[${label}]`);
  // Picks with exactly what the view drew.
  const pickCamera = new THREE.PerspectiveCamera();
  pickCamera.matrixAutoUpdate = false;
  const bridge = forwardHtmlEvents(surface as never, () => pickCamera, scene as THREE.Scene, {
    batchEvents: false,
    intersectEveryFrame: true,
  });
  const input = new DesktopRemotePointer(surface, VIEWPORT);
  // Navigation state of this view; the view follows it.
  const navCamera = new THREE.PerspectiveCamera(70, 1, 0.01, 200);
  const navigation = createDesktopNavigation({
    canvas: surface as never,
    scene,
    getCamera: () => navCamera,
    ownsPointer: (id) => input.issued.has(id),
  });
  let destroyed = false;
  let lastSent = "";
  let lastUpdate = performance.now();

  const pose = (view: ViewCamera) => {
    pickCamera.matrix.fromArray(view.matrixWorld);
    pickCamera.matrixWorld.copy(pickCamera.matrix);
    pickCamera.matrixWorldInverse.copy(pickCamera.matrixWorld).invert();
    pickCamera.projectionMatrix.fromArray(view.projection);
    pickCamera.projectionMatrixInverse.copy(pickCamera.projectionMatrix).invert();
    // Navigation drags scale with the view's lens.
    const p = view.projection;
    const fov = THREE.MathUtils.radToDeg(2 * Math.atan(1 / p[5]));
    const aspect = p[5] / p[0];
    if (Math.abs(navCamera.fov - fov) > 1e-6 || Math.abs(navCamera.aspect - aspect) > 1e-6) {
      navCamera.fov = fov;
      navCamera.aspect = aspect;
      navCamera.updateProjectionMatrix();
    }
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
    /** Places this view's navigation camera (opening framing, leaving the head view). */
    aim(position: unknown, target: unknown): void {
      if (destroyed) return;
      if (!isVector3(position) || !isVector3(target)) throw Error("Invalid view aim");
      navigation.aim(position, target);
    },
    /** Once per scene frame: hover while the pointer rests, then navigation. */
    update(): void {
      if (destroyed) return;
      bridge.update();
      const now = performance.now();
      navigation.update(now - lastUpdate);
      lastUpdate = now;
    },
    /** The navigation camera's world matrix when it changed since the last call, else null. */
    takeViewMatrix(): number[] | null {
      navCamera.updateMatrixWorld();
      const matrix = navCamera.matrixWorld.toArray();
      const key = matrix.map((v) => v.toFixed(6)).join();
      if (key === lastSent) return null;
      lastSent = key;
      return matrix;
    },
    cancel(): void {
      input.cancel();
    },
    destroy(): void {
      if (destroyed) return;
      input.cancel();
      navigation.destroy();
      bridge.destroy();
      destroyed = true;
    },
  };
}

export type ViewRemotePointer = ReturnType<typeof createViewRemotePointer>;
