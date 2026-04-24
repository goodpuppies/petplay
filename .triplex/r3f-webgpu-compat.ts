export * from "@react-three/fiber/webgpu";

import {
  useFrame as useWebGPUFrame,
  useStore,
} from "@react-three/fiber/webgpu";

type FrameCallback = Parameters<typeof useWebGPUFrame>[0];
type FrameOptions = Parameters<typeof useWebGPUFrame>[1];

export function useFrame(
  callback: FrameCallback,
  options?: FrameOptions | number,
): ReturnType<typeof useWebGPUFrame> {
  const store = useStore();
  let elapsed = 0;
  let lastTime = performance.now();

  const wrappedCallback: FrameCallback = (state, delta, frame) => {
    const hasUsableClock =
      state &&
      typeof state === "object" &&
      "clock" in state &&
      state.clock &&
      typeof state.clock.getElapsedTime === "function";

    if (typeof delta === "number") {
      elapsed += delta;
    } else {
      const now = performance.now();
      elapsed += (now - lastTime) / 1000;
      lastTime = now;
    }

    const fallbackState = store.getState();
    const rootState = hasUsableClock
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
    return useWebGPUFrame(wrappedCallback, { priority: options });
  }

  return useWebGPUFrame(wrappedCallback, options);
}
