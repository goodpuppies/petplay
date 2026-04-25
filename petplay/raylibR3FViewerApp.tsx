import React, { createContext, useContext } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber/webgpu";
import { OrbitHandles } from "@react-three/handle";
import raylib from "../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import { forwardHtmlEvents } from "@pmndrs/pointer-events";
import { createScreenCameraStore, filterForOnePointerLeftClick } from "@pmndrs/handle";
import { createR3FExtractionRoot, RaythreeExtractor } from "../submodules/raythree/src/lib.ts";
import { extractWebXRRaythreeUi } from "../classes/webxrRaythreeUi.ts";
import { WebXRRaythreeRaylibRenderer } from "../classes/webxrRaythreeRaylibRenderer.ts";
import {
  releaseWindowsSyntheticKeyboardState,
  releaseWindowsSyntheticKeyboardStateWithKm,
} from "../classes/environment/keyboard/win32SystemKeyboard.ts";

export type RaylibR3FViewerControlsStore = ReturnType<typeof createScreenCameraStore>;

export type RaylibR3FViewerSceneProps = {
  controlsStore: RaylibR3FViewerControlsStore;
  logPrefix: string;
};

export type RaylibR3FViewerAim = {
  aimOrigin: [number, number, number];
  cameraPosition: [number, number, number];
  fov: number;
};

const ViewerAimContext = createContext<RaylibR3FViewerAim | null>(null);

function useViewerAim(): RaylibR3FViewerAim {
  const v = useContext(ViewerAimContext);
  if (v == null) {
    throw new Error("raylibR3FViewer: useViewerAim must be used under ViewerAimProvider");
  }
  return v;
}

export function ViewerAimProvider(
  { value, children }: { value: RaylibR3FViewerAim; children: React.ReactNode },
) {
  return <ViewerAimContext.Provider value={value}>{children}</ViewerAimContext.Provider>;
}

export function logRaylibR3FViewerDependencies(logPrefix: string) {
  console.log(`${logPrefix} Dependency versions check:`);
  console.log(`${logPrefix} - THREE version:`, THREE.REVISION);
  try {
    console.log(
      `${logPrefix} - filterForOnePointerLeftClick from @pmndrs/handle:`,
      typeof filterForOnePointerLeftClick,
    );
    console.log(
      `${logPrefix} - createScreenCameraStore from @pmndrs/handle:`,
      typeof createScreenCameraStore,
    );
  } catch (e) {
    console.error(`${logPrefix} - Error inspecting @pmndrs/handle exports:`, e);
  }
}

function getDefaultRaylibPath(): string {
  const url = new URL("../resources/raylib.dll", import.meta.url);
  return Deno.build.os === "windows"
    ? decodeURIComponent(url.pathname.replace(/^\/+/, ""))
    : decodeURIComponent(url.pathname);
}

