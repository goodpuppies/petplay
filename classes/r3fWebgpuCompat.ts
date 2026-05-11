export * from "npm:@react-three/fiber@10.0.0-alpha.2/webgpu";

import { useFrame as useWebGPUFrame, useStore } from "npm:@react-three/fiber@10.0.0-alpha.2/webgpu";
import type {
  FrameNextCallback,
  FrameNextState,
  UseFrameNextOptions,
} from "npm:@react-three/fiber@10.0.0-alpha.2/webgpu";
import { currentXRFrame } from "./xrFrameBridge.ts";

/**
 * Legacy `useFrame` callback: optional third argument is `XRFrame`.
 * R3F v10 `FrameNextCallback` is only `(state, delta)`; see `node_modules/@react-three/fiber/dist/webgpu/index.d.ts`.
 *
 * **v10 `UseFrameNextOptions` pass-through:** `phase`, `fps`, `drop`, `enabled`, `id`, etc. are
 * forwarded to `@react-three/fiber/webgpu` as-is. A **numeric** second argument is still treated as
 * `priority` for backwards compatibility.
 */
export type LegacyUseFrameCallback = (
  state: FrameNextState,
  delta: number,
  xrFrame?: XRFrame | null,
) => void;

function hasUsableClock(
  state: unknown,
): state is FrameNextState & { clock: { getElapsedTime(): number } } {
  return Boolean(
    state &&
      typeof state === "object" &&
      "clock" in state &&
      (state as { clock?: unknown }).clock &&
      typeof (state as { clock: { getElapsedTime?: unknown } }).clock.getElapsedTime === "function",
  );
}

export function useFrame(
  callback?: undefined,
  options?: UseFrameNextOptions | number,
): ReturnType<typeof useWebGPUFrame>;
export function useFrame(
  callback: LegacyUseFrameCallback,
  options?: UseFrameNextOptions | number,
): ReturnType<typeof useWebGPUFrame>;
export function useFrame(
  callback?: LegacyUseFrameCallback,
  options?: UseFrameNextOptions | number,
): ReturnType<typeof useWebGPUFrame> {
  if (callback === undefined) {
    if (typeof options === "number") {
      return useWebGPUFrame(undefined, { priority: options });
    }
    return useWebGPUFrame(undefined, options);
  }

  const store = useStore();
  let elapsed = 0;

  const wrappedCallback: FrameNextCallback = (state, delta) => {
    elapsed += delta;

    if (hasUsableClock(state)) {
      callback(state, delta, currentXRFrame.value);
      return;
    }

    const fallbackState = store.getState();

    const rootState = {
      ...fallbackState,
      ...(typeof state === "object" && state !== null ? state as object : {}),
      clock: {
        getElapsedTime: () => elapsed,
        getDelta: () => delta,
      },
    } as unknown as FrameNextState;

    callback(rootState, delta, currentXRFrame.value);
  };

  if (typeof options === "number") {
    return useWebGPUFrame(wrappedCallback, { priority: options });
  }

  return useWebGPUFrame(wrappedCallback, options);
}
