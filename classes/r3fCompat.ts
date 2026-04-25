export * from "npm:@react-three/fiber@10.0.0-alpha.2";

import {
  useFrame as useFiberFrame,
  useStore,
} from "npm:@react-three/fiber@10.0.0-alpha.2";
import type {
  FrameNextCallback,
  FrameNextState,
  UseFrameNextOptions,
} from "npm:@react-three/fiber@10.0.0-alpha.2";
import { currentXRFrame } from "./xrFrameBridge.ts";

/**
 * Legacy `useFrame` callback (R3F ≤9 / pmndrs packages): optional third argument is `XRFrame`.
 * R3F v10 only passes `(state, delta)`; this compat forwards {@link currentXRFrame} as the third argument.
 *
 * @see FrameNextCallback in `node_modules/@react-three/fiber/dist/index.d.ts`
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
): ReturnType<typeof useFiberFrame>;
export function useFrame(
  callback: LegacyUseFrameCallback,
  options?: UseFrameNextOptions | number,
): ReturnType<typeof useFiberFrame>;
export function useFrame(
  callback?: LegacyUseFrameCallback,
  options?: UseFrameNextOptions | number,
): ReturnType<typeof useFiberFrame> {
  if (callback === undefined) {
    if (typeof options === "number") {
      return useFiberFrame(undefined, { priority: options });
    }
    return useFiberFrame(undefined, options);
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
    return useFiberFrame(wrappedCallback, { priority: options });
  }

  return useFiberFrame(wrappedCallback, options);
}