function getNumberArg(name: string, fallback: number): number {
  const raw = Deno.args.find((arg) => arg.startsWith(`--${name}=`))?.split("=", 2)[1];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getStringArg(name: string, fallback: string): string {
  return Deno.args.find((arg) => arg.startsWith(`--${name}=`))?.split("=", 2)[1] ?? fallback;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type SyntheticEventInit = {
  type: string;
  pointerId?: number;
  pointerType?: string;
  button?: number;
  buttons?: number;
  clientX?: number;
  clientY?: number;
  movementX?: number;
  movementY?: number;
  deltaY?: number;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
};

type Listener = (event: Event) => void;

class SyntheticMouseEvent extends Event {
  pointerId: number;
  pointerType: string;
  button: number;
  buttons: number;
  clientX: number;
  clientY: number;
  movementX: number;
  movementY: number;
  deltaY: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  override currentTarget: EventTarget | null = null;
  override target: EventTarget | null = null;

  constructor(init: SyntheticEventInit) {
    super(init.type, { bubbles: true, cancelable: true });
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
    this.button = init.button ?? 0;
    this.buttons = init.buttons ?? 0;
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
    this.movementX = init.movementX ?? 0;
    this.movementY = init.movementY ?? 0;
    this.deltaY = init.deltaY ?? 0;
    this.ctrlKey = init.ctrlKey ?? false;
    this.shiftKey = init.shiftKey ?? false;
    this.altKey = init.altKey ?? false;
    this.metaKey = init.metaKey ?? false;
  }

  get x(): number {
    return this.clientX;
  }

  get y(): number {
    return this.clientY;
  }

  get pageX(): number {
    return this.clientX;
  }

  get pageY(): number {
    return this.clientY;
  }

  get screenX(): number {
    return this.clientX;
  }

  get screenY(): number {
    return this.clientY;
  }

  get offsetX(): number {
    return this.clientX;
  }

  get offsetY(): number {
    return this.clientY;
  }

  get layerX(): number {
    return this.clientX;
  }

  get layerY(): number {
    return this.clientY;
  }
}

function installSyntheticDomEventPolyfills() {
  const globalAny = globalThis as Record<string, unknown>;
  globalAny.MouseEvent ??= SyntheticMouseEvent;
  globalAny.PointerEvent ??= SyntheticMouseEvent;
  globalAny.WheelEvent ??= SyntheticMouseEvent;
}

class SyntheticCanvas extends EventTarget {
  readonly style = { width: "", height: "", touchAction: "none" };
  readonly ownerDocument = {
    addEventListener() {},
    removeEventListener() {},
  };
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly pointerCapture = new Set<number>();

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly logPrefix: string,
  ) {
    super();
    this.style.width = `${width}px`;
    this.style.height = `${height}px`;
  }

  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (listener == null) {
      return;
    }
    const fn: Listener = typeof listener === "function"
      ? listener
      : listener.handleEvent.bind(listener);
    let set = this.listeners.get(type);
    if (set == null) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const sizeBefore = set.size;
    set.add(fn);
    console.log(
      `${this.logPrefix} addEventListener: ${type}, listeners before: ${sizeBefore}, after: ${set.size}, listener: ${
        fn.name || "anonymous"
      }`,
    );
  }

  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (listener == null) {
      return;
    }
    const set = this.listeners.get(type);
    if (set == null) {
      return;
    }
    for (const candidate of set) {
      if (
        candidate === listener ||
        ("handleEvent" in listener && candidate === listener.handleEvent.bind(listener))
      ) {
        set.delete(candidate);
      }
    }
  }

  dispatchSyntheticEvent(init: SyntheticEventInit) {
    const event = new SyntheticMouseEvent(init);
    event.currentTarget = this;
    event.target = this;
    const listeners = this.listeners.get(init.type);
    if (init.type === "pointerdown" || init.type === "pointerup") {
      console.log(
        `${this.logPrefix} dispatchSyntheticEvent: ${init.type}, listeners count: ${
          listeners?.size ?? 0
        }, button: ${init.button}, buttons: ${init.buttons}`,
      );
    }
    if (listeners == null) {
      return;
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error(`${this.logPrefix} Error in listener for ${init.type}:`, e);
      }
    }
  }

  getBoundingClientRect() {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      width: this.width,
      height: this.height,
      right: this.width,
      bottom: this.height,
    };
  }

  setPointerCapture(pointerId: number) {
    this.pointerCapture.add(pointerId);
  }

  releasePointerCapture(pointerId: number) {
    this.pointerCapture.delete(pointerId);
  }

  hasPointerCapture(pointerId: number) {
    return this.pointerCapture.has(pointerId);
  }
}

type RaylibPointerBridge = {
  update(): void;
};

