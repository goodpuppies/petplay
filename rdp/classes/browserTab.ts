/**
 * A headless "browser tab" for uikit: r3f and uikit run in this worker as if in a page.
 *
 * - `innerWidth`, `innerHeight` and `devicePixelRatio` are the remote tab's, and change with
 *   it (a `resize` event is dispatched on the global, as a page would see).
 * - The canvas is an `EventTarget` with a page canvas's size, bounding rect and pointer capture.
 *   r3f's own DOM event system is connected to it, so a pointer or wheel event dispatched here is
 *   raycast and handled exactly as in a browser: uikit's `onClick`, hover, pointer capture.
 * - Key events are dispatched on the global (`addEventListener("keydown", …)` works).
 * - The camera is orthographic in CSS pixels, so a root container sized to the viewport with
 *   `pixelSize={1}` fills the tab (see {@link TabBody}).
 *
 * The frame loop is ours (`frame(now)`): r3f's is "never", so nothing runs between frames.
 * Rendering is not done here; the scene is extracted and drawn by the tab (raythree IR).
 */
import React from "react";
import {
  advance,
  createRoot,
  events,
  type RootState,
  useThree,
} from "@react-three/fiber/webgpu";
import * as THREE from "three";
import { Container } from "../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import type { TabDomEvent, TabViewport } from "./tabProtocol.ts";

type Global = Record<string, unknown> & EventTarget;
const g = globalThis as unknown as Global;

function installGlobals(viewport: TabViewport): void {
  g.window ??= globalThis;
  g.innerWidth = viewport.width;
  g.innerHeight = viewport.height;
  g.devicePixelRatio = viewport.dpr;
  g.document ??= {
    createElement: () => ({
      style: {},
      addEventListener() {},
      removeEventListener() {},
      getContext: () => null,
    }),
    addEventListener() {},
    removeEventListener() {},
  };
  g.HTMLElement ??= class {};
  g.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  g.requestAnimationFrame ??= (cb: (time: number) => void) =>
    setTimeout(() => cb(performance.now()), 16);
  g.cancelAnimationFrame ??= (id: number) => clearTimeout(id);
}

/** The page canvas r3f listens on. */
class TabCanvas extends EventTarget {
  style = {};
  ownerDocument = g.document;
  #captured = new Set<number>();
  constructor(public width: number, public height: number) {
    super();
  }
  get clientWidth() {
    return this.width;
  }
  get clientHeight() {
    return this.height;
  }
  getBoundingClientRect() {
    const { width, height } = this;
    return { left: 0, top: 0, x: 0, y: 0, width, height, right: width, bottom: height };
  }
  setPointerCapture(id: number) {
    this.#captured.add(id);
  }
  releasePointerCapture(id: number) {
    this.#captured.delete(id);
  }
  hasPointerCapture(id: number) {
    return this.#captured.has(id);
  }
  getContext() {
    return null;
  }
}

/** What r3f and uikit ask a renderer for; it draws nothing. */
function tabRenderer(canvas: TabCanvas) {
  return {
    domElement: canvas,
    xr: {
      enabled: false,
      isPresenting: false,
      getSession: () => null,
      addEventListener() {},
      removeEventListener() {},
    },
    shadowMap: { enabled: false },
    outputColorSpace: "srgb",
    toneMapping: 0,
    info: { render: {} },
    setPixelRatio() {},
    getPixelRatio: () => g.devicePixelRatio as number,
    setSize(width: number, height: number) {
      canvas.width = width;
      canvas.height = height;
    },
    getSize: (target: THREE.Vector2) => target.set(canvas.width, canvas.height),
    render() {},
    setAnimationLoop() {},
    hasInitialized: () => true,
    async init() {},
    dispose() {},
    getContext: () => null,
  };
}

export type BrowserTab = {
  readonly viewport: TabViewport;
  render(node: React.ReactNode): void;
  resize(viewport: TabViewport): void;
  dispatch(event: TabDomEvent): void;
  /** Run one frame (useFrame callbacks, uikit layout). */
  frame(now?: number): void;
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  dispose(): void;
};

/** The tab's size, inside {@link BrowserTab.render}: like reading `innerWidth` in a page. */
export function useTabSize(): { width: number; height: number } {
  return useThree((state: RootState) => state.size);
}

/** The page body: a uikit root that fills the tab, in CSS pixels. */
export function TabBody(props: React.ComponentProps<typeof Container>) {
  const { width, height } = useTabSize();
  return React.createElement(Container, {
    sizeX: width,
    sizeY: height,
    pixelSize: 1,
    width,
    height,
    ...props,
  });
}

export async function createBrowserTab(initial: TabViewport): Promise<BrowserTab> {
  installGlobals(initial);
  const canvas = new TabCanvas(initial.width, initial.height);
  const root = createRoot(canvas as unknown as HTMLCanvasElement);
  let viewport = { ...initial };
  const configure = () =>
    root.configure({
      // deno-lint-ignore no-explicit-any
      renderer: async () => tabRenderer(canvas) as any,
      events,
      orthographic: true,
      frameloop: "never",
      size: { width: viewport.width, height: viewport.height, top: 0, left: 0 },
      dpr: viewport.dpr,
      camera: { position: [0, 0, 500], near: 0.1, far: 2000 },
      // deno-lint-ignore no-explicit-any
    } as any);
  await configure();

  let scene: THREE.Scene | null = null;
  let camera: THREE.Camera | null = null;
  function Capture() {
    scene = useThree((s: RootState) => s.scene) as unknown as THREE.Scene;
    camera = useThree((s: RootState) => s.camera) as unknown as THREE.Camera;
    return null;
  }

  return {
    get viewport() {
      return viewport;
    },
    render(node) {
      root.render(React.createElement(React.Fragment, null, React.createElement(Capture), node));
    },
    resize(next) {
      if (
        next.width === viewport.width && next.height === viewport.height &&
        next.dpr === viewport.dpr
      ) return;
      viewport = { ...next };
      canvas.width = next.width;
      canvas.height = next.height;
      g.innerWidth = next.width;
      g.innerHeight = next.height;
      g.devicePixelRatio = next.dpr;
      void configure();
      g.dispatchEvent(new Event("resize"));
    },
    dispatch(event) {
      const { type, ...fields } = event;
      const dom = new Event(type, { cancelable: true });
      Object.assign(dom, fields, "offsetX" in event
        ? { clientX: event.offsetX, clientY: event.offsetY }
        : {});
      if (type === "keydown" || type === "keyup") g.dispatchEvent(dom);
      else canvas.dispatchEvent(dom);
    },
    frame(now = performance.now()) {
      advance(now);
    },
    get scene() {
      if (!scene) throw new Error("render() first");
      return scene;
    },
    get camera() {
      if (!camera) throw new Error("render() first");
      return camera;
    },
    dispose() {
      root.unmount();
    },
  };
}
