/** Tiny local actor that forwards a request to another actor (so `fm` is an actor, not `System`). */
import { type ActorId, actorState, PostMan } from "../../submodules/stageforge/mod.ts";

const state = actorState({ name: "actorCaller" });

new PostMan(state, {
  CALL: (payload: { target: ActorId; type: string; payload: unknown }) =>
    PostMan.PostMessage(
      { target: payload.target, type: payload.type, payload: payload.payload },
      true,
    ),
});
