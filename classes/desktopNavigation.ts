/**
 * Desktop navigation: the one implementation of camera controls for every desktop view of a
 * PetPlay scene (the raylib desktop viewers, browser scene views). It is pmndrs `OrbitHandles`
 * bound to the scene's void object, so navigation only starts on empty space; anything over UI
 * is the scene's own pointer interaction, as for VR rays.
 *
 * - left drag on empty space: pan
 * - right drag, or two pointers: orbit
 * - wheel over empty space, or a two-pointer pinch: zoom
 * - drags that start inside a grab box or desktop control never navigate
 *
 * Views that share a scene (several browsers, VR rays) each pass `ownsPointer`, so a view's
 * handles only see its own pointers. It is asked about the native (DOM-side) pointer id: the
 * scene-side id is generated per forwarded pointer by pmndrs.
 */
import * as THREE from "three";
import { getVoidObject } from "@pmndrs/pointer-events";
import {
  createScreenCameraStore,
  filterForOnePointerLeftClick,
  filterForOnePointerRightClickOrTwoPointer,
  OrbitHandles,
} from "@pmndrs/handle";

export type DesktopNavigationStore = ReturnType<typeof createScreenCameraStore>;
type ScreenHandleMap = Parameters<typeof filterForOnePointerLeftClick>[0];

function startsInsideGrabBox(map: ScreenHandleMap): boolean {
  for (const entry of map.values()) {
    let object: THREE.Object3D | null = entry.initialEvent.intersection.object;
    while (object != null) {
      if (object.userData?.grabbox === true || object.userData?.desktopControl === true) return true;
      object = object.parent;
    }
  }
  return false;
}

export function filterPanOutsideGrabBox(map: ScreenHandleMap): boolean {
  return !startsInsideGrabBox(map) && filterForOnePointerLeftClick(map);
}

export function filterOrbitOutsideGrabBox(map: ScreenHandleMap): boolean {
  return !startsInsideGrabBox(map) && filterForOnePointerRightClickOrTwoPointer(map);
}

export type DesktopNavigationOptions = {
  /** Only used for the right-click context menu suppression of pmndrs' pan handle. */
  canvas: HTMLCanvasElement;
  scene: THREE.Object3D;
  /** The camera navigation moves; its fov and aspect scale the drags. */
  getCamera: () => THREE.PerspectiveCamera;
  store?: DesktopNavigationStore;
  /** Only native pointer ids this returns true for navigate. Omit when the view owns every pointer. */
  ownsPointer?: (nativePointerId: number) => boolean;
};

export type DesktopNavigation = {
  readonly store: DesktopNavigationStore;
  /** Once per frame. */
  update(deltaMs: number): void;
  /** Places the camera at `position` orbiting `target`. */
  aim(position: THREE.Vector3Tuple, target: THREE.Vector3Tuple): void;
  destroy(): void;
};

export function createDesktopNavigation(options: DesktopNavigationOptions): DesktopNavigation {
  const handles = new OrbitHandles(options.canvas, options.getCamera, options.store);
  handles.pan.filter = filterPanOutsideGrabBox;
  handles.rotate.filter = filterOrbitOutsideGrabBox;
  const unbind = handles.bind(bindTarget(options.scene, options.ownsPointer) as THREE.Scene, false);
  const store = handles.getStore();
  return {
    store,
    update: (deltaMs) => handles.update(deltaMs),
    aim(position, target) {
      store.getState().setOriginPosition(...target);
      store.getState().setCameraPosition(...position);
    },
    destroy: unbind,
  };
}

/**
 * The scene the handles bind to. pmndrs handles listen on `getVoidObject(scene)`; for a view
 * that shares the scene, that is a stand-in void whose listeners are registered on the real one
 * behind an ownership check (pmndrs events cannot be re-dispatched: `target` is a getter).
 */
function bindTarget(scene: THREE.Object3D, owns?: (pointerId: number) => boolean): THREE.Object3D {
  if (!owns) return scene;
  const key = new THREE.Object3D();
  const standIn = getVoidObject(key);
  const real = getVoidObject(scene);
  const wrapped = new Map<unknown, Map<string, (event: unknown) => void>>();
  standIn.addEventListener = ((type: string, listener: (event: unknown) => void) => {
    const byType = wrapped.get(listener) ?? new Map();
    wrapped.set(listener, byType);
    if (byType.has(type)) return;
    const filtered = (event: unknown) => {
      const native = (event as { nativeEvent?: { pointerId?: unknown } }).nativeEvent;
      if (typeof native?.pointerId === "number" && owns(native.pointerId)) listener(event);
    };
    byType.set(type, filtered);
    real.addEventListener(type as never, filtered as never);
  }) as typeof standIn.addEventListener;
  standIn.removeEventListener = ((type: string, listener: (event: unknown) => void) => {
    const filtered = wrapped.get(listener)?.get(type);
    if (!filtered) return;
    wrapped.get(listener)!.delete(type);
    real.removeEventListener(type as never, filtered as never);
  }) as typeof standIn.removeEventListener;
  return key;
}
