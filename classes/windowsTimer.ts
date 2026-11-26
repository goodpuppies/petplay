/**
 * Requests 1 ms OS timer resolution on Windows (`winmm.dll` `timeBeginPeriod(1)`).
 *
 * Windows defaults to a 15.6 ms system timer quantum, which causes `setTimeout` / `wait(1..10)`
 * in frame pacers and `vsync-locked` latch holds to oversleep and halve 75–90 Hz VR frame rates.
 * Calling `acquireWindowsHighResTimer()` returns a release callback that balances with
 * `timeEndPeriod(1)` (Windows also automatically releases on process exit).
 */
const symbols = {
  timeBeginPeriod: { parameters: ["u32"], result: "u32" },
  timeEndPeriod: { parameters: ["u32"], result: "u32" },
} as const;

let winmm: Deno.DynamicLibrary<typeof symbols> | null = null;
let refCount = 0;

export function acquireWindowsHighResTimer(): () => void {
  if (Deno.build.os !== "windows") return () => {};
  try {
    winmm ??= Deno.dlopen("winmm.dll", symbols);
    if (refCount === 0) {
      winmm.symbols.timeBeginPeriod(1);
    }
    refCount++;
  } catch {
    return () => {};
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0 && winmm) {
      try {
        winmm.symbols.timeEndPeriod(1);
      } catch {
        // Ignore teardown errors.
      }
    }
  };
}
