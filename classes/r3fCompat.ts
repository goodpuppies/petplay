export * from "npm:@react-three/fiber@10.0.0-alpha.2";

import {
  useFrame as useFiberFrame,
  useStore,
} from "npm:@react-three/fiber@10.0.0-alpha.2";

type FrameCallback = Parameters<typeof useFiberFrame>[0];
type FrameOptions = Parameters<typeof useFiberFrame>[1];

function hasUsableClock(state: unknown): state is { clock: { getElapsedTime(): number } } {
  return Boolean(
    state &&
      typeof state === "object" &&
      "clock" in state &&
      (state as { clock?: unknown }).clock &&
      typeof (state as { clock: { getElapsedTime?: unknown } }).clock.getElapsedTime === "function",
  );
}

export function useFrame(
  callback: FrameCallback,
  options?: FrameOptions | number,
): ReturnType<typeof useFiberFrame> {
  const store = useStore();
  let elapsed = 0;
  let lastTime = performance.now();

  const wrappedCallback: FrameCallback = (state, delta, frame) => {
    if (typeof delta === "number") {
      elapsed += delta;
    } else {
      const now = performance.now();
      elapsed += (now - lastTime) / 1000;
      lastTime = now;
    }

    const fallbackState = store.getState();
    const rootState = hasUsableClock(state)
      ? state
      : {
        ...fallbackState,
        ...(state && typeof state === "object" ? state : {}),
        clock: {
          ...fallbackState.clock,
          getElapsedTime: () => elapsed,
        },
      };

    return callback(rootState, delta, frame);
  };

  if (typeof options === "number") {
    return useFiberFrame(wrappedCallback, { priority: options });
  }

  return useFiberFrame(wrappedCallback, options);
}
