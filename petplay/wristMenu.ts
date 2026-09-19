import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import type {
  WristMenuButtonId,
  WristMenuStateSnapshot,
} from "../classes/environment/wristMenu/types.ts";

type SetWristMenuStatePayload = Partial<WristMenuStateSnapshot>;

type WristMenuActionPayload = {
  id: WristMenuButtonId;
  active: boolean;
  state: WristMenuStateSnapshot;
};

const state = actorState({
  name: "wrist_menu",
  layoutActive: false,
  editActive: false,
  displayOverlayHostActor: null as string | null,
});

new PostMan(
  state,
  {
    __INIT__: (_payload: void) => {
      PostMan.setTopic("muffin");
    },
    GETWRISTMENUSTATE: (_payload: void) => getSnapshot(),
    SETWRISTMENUSTATE: (payload: SetWristMenuStatePayload) => {
      state.layoutActive = payload.layoutActive ?? state.layoutActive;
      state.editActive = payload.editActive ?? state.editActive;
      return getSnapshot();
    },
    SETDISPLAYOVERLAYHOSTACTOR: (payload: string | null) => {
      state.displayOverlayHostActor = payload;
      return getSnapshot();
    },
    TOGGLEWRISTMENUACTION: (payload: WristMenuButtonId) => {
      const active = toggle(payload);
      const snapshot = getSnapshot();
      notifyDisplayOverlayHost({
        id: payload,
        active,
        state: snapshot,
      });
      return snapshot;
    },
  } as const,
);

function getSnapshot(): WristMenuStateSnapshot {
  return {
    layoutActive: state.layoutActive,
    editActive: state.editActive,
  };
}

function toggle(id: WristMenuButtonId): boolean {
  switch (id) {
    case "layout":
      state.layoutActive = !state.layoutActive;
      return state.layoutActive;
    case "edit":
      state.editActive = !state.editActive;
      return state.editActive;
  }
}

function notifyDisplayOverlayHost(payload: WristMenuActionPayload) {
  if (!state.displayOverlayHostActor) {
    return;
  }
  try {
    PostMan.PostMessage({
      target: state.displayOverlayHostActor,
      type: "WRIST_MENU_ACTION",
      payload,
    });
  } catch (error) {
    LogChannel.log("actor", `[wristMenu] display overlay host notify failed: ${error}`);
  }
}
