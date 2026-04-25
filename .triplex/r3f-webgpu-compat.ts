export * from "@react-three/fiber/webgpu";

import {
  useFrame as useWebGPUFrame,
  useStore,
} from "@react-three/fiber/webgpu";
import type {
  FrameNextCallback,
  FrameNextState,
  UseFrameNextOptions,
} from "@react-three/fiber/webgpu";
import { currentXRFrame } from "../classes/xrFrameBridge.ts";

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

    const fallbackState = store.getState();
    const rootState = hasUsableClock(state)
      ? state
      : ({
        ...fallbackState,
        ...(typeof state === "object" && state !== null ? state as object : {}),
        clock: {
          getElapsedTime: () => elapsed,
          getDelta: () => delta,
        },
      } as unknown as FrameNextState);

    callback(rootState, delta, currentXRFrame.value);
  };

  if (typeof options === "number") {
    return useWebGPUFrame(wrappedCallback, { priority: options });
  }

  return useWebGPUFrame(wrappedCallback, options);
}