function createRaylibPointerBridge(canvas: SyntheticCanvas): RaylibPointerBridge {
  let lastX = 0;
  let lastY = 0;
  let initialized = false;
  let leftDown = false;
  let rightDown = false;
  let overSent = false;
  const emitPointer = (
    type: string,
    button: number,
    buttons: number,
    clientX: number,
    clientY: number,
    movementX: number,
    movementY: number,
  ) => {
    canvas.dispatchSyntheticEvent({
      type,
      pointerId: 1,
      pointerType: "mouse",
      button,
      buttons,
      clientX,
      clientY,
      movementX,
      movementY,
    });
  };

  return {
    update() {
      const mouse = raylib.H.GetMousePosition();
      const clientX = mouse.x;
      const clientY = mouse.y;
      if (!initialized) {
        initialized = true;
        lastX = clientX;
        lastY = clientY;
      }
      const movementX = clientX - lastX;
      const movementY = clientY - lastY;
      const buttons = (raylib.H.IsMouseButtonDown(raylib.MouseButton.MOUSE_BUTTON_LEFT) ? 1 : 0) |
        (raylib.H.IsMouseButtonDown(raylib.MouseButton.MOUSE_BUTTON_RIGHT) ? 2 : 0);

      if (!overSent) {
        emitPointer("pointerover", -1, buttons, clientX, clientY, 0, 0);
        overSent = true;
      }

      if (movementX !== 0 || movementY !== 0) {
        emitPointer("pointermove", -1, buttons, clientX, clientY, movementX, movementY);
      }

      const nextLeftDown = raylib.H.IsMouseButtonDown(raylib.MouseButton.MOUSE_BUTTON_LEFT);
      if (nextLeftDown !== leftDown) {
        emitPointer(nextLeftDown ? "pointerdown" : "pointerup", 0, buttons, clientX, clientY, 0, 0);
        leftDown = nextLeftDown;
      }

      const nextRightDown = raylib.H.IsMouseButtonDown(raylib.MouseButton.MOUSE_BUTTON_RIGHT);
      if (nextRightDown !== rightDown) {
        emitPointer(
          nextRightDown ? "pointerdown" : "pointerup",
          2,
          buttons,
          clientX,
          clientY,
          0,
          0,
        );
        if (nextRightDown) {
          canvas.dispatchSyntheticEvent({
            type: "contextmenu",
            button: 2,
            buttons,
            clientX,
            clientY,
          });
        }
        rightDown = nextRightDown;
      }

      const wheel = raylib.H.GetMouseWheelMove();
      if (wheel !== 0) {
        canvas.dispatchSyntheticEvent({
          type: "wheel",
          clientX,
          clientY,
          deltaY: -wheel * 100,
          buttons,
        });
      }

      lastX = clientX;
      lastY = clientY;
    },
  };
}

function getSceneBackgroundColor(scene: THREE.Scene): [number, number, number, number] {
  const background = scene.background;
  if (background instanceof THREE.Color) {
    return [
      Math.round(background.r * 255),
      Math.round(background.g * 255),
      Math.round(background.b * 255),
      255,
    ];
  }
  return [0, 0, 0, 255];
}

function normalizeThreeCameraInstance(camera: THREE.Camera): void {
  const typedCamera = camera as THREE.Camera & {
    type?: string;
    aspect?: number;
  };
  if (typedCamera.type === "PerspectiveCamera" && !(camera instanceof THREE.PerspectiveCamera)) {
    Object.setPrototypeOf(camera, THREE.PerspectiveCamera.prototype);
  }
}

