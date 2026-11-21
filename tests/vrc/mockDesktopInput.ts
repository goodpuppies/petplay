/**
 * Stand-in desktopInput for synthesized E2E sharing tests: records received `INPUT` events
 * without touching uinput/SendInput.
 */
import { actorState, PostMan } from "../../submodules/stageforge/mod.ts";

const state = actorState({
  name: "mockDesktopInput",
  events: [] as unknown[],
});

new PostMan(state, {
  INPUT: (event: unknown) => {
    state.events.push(event);
    return true;
  },
  EVENTS: () => [...state.events],
});
