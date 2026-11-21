/**
 * Stand-in desktopSource for synthesized E2E sharing tests: reports two virtual monitors
 * (`DISPLAY1` and `DISPLAY2`) with regions and returns synthetic feed descriptors without
 * touching real screen capture.
 */
import { actorState, PostMan } from "../../submodules/stageforge/mod.ts";

const state = actorState({
  name: "mockDesktopSource",
  starts: 0,
  stops: 0,
});

new PostMan(state, {
  DESCRIBE: () => ({
    machine: "AlicePC",
    audio: false,
    screens: [
      {
        index: 0,
        name: "DISPLAY1",
        primary: true,
        width: 1920,
        height: 1080,
        region: { x: 0, y: 0, width: 0.5, height: 1 },
      },
      {
        index: 1,
        name: "DISPLAY2",
        primary: false,
        width: 1920,
        height: 1080,
        region: { x: 0.5, y: 0, width: 0.5, height: 1 },
      },
    ],
  }),
  START: (payload: { monitor?: number } | null) => {
    state.starts++;
    const idx = payload?.monitor ?? 0;
    return {
      host: "127.0.0.1",
      port: 4460 + idx,
      fingerprint: "mock-fp",
      code: `mock-iroh-code-${idx}`,
    };
  },
  FEED: () => null,
  STOP: () => {
    state.stops++;
    return true;
  },
  AUDIO: () => null,
  STOPAUDIO: () => true,
});