export function SceneCameraAim(
  { controlsStore, logPrefix }: { controlsStore: RaylibR3FViewerControlsStore; logPrefix: string },
) {
  const { aimOrigin, cameraPosition } = useViewerAim();
  const camera = useThree((state) => state.camera);
  const [ox, oy, oz] = aimOrigin;
  const [cx, cy, cz] = cameraPosition;

  React.useLayoutEffect(() => {
    console.log(`${logPrefix} SceneCameraAim setting up camera`);
    console.log(`${logPrefix} - Camera before setup:`, {
      position: camera.position.toArray(),
      type: camera.type,
    });
    camera.position.set(cx, cy, cz);
    console.log(`${logPrefix} - Camera after position set:`, camera.position.toArray());
    controlsStore.getState().setOriginPosition(ox, oy, oz);
    controlsStore.getState().setCameraPosition(cx, cy, cz);
    console.log(
      `${logPrefix} - controlsStore after SceneCameraAim setup:`,
      controlsStore.getState(),
    );
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    console.log(`${logPrefix} SceneCameraAim setup complete`);
  }, [camera, controlsStore, logPrefix, ox, oy, oz, cx, cy, cz]);

  return null;
}

export function OrbitHandlesView(
  { controlsStore, logPrefix }: { controlsStore: RaylibR3FViewerControlsStore; logPrefix: string },
) {
  console.log(`${logPrefix} OrbitHandlesView rendering`);
  try {
    return (
      <OrbitHandles
        store={controlsStore}
        damping={false}
        rotate={false}
        pan={{ filter: filterForOnePointerLeftClick }}
      />
    );
  } catch (e) {
    console.error(`${logPrefix} Error rendering OrbitHandles:`, e);
    return null;
  }
}

export type RunRaylibR3FViewerAppOptions = {
  defaultTitle: string;
  logPrefix: string;
  defaultWidth?: number;
  defaultHeight?: number;
  /** Orbit / pan origin and camera; must match R3F extraction root camera. */
  aim: {
    aimOrigin: [number, number, number];
    cameraPosition: [number, number, number];
    fov?: number;
  };
  renderExtractionId: string;
  Scene: React.FC<RaylibR3FViewerSceneProps>;
  /** If true, log three.js / @pmndrs/handle versions at startup (ui viewer does). */
  logDependencyVersions?: boolean;
};

/**
 * Raylib window + R3F extraction + `forwardHtmlEvents` + raythree UI extraction — shared by
 * [uiViewer](uiViewer.tsx) and [keyboardViewer](keyboardViewer.tsx).
 */
