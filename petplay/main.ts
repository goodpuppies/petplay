import { PostMan, actorState } from "../submodules/stageforge/mod.ts";
import { wait, assignActorHierarchy } from "../classes/utils.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import { createWebSocketServer, WebSocketServerController } from "../classes/sock.ts";
import { ActorId } from "../submodules/stageforge/src/lib/types.ts";
import { multiplyMatrix } from "../classes/matrixutils.ts";

const state = actorState({
  name: "main",
  ivroverlay: null as null | string,
  origin: null as null | ActorId,
  overlays: [] as string[],
  socket: null as WebSocketServerController | null,
  menusocket: null as WebSocketServerController | null,
  inputstate: null as actionData | null,
  desktopOverlay: {} as desktopoverlay,
  updater: null as string | null,
  frontend: null as string | null
});

interface desktopoverlay {
  overlay: string;
  frameupdater: string;
  enabled: boolean;  
}

new PostMan(state, {
  MAIN: (_payload: string) => {
    PostMan.setTopic("muffin")
    main();
  },
  STDIN: (payload: string) => {
    const input = payload.trim();

    // Handle commands that start with "/"
    if (input.startsWith('/')) {
      const parts = input.split(' ');
      const command = parts[0].toLowerCase();

      switch (command) {
        case '/spawn':{
          if (parts.length < 3) {
            LogChannel.log("error", "Usage: /spawn [type] [name]");
            return;
          }

          const spawnType = parts[1];
          const spawnName = parts[2];

          if (spawnType === 'overlay') {
            spawnOvelay(spawnName);
            LogChannel.log("actor", `Spawning overlay: ${spawnName}`);
          } else {
            LogChannel.log("error", `Unknown spawn type: ${spawnType}`);
          }
          break;
        }
        case '/localframe': {
          if (parts.length < 3) {
            LogChannel.log("error", "Usage: /assignframe [updater] [overlay]");
            return;
          }

          const source = parts[1];
          const overlay = parts[2];

          assignFrame(source, overlay);
          LogChannel.log("actor", `Assigning frame from ${source} to overlay ${overlay}`);
          break;
        }
        case '/remoteframe': {
          if (parts.length < 4) {
            LogChannel.log("error", "Usage: /remoteframe [updater] [source] [overlay]");
            return;
          }

          const updater = parts[1];
          const source = parts[2]
          const overlay = parts[3];

          assignFrame(updater, overlay, source);
          LogChannel.log("actor", `Assigning frame from ${source} to overlay ${overlay}`);
          break;
        }
        case '/inspect': {
          console.log(state.addressBook);
          break;
        }
        default:
          LogChannel.log("error", `Unknown command: ${command}`);
      }
    } else {
      LogChannel.log("actor", "stdin:", payload);
    }
  },
} as const);

