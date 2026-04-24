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
  layersActive: false,
  musicActive: false,
  signalActive: false,
  desktopOverlayActor: null as string | null,
});

new PostMan(
  state,
  {
    __INIT__: (_payload: void) => {
      PostMan.setTopic("muffin");
    },
    GETWRISTMENUSTATE: (_payload: void) => getSnapshot(),
    SETWRISTMENUSTATE: (payload: SetWristMenuStatePayload) => {
      state.layersActive = payload.layersActive ?? state.layersActive;
      state.musicActive = payload.musicActive ?? state.musicActive;
      state.signalActive = payload.signalActive ?? state.signalActive;
      return getSnapshot();
    },
    SETDESKTOPOVERLAYACTOR: (payload: string | null) => {
      state.desktopOverlayActor = payload;
      return getSnapshot();
    },
    TOGGLEWRISTMENUACTION: (payload: WristMenuButtonId) => {
      const active = toggle(payload);
      const snapshot = getSnapshot();
      notifyDesktopOverlay({
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
    layersActive: state.layersActive,
    musicActive: state.musicActive,
    signalActive: state.signalActive,
  };
}

function toggle(id: WristMenuButtonId): boolean {
  switch (id) {
    case "layers":
      state.layersActive = !state.layersActive;
      return state.layersActive;
    case "music":
      state.musicActive = !state.musicActive;
      return state.musicActive;
    case "signal":
      state.signalActive = !state.signalActive;
      return state.signalActive;
  }
}

function notifyDesktopOverlay(payload: WristMenuActionPayload) {
  if (!state.desktopOverlayActor) {
    return;
  }
  try {
    PostMan.PostMessage({
      target: state.desktopOverlayActor,
      type: "WRIST_MENU_ACTION",
      payload,
    });
  } catch (error) {
    LogChannel.log("actor", `[wristMenu] desktop overlay notify failed: ${error}`);
  }
}
