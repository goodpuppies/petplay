/** Test actor standing in for desktopSource: a running feed, nothing captured or encoded. */
import { actorState, PostMan } from "../../submodules/stageforge/mod.ts";

const state = actorState({ name: "desktopSource" });

new PostMan(state, {
  FEED: () => ({ host: "127.0.0.1", port: 4999, fingerprint: "ab:cd" }),
} as const);