async function main() {

  const startTime = performance.now();
  LogChannel.log("default", "creating scene");

  state.frontend = await PostMan.create("./frontend.ts", import.meta.url)

  const ivr = await PostMan.create("./OpenVR.ts", import.meta.url)
  const ivrsystem = await PostMan.PostMessage({
    target: ivr,
    type: "GETOPENVRPTR",
    payload: null
  }, true)
  const ivroverlay = await PostMan.PostMessage({
    target: ivr,
    type: "GETOVERLAYPTR",
    payload: null
  }, true)
  const ivrinput = await PostMan.PostMessage({
    target: ivr,
    type: "GETINPUTPTR",
    payload: null
  }, true)
  state.ivroverlay = ivroverlay as string

  const hmd = await PostMan.create("./hmd.ts", import.meta.url);
  const input = await PostMan.create("./controllers.ts", import.meta.url);
  const origin = await PostMan.create("./VRCOrigin.ts", import.meta.url);
  state.origin = origin
  const laser = await PostMan.create("./laser.ts", import.meta.url);
  const osc = await PostMan.create("./OSC.ts", import.meta.url);
  const updater = await PostMan.create("./frameUpdater.ts", import.meta.url);
  state.updater = updater
  const webxr = await PostMan.create("./webUpdaterDirect.ts", import.meta.url);



  PostMan.PostMessage({
    target: input,
    type: "INITINPUT",
    payload: [ivrinput, ivroverlay]
  })
  PostMan.PostMessage({
    target: [hmd],
    type: "INITOPENVR",
    payload: ivrsystem
  })

  PostMan.PostMessage({
    target: [origin, laser, webxr],
    type: "INITOVROVERLAY",
    payload: ivroverlay
  })
  PostMan.PostMessage({
    target: webxr,
    type: "STARTWEBUPDATER",
    payload: { url: "http://localhost:5173" }
  })

  PostMan.PostMessage({
    target: origin,
    type: "ASSIGNVRC",
    payload: osc,
  });
  PostMan.PostMessage({
    target: origin,
    type: "ASSIGNHMD",
    payload: hmd,
  });
  PostMan.PostMessage({
    target: laser,
    type: "ASSIGNINPUT",
    payload: input,
  });
  PostMan.PostMessage({
    target: origin,
    type: "STARTORIGIN",
    payload: {
      name: "originoverlay",
      texture: "./resources/PetPlay.png",
    },
  });
  PostMan.PostMessage({
    target: laser,
    type: "STARTLASERS",
    payload: null
  });



  const endTime = performance.now();
  const timeElapsed = Math.round(endTime - startTime);
  LogChannel.log("default", `scene created in ${timeElapsed} ms`);

  inputloop(input);

  state.socket = createWebSocketServer(8888);

  state.menusocket = createWebSocketServer(8889);

  if (state.menusocket) {
  state.menusocket.onmessage = (socket, event) => {
    try {
      const message = JSON.parse(event.data);
      LogChannel.log("network", `Received menu state: ${JSON.stringify(message)}`);

      if (message.type === 'uiState') {
        if (message.layersActive) {
          if (!state.desktopOverlay.overlay) {
            spawnDesktopOvelay(`desktopoverlay`);
          } else {
            setDesktopOverlayEnabled(true)
          }
        } else {
          setDesktopOverlayEnabled(false)
        }
      }
    } catch (error) {
      LogChannel.log("error", `Failed to parse or handle menu message: ${error}`);
      LogChannel.log("error", `Raw message data: ${event.data}`);
    }
  };
  }

}

function setDesktopOverlayEnabled(enabled: boolean) {
  // Only update and react if the value actually changes
  console.log("set", enabled)
  if (state.desktopOverlay.enabled !== enabled) {
    state.desktopOverlay.enabled = enabled;
    LogChannel.log("info", `Desktop overlay enabled state changed to: ${enabled}`);

    // --- Add your reactive logic here ---
    // For example, show/hide the overlay actor, send a message, etc.
    if (state.desktopOverlay.frameupdater) {
      PostMan.PostMessage({
        target: state.desktopOverlay.frameupdater,
        type: "TOGGLE",
        payload: state.desktopOverlay.enabled
      })
    }
  }
}

async function spawnOvelay(name: string): Promise<ActorId> {
  LogChannel.log("actor", `Attempting to spawn overlay with name: ${name}`);
  const overlay = await PostMan.create("./genericoverlay.ts", import.meta.url);
  PostMan.PostMessage({
    target: overlay,
    type: "INITOVROVERLAY",
    payload: state.ivroverlay
  })

  PostMan.PostMessage({
    target: overlay,
    type: "STARTOVERLAY",
    payload: {
      name: name,
      texture: "./resources/P1.png",
      sync: false,
    },
  });

  PostMan.PostMessage({
    target: state.origin!,
    type: "ADDOVERLAY",
    payload: overlay,
  });

  PostMan.PostMessage({
    target: overlay,
    type: "SETOVERLAYLOCATION",
    payload: state.inputstate![0].pose.mDeviceToAbsoluteTracking,
  });


  //state.overlays.push(overlay);
  return overlay
}

