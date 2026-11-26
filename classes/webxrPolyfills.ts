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
 *
 * With `manual`, no timer runs at all: callbacks queue until {@link runManualAnimationFrame},
 * so the Raylib/OpenVR frame loop is the only clock and each of its frames runs exactly one
 * IWER device frame (and one r3f advance).
 */
export type WebXrHostPolyfillOptions = {
  pollIntervalMs: number;
  /** @default false */
  openVrVsyncDrivesRaf?: boolean;
  /** @default false */
  manual?: boolean;
  /**
   * Locks the timer to the headset: each frame starts `phaseMs` after a vsync, at most once per
   * vsync. A free-running `pollIntervalMs` timer overshoots under load (~68 Hz against 75 Hz),
   * so a few display frames per second got no new scene and worker-driven motion stuttered.
   * Falls back to `pollIntervalMs` while the clock is unavailable.
   */
  vsyncClock?: {
    sample: () => { msSinceVsync: number; frameIndex: bigint } | null;
    periodMs: number;
    phaseMs: number;
  };
};

type QueuedRaf = { id: number; cb: RafCallback; cancelled: boolean };

let manualRafQueue: QueuedRaf[] = [];
let manualRafRunning: QueuedRaf[] = [];
let manualRafNextId = 1;

/**
 * Runs every callback queued before this call, like one browser animation frame. Callbacks
 * that request another frame land in the next one. Returns how many callbacks ran.
 */
export function runManualAnimationFrame(now = performance.now()): number {
  const queue = manualRafQueue;
  if (queue.length === 0) return 0;
  manualRafQueue = [];
  manualRafRunning = queue;
  let ran = 0;
  let firstError: unknown = null;
  for (const entry of queue) {
    if (entry.cancelled) continue;
    ran++;
    // One failing callback must not starve the rest of the frame (IWER's device frame
    // among them), so run them all and rethrow the first failure afterwards.
    try {
      entry.cb(now);
    } catch (error) {
      firstError ??= error;
    }
  }
  manualRafRunning = [];
  if (firstError != null) throw firstError;
  return ran;
}

const sharedAbortReasonInstalled = Symbol.for("petplay.sharedAbortReason");

/**
 * A reason-less `abort()` builds a fresh `DOMException` and captures its stack, ~5 µs under
 * React's deep stacks. uikit aborts a controller per effect, so remounting a window spent 40-75 ms
 * of one frame there. Reason-less aborts share one `AbortError` instead (~0.5 µs); anything that
 * reads `signal.reason` still sees an AbortError `DOMException`.
 */
export function installSharedAbortReason(): void {
  const proto = AbortController.prototype as AbortController & Record<symbol, boolean>;
  if (proto[sharedAbortReasonInstalled]) return;
  proto[sharedAbortReasonInstalled] = true;
  const abort = proto.abort;
  const reason = new DOMException("This operation was aborted", "AbortError");
  proto.abort = function (this: AbortController, given?: unknown) {
    abort.call(this, given === undefined ? reason : given);
  };
}

/**
 * Schedules callbacks for the next `phaseMs`-after-vsync moment after the last vsync that ran a
 * frame. Callbacks requested before a frame fires share it, like a browser animation frame;
 * callbacks requested while it runs go to a later vsync, even when the vsync estimate jitters.
 */
export function vsyncLockedScheduler(
  clock: NonNullable<WebXrHostPolyfillOptions["vsyncClock"]>,
  fallbackMs: number,
): (run: () => void) => number {
  let fired: bigint | null = null;
  return (run) => {
    const now = clock.sample();
    if (!now || !Number.isFinite(now.msSinceVsync)) {
      return setTimeout(run, fallbackMs) as unknown as number;
    }
    // Steam Link / OpenVR can reset `frameIndex` backwards across standby/reconnect; reset `fired`
    // instead of sleeping for `(fired - vsync) * periodMs` (minutes/hours).
    if (fired !== null && fired - now.frameIndex > 2n) {
      fired = null;
    }
    const msSinceVsync = Math.max(0, Math.min(clock.periodMs * 2, now.msSinceVsync));
    let vsync = now.frameIndex;
    let delay = clock.phaseMs - msSinceVsync;
    if (delay < 0) {
      vsync++;
      delay += clock.periodMs;
    }
    if (fired !== null && vsync <= fired) {
      delay += Number(fired + 1n - vsync) * clock.periodMs;
      vsync = fired + 1n;
    }
    const clampedDelay = Math.max(0, Math.min(clock.periodMs * 2, delay));
    return setTimeout(() => {
      if (fired === null || vsync > fired) fired = vsync;
      run();
    }, clampedDelay) as unknown as number;
  };
}

export function installWebXRHostPolyfills(
  width: number,
  height: number,
  pollIntervalMs: number | WebXrHostPolyfillOptions,
) {
  const rafOptions: WebXrHostPolyfillOptions = typeof pollIntervalMs === "number"
    ? { pollIntervalMs, openVrVsyncDrivesRaf: false }
    : pollIntervalMs;
  const delayMs = rafOptions.openVrVsyncDrivesRaf ? 0 : rafOptions.pollIntervalMs;
  installSharedAbortReason();
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

  if (rafOptions.manual) {
    manualRafQueue = [];
    (globalAny as Record<string, unknown>).requestAnimationFrame = ((cb: RafCallback): number => {
      const id = manualRafNextId++;
      manualRafQueue.push({ id, cb, cancelled: false });
      return id;
    }) as unknown;
    (globalAny as Record<string, unknown>).cancelAnimationFrame = ((id: number): void => {
      const entry = manualRafQueue.find((e) => e.id === id) ??
        manualRafRunning.find((e) => e.id === id);
      if (entry) entry.cancelled = true;
    }) as unknown;
  } else {
    const schedule = rafOptions.vsyncClock
      ? vsyncLockedScheduler(rafOptions.vsyncClock, delayMs)
      : (run: () => void) => setTimeout(run, delayMs) as unknown as number;
    (globalAny as Record<string, unknown>).requestAnimationFrame = ((cb: RafCallback): number => {
      return schedule(() => cb(performance.now()));
    }) as unknown;

    (globalAny as Record<string, unknown>).cancelAnimationFrame = ((id: number): void => {
      clearTimeout(id as unknown as number);
    }) as unknown;
  }

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

      initCustomEvent() {}
    } as typeof CustomEvent;
  }
}
