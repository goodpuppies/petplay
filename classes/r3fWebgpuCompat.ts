export * from "npm:@react-three/fiber@10.0.0-alpha.2/webgpu";

import { getScheduler, useStore } from "npm:@react-three/fiber@10.0.0-alpha.2/webgpu";
import type {
  FrameNextState,
  UseFrameNextOptions,
} from "npm:@react-three/fiber@10.0.0-alpha.2/webgpu";
import React from "react";
import { currentXRFrame } from "./xrFrameBridge.ts";

/**
 * Legacy `useFrame` callback: optional third argument is `XRFrame`.
 * R3F v10 `FrameNextCallback` is only `(state, delta)`; see `node_modules/@react-three/fiber/dist/webgpu/index.d.ts`.
 *
 * **v10 `UseFrameNextOptions` pass-through:** `phase`, `fps`, `drop`, `enabled`, `id`, etc. are
 * forwarded to the scheduler as-is. A **numeric** second argument is still treated as
 * `priority` for backwards compatibility.
 */
export type LegacyUseFrameCallback = (
  state: FrameNextState,
  delta: number,
  xrFrame?: XRFrame | null,
) => void;

/** Legacy `THREE.Clock` subset that the old callback API exposed as `state.clock`. */
type FrameClock = {
  elapsed: number;
  delta: number;
  getElapsedTime: () => number;
  getDelta: () => number;
};

type LegacyFrameState = FrameNextState & { clock: FrameClock };

const callbackOptionsKey = (options?: UseFrameNextOptions | number): string =>
  typeof options === "number" ? `p:${options}` : options
    ? JSON.stringify({
      id: options.id,
      phase: options.phase,
      priority: options.priority,
      fps: options.fps,
      drop: options.drop,
      enabled: options.enabled,
      before: options.before,
      after: options.after,
    })
    : "";

/**
 * R3F-compatible `useFrame` that registers directly with the scheduler.
 *
 * The stock hook wraps every callback in `(state, delta) => ({...store.getState(), time, delta,
 * elapsed, frame})`, allocating a fresh ~45-key object for **every registered job on every frame**
 * — with this scene's ~460 jobs (one per uikit node, one per `Handle`, one per XR pointer) that is
 * the single largest JS cost in the overlay's frame budget, and it scales with UI size rather than
 * scene size. The scheduler already builds that exact object once per frame in
 * `Scheduler#tickRoot` and hands it to the job, so register the callback ourselves and pass it
 * through, attaching only the legacy per-hook clock.
 *
 * Registration semantics match the stock hook: the job is (re)registered when the store,
 * the resolved id, or any option in {@link callbackOptionsKey} changes, and the latest callback is
 * read at frame time, so callers may pass an inline closure without re-registering.
 *
 * A numeric `priority` is honoured as `{ priority }`. Legacy numeric priorities above zero
 * additionally suppressed R3F's internal render job by bumping `internal.priority`; no caller in
 * this repository uses one (and the overlay patches the render phase itself), so that side effect
 * is intentionally not reproduced.
 */
export function useFrame(
  callback?: LegacyUseFrameCallback,
  options?: UseFrameNextOptions | number,
): void {
  const store = useStore();
  const scheduler = getScheduler();
  const optionsKey = callbackOptionsKey(options);
  // Underlying option object identity only needs to change when `optionsKey` changes: an inline
  // `{ phase: "finish" }` literal must not re-register the job on every render.
  const registrationOptions = React.useMemo<UseFrameNextOptions>(
    () => (typeof options === "number" ? { priority: options } : options ?? {}),
    [optionsKey],
  );
  const jobId = registrationOptions.id ?? `petplay-frame-${React.useId()}`;

  // The scheduler calls jobs synchronously from `advance()`, so a stable per-hook clock can be
  // attached to the frame state for the duration of the callback.
  const clockRef = React.useRef<FrameClock>({
    elapsed: 0,
    delta: 0,
    getElapsedTime() {
      return this.elapsed;
    },
    getDelta() {
      return this.delta;
    },
  });
  const callbackRef = React.useRef(callback);
  React.useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  React.useLayoutEffect(() => {
    const rootId = store.getState().internal.rootId;
    const job = (state: FrameNextState, delta: number): void => {
      const onFrame = callbackRef.current;
      if (onFrame == null) {
        return;
      }
      const clock = clockRef.current;
      clock.elapsed += delta;
      clock.delta = delta;
      const legacyState = state as LegacyFrameState;
      legacyState.clock = clock;
      onFrame(legacyState, delta, currentXRFrame.value);
    };
    return scheduler.register(job, {
      ...registrationOptions,
      id: jobId,
      rootId,
    });
    // Only `optionsKey` (not `registrationOptions`) drives re-registration: the options object is
    // recreated from that key, so its identity carries no extra information.
  }, [store, scheduler, jobId, optionsKey]);
}
