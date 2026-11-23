import { actorState, PostMan } from "../../submodules/stageforge/mod.ts";
import type { FeedInfo, WindowInfo } from "../desktopSource.ts";

const state = actorState({
  name: "desktopSource",
  machine: "test-host",
  kind: "desktop" as "desktop" | "vrchat",
  startedWindows: [] as string[],
  stoppedWindows: [] as string[],
  focusedWindows: [] as string[],
});

let inputActor: string | null = null;
const endSubscribers = new Set<string>();
const activeFeeds = new Map<string, FeedInfo>();

new PostMan(state, {
  __INIT__: () => {},
  CONFIGURE: (payload: { machine?: string; kind?: "desktop" | "vrchat"; input?: string | null }) => {
    if (payload.machine) state.machine = payload.machine;
    if (payload.kind) state.kind = payload.kind;
    if (payload.input !== undefined) inputActor = payload.input;
    return true;
  },
  DESCRIBE: () => ({
    machine: state.machine,
    kind: state.kind,
    input: inputActor,
    feed: activeFeeds.get("desktop") ?? null,
  }),
  LISTWINDOWS: (): WindowInfo[] => [
    {
      id: "win-1",
      title: "Browser",
      app: "firefox",
      x: 100,
      y: 100,
      width: 1000,
      height: 700,
      pid: 1234,
      active: true,
      minimized: false,
      region: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    },
  ],
  START: (payload?: { window?: string } | null): FeedInfo => {
    const key = payload?.window ?? "desktop";
    const info: FeedInfo = {
      host: "127.0.0.1",
      port: key === "desktop" ? 4460 : 4660,
      fingerprint: `fp-${state.machine}-${key}`,
      webrtc: true,
    };
    activeFeeds.set(key, info);
    if (payload?.window) state.startedWindows.push(payload.window);
    return info;
  },
  FEED: (payload?: { window?: string } | null): FeedInfo | null => {
    return activeFeeds.get(payload?.window ?? "desktop") ?? null;
  },
  STOP: (payload?: { window?: string } | null) => {
    const key = payload?.window ?? "desktop";
    activeFeeds.delete(key);
    if (payload?.window) state.stoppedWindows.push(payload.window);
    return true;
  },
  FOCUSWINDOW: (payload: { window: string }) => {
    state.focusedWindows.push(payload.window);
    return true;
  },
  WEBRTC_OFFER: (payload: { sdp: string; window?: string }) => ({
    sdp: `answer-for-${state.machine}-${payload.window ?? "desktop"}`,
  }),
  SUBSCRIBE_END: (payload: { actor?: string } | string) => {
    const actor = typeof payload === "string" ? payload : payload?.actor;
    if (actor) endSubscribers.add(actor);
    return true;
  },
  SIMULATE_WINDOW_CLOSE: (payload: { window: string }) => {
    activeFeeds.delete(payload.window);
    for (const target of endSubscribers) {
      PostMan.PostMessage({
        target,
        type: "FEED_ENDED",
        payload: { source: state.id, window: payload.window },
      });
    }
    return true;
  },
  __HEALTH__: () => ({ ...state }),
} as const);
