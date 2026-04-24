import { actorState, PostMan } from "../submodules/stageforge/mod.ts";

const state = actorState({
  name: "display_instance",
});

new PostMan(
  state,
  {
    __INIT__: (_payload: void) => {
      PostMan.setTopic("muffin");
    },
  } as const,
);
