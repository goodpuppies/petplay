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
  focused: [] as string[],
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
  LISTWINDOWS: () => [
    {
      id: "win-discord",
      title: "Discord",
      app: "discord",
      pid: 42,
      x: 100,
      y: 100,
      width: 1200,
      height: 800,
      minimized: false,
      active: true,
      region: { x: 0.1, y: 0.1, width: 0.3, height: 0.5 },
    },
  ],
  FOCUSWINDOW: (payload: { window?: string } | null) => {
    if (payload?.window) state.focused = [...state.focused, payload.window];
    return true;
  },
  START: (payload: { monitor?: number; window?: string } | null) => {
    state.starts++;
    if (payload?.window) {
      return {
        host: "127.0.0.1",
        port: 4470,
        fingerprint: "mock-fp-win",
        code: `mock-iroh-code-${payload.window}`,
      };
    }
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