export async function runRaylibR3FViewerApp(
  options: RunRaylibR3FViewerAppOptions,
) {
  const p = options.logPrefix;
  const defaultW = options.defaultWidth ?? 1400;
  const defaultH = options.defaultHeight ?? 900;
  if (options.logDependencyVersions) {
    logRaylibR3FViewerDependencies(p);
  }
  console.log(`${p} main() starting`);
  const width = getNumberArg("width", defaultW);
  const height = getNumberArg("height", defaultH);
  const title = getStringArg("title", options.defaultTitle);
  console.log(`${p} Window config:`, { width, height, title });
  installSyntheticDomEventPolyfills();

  let win32Shutdown: typeof import("@win32/km") | null = null;
  if (Deno.build.os === "windows") {
    win32Shutdown = await import("@win32/km");
    for (const sig of (["SIGINT", "SIGTERM"] as const)) {
      try {
        Deno.addSignalListener(sig, () => {
          if (win32Shutdown) {
            releaseWindowsSyntheticKeyboardStateWithKm(win32Shutdown);
          }
        });
      } catch {
        // ignore (no permission / unsupported)
      }
    }
  }

  const [ax, ay, az] = options.aim.aimOrigin;
  const [cx, cy, cz] = options.aim.cameraPosition;
  const fov = options.aim.fov ?? 55;
  const aimValue: RaylibR3FViewerAim = {
    aimOrigin: options.aim.aimOrigin,
    cameraPosition: options.aim.cameraPosition,
    fov,
  };

  const extractor = new RaythreeExtractor();
  console.log(`${p} Creating controlsStore with createScreenCameraStore()`);
  const controlsStore = createScreenCameraStore();
  console.log(`${p} controlsStore created, initial state:`, controlsStore.getState());
  controlsStore.getState().setOriginPosition(ax, ay, az);
  controlsStore.getState().setCameraPosition(cx, cy, cz);
  console.log(`${p} controlsStore after setting positions:`, controlsStore.getState());

  console.log(`${p} Creating R3F extraction root`);
  const r3f = await createR3FExtractionRoot({
    width,
    height,
    camera: {
      position: [cx, cy, cz],
      fov,
      near: 0.05,
      far: 100,
    },
  });
  console.log(`${p} R3F root created`);

  const inputCanvas = new SyntheticCanvas(width, height, p);
  console.log(`${p} SyntheticCanvas created:`, { width, height });
  const pointerBridge = createRaylibPointerBridge(inputCanvas);
  console.log(`${p} RaylibPointerBridge created`);

  raylib.loadRaylib(getDefaultRaylibPath());
  console.log(`${p} Raylib loaded`);
  let renderer: WebXRRaythreeRaylibRenderer | null = null;
  let windowInitialized = false;
  let forwarded: { destroy: () => void; update: () => void } | null = null;
  const Scene = options.Scene;

  try {
    raylib.H.InitWindow(width, height, title);
    windowInitialized = true;
    console.log(`${p} Raylib window initialized`);
    raylib.SetTargetFPS(60);
    renderer = new WebXRRaythreeRaylibRenderer();
    console.log(`${p} WebXRRaythreeRaylibRenderer created`);

    console.log(`${p} Rendering scene with controlsStore`);
    r3f.render(
      <ViewerAimProvider value={aimValue}>
        <Scene controlsStore={controlsStore} logPrefix={p} />
      </ViewerAimProvider>,
    );

    while (!raylib.WindowShouldClose()) {
      const scene = r3f.getScene();
      const camera = r3f.getCamera();
      if (scene === null || camera === null) {
        await wait(1);
        continue;
      }
      normalizeThreeCameraInstance(camera);
      if (camera instanceof THREE.PerspectiveCamera) {
        const expectedAspect = width / height;
        if (
          !Number.isFinite(camera.aspect) || camera.aspect === 0 ||
          Math.abs(camera.aspect - expectedAspect) > 1e-6
        ) {
          camera.aspect = expectedAspect;
          camera.updateProjectionMatrix();
        }
      }
      if (forwarded == null) {
        console.log(`${p} Setting up forwardHtmlEvents`);
        const getCamera = (): THREE.PerspectiveCamera | THREE.OrthographicCamera => {
          if (camera instanceof THREE.PerspectiveCamera) {
            return camera;
          }
          if (camera instanceof THREE.OrthographicCamera) {
            return camera;
          }
          return camera as THREE.PerspectiveCamera;
        };
        forwarded = forwardHtmlEvents(inputCanvas as never, getCamera, scene, {
          batchEvents: false,
        });
        console.log(`${p} forwardHtmlEvents setup complete`);
      }

      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      pointerBridge.update();
      try {
        forwarded.update();
      } catch (e) {
        console.error(`${p} Error in forwarded.update():`, e);
      }
      camera.updateMatrixWorld(true);
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

      const extraction = extractor.extract(scene, camera);
      const ui = extractWebXRRaythreeUi(scene);

      raylib.BeginDrawing();
      try {
        void renderer.renderExtraction(
          extraction,
          getSceneBackgroundColor(scene),
          {
            projectionMatrix: new Float32Array(camera.projectionMatrix.elements),
            viewMatrix: new Float32Array(camera.matrixWorldInverse.elements),
          },
          options.renderExtractionId,
          ui,
        );
        raylib.DrawFPS(16, 16);
      } finally {
        raylib.EndDrawing();
      }

      await wait(1);
    }
  } catch (error) {
    console.error(`${p} Error in main loop:`, error);
    throw error;
  } finally {
    await releaseWindowsSyntheticKeyboardState();
    forwarded?.destroy();
    r3f.dispose();
    renderer?.dispose();
    if (windowInitialized) {
      raylib.CloseWindow();
    }
    raylib.unloadRaylib();
  }
}
