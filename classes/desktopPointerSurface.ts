export type SyntheticEventInit = {
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

export function installSyntheticDomEventPolyfills() {
  const globalAny = globalThis as Record<string, unknown>;
  globalAny.MouseEvent = SyntheticMouseEvent;
  globalAny.PointerEvent = SyntheticMouseEvent;
  globalAny.WheelEvent = SyntheticMouseEvent;
}

export class SyntheticCanvas extends EventTarget {
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
