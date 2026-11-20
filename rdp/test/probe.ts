/** Test actor: makes a request on the test's behalf (the main thread cannot reach remote actors). */
import { actorState, PostMan } from "../../submodules/stageforge/mod.ts";

const state = actorState({ name: "probe" });

new PostMan(state, {
  CALL: async ({ target, type, payload = null }: { target: string; type: string; payload?: unknown }) => {
    try {
      return { ok: true, value: await PostMan.PostMessage({ target, type, payload }, true) };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  },
} as const);