async function spawnDesktopOvelay(name: string){
  const overlay = await spawnOvelay(name)
  const handle = await PostMan.PostMessage({
    target: overlay,
    type: "GETOVERLAYHANDLE",
    payload: null
  }, true);
  if (!state.updater) throw new Error("no frame updater")
  PostMan.PostMessage({
    target: state.updater,
    type: "STARTUPDATER",
    payload: {
      overlayclass: state.ivroverlay,
      overlayhandle: handle,
    }
  })
  state.overlays.push(overlay)
  state.desktopOverlay.frameupdater = state.updater
  state.desktopOverlay.overlay = overlay
  setDesktopOverlayEnabled(true)
}

async function assignFrame(source: string, overlay: string, remote?:string) {
  
  const handle = await PostMan.PostMessage({
    target: overlay,
    type: "GETOVERLAYHANDLE",
    payload: null
  }, true);

  if (!remote) {
    PostMan.PostMessage({
      target: source,
      type: "STARTUPDATER",
      payload: {
        overlayclass: state.ivroverlay,
        overlayhandle: handle,
      }
    })
  }
  else {
    PostMan.PostMessage({
      target: source,
      type: "STARTUPDATER",
      payload: {
        overlayclass: state.ivroverlay,
        overlayhandle: handle,
        framesource: remote
      }
    })
  }
}

async function inputloop(inputactor: string) {

  while (true) {
    const inputstate = await PostMan.PostMessage({
      target: inputactor,
      type: "GETCONTROLLERDATA",
      payload: null,
    }, true) as actionData
    state.inputstate = inputstate

    if (state.overlays.length > 0) {

      if (inputstate[2].bState == 1) {
      PostMan.PostMessage({
        target: state.overlays,
        type: "SETOVERLAYLOCATION",
        payload: inputstate[0].pose.mDeviceToAbsoluteTracking,
      });
      } else if (inputstate[3].bState == 1) {
      PostMan.PostMessage({
        target: state.overlays,
        type: "SETOVERLAYLOCATION",
        payload: inputstate[1].pose.mDeviceToAbsoluteTracking,
      });
      }

      await wait(10);
    }

    //#region JANK
    const transformer: OpenVR.HmdMatrix34 = {
      m: [
        [1.0000000,  0.0000000,  0.0000000, 0.01],
        [0.0000000,  0.7071068,  0.7071068, -0.05],
        [0.0000000, -0.7071068, 0.7071068, 0.01]
      ]
    };

    const controller1: OpenVR.HmdMatrix34 = {
      m: [
        [...inputstate[0].pose.mDeviceToAbsoluteTracking.m[0]],
        [...inputstate[0].pose.mDeviceToAbsoluteTracking.m[1]],
        [...inputstate[0].pose.mDeviceToAbsoluteTracking.m[2]]
      ]
    };
    const controller2: OpenVR.HmdMatrix34 = {
      m: [
        [...inputstate[1].pose.mDeviceToAbsoluteTracking.m[0]],
        [...inputstate[1].pose.mDeviceToAbsoluteTracking.m[1]],
        [...inputstate[1].pose.mDeviceToAbsoluteTracking.m[2]]
      ]
    };

    const controller1mod = multiplyMatrix(controller1, transformer)
    const controller2mod = multiplyMatrix(controller2, transformer)

    inputstate[0].pose.mDeviceToAbsoluteTracking = controller1mod
    inputstate[1].pose.mDeviceToAbsoluteTracking = controller2mod
    //#endregion

    await wait(10)
  }
}

type actionData = [
  OpenVR.InputPoseActionData,
  OpenVR.InputPoseActionData,
  OpenVR.InputDigitalActionData,
  OpenVR.InputDigitalActionData,
]