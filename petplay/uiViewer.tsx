import React from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitHandles } from "@react-three/handle";
import raylib from "../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import { forwardHtmlEvents } from "@pmndrs/pointer-events";
import {
  filterForOnePointerLeftClick,
  createScreenCameraStore,
} from "@pmndrs/handle";
import { RaythreeExtractor } from "../submodules/raythree/src/extract.ts";
import { createR3FExtractionRoot } from "../submodules/raythree/src/r3f_runtime.ts";
import { NativeHudPanel } from "../classes/environment/nativeFrontend.tsx";
import { extractWebXRRaythreeUi } from "../classes/webxrRaythreeUi.ts";
import { WebXRRaythreeRaylibRenderer } from "../classes/webxrRaythreeRaylibRenderer.ts";

const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 900;
const DEFAULT_TITLE = "PetPlay UI Viewer";
const UI_TARGET = new THREE.Vector3(0, 1.28, -1.45);

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
  currentTarget: EventTarget | null = null;
  target: EventTarget | null = null;

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
  ) {
    super();
    this.style.width = `${width}px`;
    this.style.height = `${height}px`;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
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
    set.add(fn);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
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
    if (listeners == null) {
      return;
    }
    for (const listener of listeners) {
      listener(event);
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
        emitPointer(nextRightDown ? "pointerdown" : "pointerup", 2, buttons, clientX, clientY, 0, 0);
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

async function main() {
  const width = getNumberArg("width", DEFAULT_WIDTH);
  const height = getNumberArg("height", DEFAULT_HEIGHT);
  const title = getStringArg("title", DEFAULT_TITLE);
  installSyntheticDomEventPolyfills();

  const extractor = new RaythreeExtractor();
  const controlsStore = createScreenCameraStore();
  controlsStore.getState().setOriginPosition(UI_TARGET.x, UI_TARGET.y, UI_TARGET.z);
  controlsStore.getState().setCameraPosition(0, 1.35, 0.65);
  const r3f = await createR3FExtractionRoot({
    width,
    height,
    camera: {
      position: [0, 1.35, 0.65],
      fov: 55,
      near: 0.05,
      far: 100,
    },
  });
  const inputCanvas = new SyntheticCanvas(width, height);
  const pointerBridge = createRaylibPointerBridge(inputCanvas);

  raylib.loadRaylib(getDefaultRaylibPath());
  let renderer: WebXRRaythreeRaylibRenderer | null = null;
  let windowInitialized = false;
  let forwarded:
    | {
      destroy: () => void;
      update: () => void;
    }
    | null = null;
  try {
    raylib.H.InitWindow(width, height, title);
    windowInitialized = true;
    raylib.SetTargetFPS(60);
    renderer = new WebXRRaythreeRaylibRenderer();

    r3f.render(<UiViewerScene controlsStore={controlsStore} />);

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
        if (!Number.isFinite(camera.aspect) || camera.aspect === 0 || Math.abs(camera.aspect - expectedAspect) > 1e-6) {
          camera.aspect = expectedAspect;
          camera.updateProjectionMatrix();
        }
      }
      if (forwarded == null) {
        forwarded = forwardHtmlEvents(inputCanvas as never, () => camera, scene, {
          batchEvents: false,
        });
      }

      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      pointerBridge.update();
      forwarded.update();
      camera.updateMatrixWorld(true);
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

      const extraction = extractor.extract(scene, camera);
      const ui = extractWebXRRaythreeUi(scene);

      raylib.BeginDrawing();
      try {
        renderer.renderExtraction(
          extraction,
          getSceneBackgroundColor(scene),
          {
            projectionMatrix: new Float32Array(camera.projectionMatrix.elements),
            viewMatrix: new Float32Array(camera.matrixWorldInverse.elements),
          },
          "desktop-ui-viewer",
          ui,
        );
        raylib.DrawFPS(16, 16);
      } finally {
        raylib.EndDrawing();
      }

      await wait(1);
    }
  } finally {
    forwarded?.destroy();
    r3f.dispose();
    renderer?.dispose();
    if (windowInitialized) {
      raylib.CloseWindow();
    }
    raylib.unloadRaylib();
  }
}

function UiViewerScene(
  { controlsStore }: { controlsStore: ReturnType<typeof createScreenCameraStore> },
) {
  return (
    <>
      <SceneCameraAim controlsStore={controlsStore} />
      <OrbitHandles
        store={controlsStore}
        damping={false}
        rotate={false}
        pan={{ filter: filterForOnePointerLeftClick }}
      />
      <color attach="background" args={[0x0b1018]} />
      <ambientLight intensity={1.25} />
      <directionalLight intensity={2.2} position={[2.5, 4, 2]} />
      <pointLight intensity={10} position={[0, 1.8, -1.2]} color="#ffd08a" />
      <Backdrop />
      <UiStand />
      <group pointerEvents="none">
        <NativeHudPanel
          transform={{
            position: [0, 1.32, -1.45],
            rotation: [0, 0, 0],
            scale: [1.4, 1.4, 1.4],
          }}
        />
      </group>
    </>
  );
}

function SceneCameraAim(
  { controlsStore }: { controlsStore: ReturnType<typeof createScreenCameraStore> },
) {
  const camera = useThree((state) => state.camera);

  React.useLayoutEffect(() => {
    camera.position.set(0, 1.35, 0.65);
    camera.lookAt(UI_TARGET);
    controlsStore.getState().setOriginPosition(UI_TARGET.x, UI_TARGET.y, UI_TARGET.z);
    controlsStore.getState().setCameraPosition(0, 1.35, 0.65);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }, [camera, controlsStore]);

  return null;
}

function Backdrop() {
  return (
    <>
      <mesh position={[0, 1.4, -2.6]}>
        <planeGeometry args={[5.5, 3.5]} />
        <meshStandardMaterial color="#162235" roughness={0.9} metalness={0.05} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.7, -1.5]} receiveShadow>
        <planeGeometry args={[5.5, 5.5]} />
        <meshStandardMaterial color="#111927" roughness={1} metalness={0} />
      </mesh>
    </>
  );
}

function UiStand() {
  const groupRef = React.useRef<THREE.Object3D | null>(null);

  useFrame((state) => {
    if (groupRef.current === null) {
      return;
    }
    const group = groupRef.current as THREE.Object3D & {
      position: THREE.Vector3;
      rotation: THREE.Euler;
    };
    group.position.y = 1.02 + Math.sin(state.clock.elapsedTime * 0.8) * 0.015;
    group.rotation.y = Math.sin(state.clock.elapsedTime * 0.35) * 0.08;
  });

  return (
    <group ref={groupRef} position={[0, 1.02, -1.45]}>
      <mesh position={[0, -0.3, -0.01]}>
        <cylinderGeometry args={[0.018, 0.022, 0.62, 18]} />
        <meshStandardMaterial color="#475569" roughness={0.65} metalness={0.25} />
      </mesh>
      <mesh position={[0, -0.63, -0.02]}>
        <cylinderGeometry args={[0.2, 0.24, 0.06, 24]} />
        <meshStandardMaterial color="#1e293b" roughness={0.88} metalness={0.08} />
      </mesh>
    </group>
  );
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error);
    Deno.exit(1);
  });
}
