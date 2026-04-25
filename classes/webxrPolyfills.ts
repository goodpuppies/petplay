type RafCallback = (time: number) => void;

/**
 * Installs a **synthetic** `requestAnimationFrame` (Deno has no real display vsync).
 * IWER's `XRSession` drives immersive frames with
 * `globalThis.requestAnimationFrame(this.onDeviceFrame)`; the **interval** here therefore sets
 * the WebXR `session.requestAnimationFrame` rate — use `1000 / nominalHmdHz` when the OpenVR
 * HMD display frequency is known, not a fixed `16` (~60Hz).
 * When `openVrVsyncDrivesRaf` is set, the delay is `0` and `OpenVrOverlayFramePacer` in
 * `WebXRHost` blocks in `paceToDisplayAndRefreshPoses` before emulated HMD work (Aardvark-style
 * overlay timing — not `WaitGetPoses`).
 */
export type WebXrHostPolyfillOptions = {
  pollIntervalMs: number;
  /** @default false */
  openVrVsyncDrivesRaf?: boolean;
};

export function installWebXRHostPolyfills(
  width: number,
  height: number,
  pollIntervalMs: number | WebXrHostPolyfillOptions,
) {
  const rafOptions: WebXrHostPolyfillOptions = typeof pollIntervalMs === "number"
    ? { pollIntervalMs, openVrVsyncDrivesRaf: false }
    : pollIntervalMs;
  const delayMs = rafOptions.openVrVsyncDrivesRaf ? 0 : rafOptions.pollIntervalMs;
  const globalAny = globalThis as Record<string, unknown>;
  const setGlobalNumber = (name: "innerWidth" | "innerHeight", value: number) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    if (!descriptor) {
      Object.defineProperty(globalThis, name, {
        value,
        configurable: true,
        writable: true,
      });
      return;
    }
    if (descriptor.writable) {
      (globalAny as Record<string, number>)[name] = value;
      return;
    }
    if (descriptor.configurable) {
      Object.defineProperty(globalThis, name, {
        value,
        configurable: true,
      });
    }
  };

  (globalAny as Record<string, unknown>).requestAnimationFrame = ((cb: RafCallback): number => {
    return setTimeout(() => cb(performance.now()), delayMs) as unknown as number;
  }) as unknown;

  (globalAny as Record<string, unknown>).cancelAnimationFrame = ((id: number): void => {
    clearTimeout(id as unknown as number);
  }) as unknown;

  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  globalAny.ResizeObserver ??= ResizeObserver;
  globalAny.window ??= globalThis;
  setGlobalNumber("innerWidth", width);
  setGlobalNumber("innerHeight", height);

  if (!globalAny.document) {
    const body = {
      append() {},
      appendChild() {},
      removeChild() {},
    };
    globalAny.document = {
      body,
      createElement: (tag: string) => {
        if (tag === "canvas") {
          return {
            style: {},
            ownerDocument: globalAny.document,
            addEventListener() {},
            removeEventListener() {},
            getContext() {
              return null;
            },
          };
        }
        return {
          style: {},
          append() {},
          appendChild() {},
          remove() {},
          addEventListener() {},
          removeEventListener() {},
        };
      },
      addEventListener() {},
      removeEventListener() {},
    };
  }

  globalAny.HTMLElement ??= class HTMLElement {};
  globalAny.Element ??= class Element {};

  if (!globalAny.localStorage) {
    const storage = new Map<string, string>();
    globalAny.localStorage = {
      getItem(key: string) {
        return storage.has(key) ? storage.get(key)! : null;
      },
      setItem(key: string, value: string) {
        storage.set(key, String(value));
      },
      removeItem(key: string) {
        storage.delete(key);
      },
      clear() {
        storage.clear();
      },
      key(index: number) {
        return Array.from(storage.keys())[index] ?? null;
      },
      get length() {
        return storage.size;
      },
    };
  }

  if (!globalAny.CustomEvent) {
    globalAny.CustomEvent = class CustomEvent<T = unknown> extends Event {
      declare detail: T;

      constructor(type: string, init?: CustomEventInit<T>) {
        super(type, init);
        this.detail = init?.detail as T;
      }
    } as typeof CustomEvent;
  }
}
