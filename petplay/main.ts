import { PostMan } from "../submodules/stageforge/mod.ts";
import { wait, assignActorHierarchy } from "../classes/utils.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { CustomLogger } from "../classes/customlogger.ts";
import { stat } from "node:fs";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { createWebSocketServer, WebSocketServerController } from "../classes/sock.ts";
import { ToAddress } from "../submodules/stageforge/src/lib/types.ts";
import { multiplyMatrix } from "../classes/matrixutils.ts";

const state = {
  name: "main",
  ivroverlay: null as null | string,
  origin: null as null | string,
  overlays: [] as string[],
  socket: null as WebSocketServerController | null,
  menusocket: null as WebSocketServerController | null,
  inputstate: null as actionData | null,
  desktopOverlay: {} as desktopoverlay,
  updater: null as string | null
};

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
            CustomLogger.log("error", "Usage: /spawn [type] [name]");
            return;
          }

          const spawnType = parts[1];
          const spawnName = parts[2];

          if (spawnType === 'overlay') {
            spawnOvelay(spawnName);
            CustomLogger.log("actor", `Spawning overlay: ${spawnName}`);
          } else {
            CustomLogger.log("error", `Unknown spawn type: ${spawnType}`);
          }
          break;
        }
        case '/localframe': {
          if (parts.length < 3) {
            CustomLogger.log("error", "Usage: /assignframe [updater] [overlay]");
            return;
          }

          const source = parts[1];
          const overlay = parts[2];

          assignFrame(source, overlay);
          CustomLogger.log("actor", `Assigning frame from ${source} to overlay ${overlay}`);
          break;
        }
        case '/remoteframe': {
          if (parts.length < 4) {
            CustomLogger.log("error", "Usage: /remoteframe [updater] [source] [overlay]");
            return;
          }

          const updater = parts[1];
          const source = parts[2]
          const overlay = parts[3];

          assignFrame(updater, overlay, source);
          CustomLogger.log("actor", `Assigning frame from ${source} to overlay ${overlay}`);
          break;
        }
        case '/inspect': {
          console.log(PostMan.state.addressBook);
          break;
        }
        default:
          CustomLogger.log("error", `Unknown command: ${command}`);
      }
    } else {
      CustomLogger.log("actor", "stdin:", payload);
    }
  },
} as const);

async function main() {

  const startTime = performance.now();
  CustomLogger.log("default", "creating scene");

  await PostMan.create("./frontend.ts", import.meta.url)

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
  state.origin = origin as string
  const laser = await PostMan.create("./laser.ts", import.meta.url);
  const osc = await PostMan.create("./OSC.ts", import.meta.url);
  const updater = await PostMan.create("./frameUpdater.ts", import.meta.url);
  state.updater = updater
  const webxr = await PostMan.create("./webUpdater.ts", import.meta.url);
  const vraggles = await PostMan.create("./genericoverlay.ts", import.meta.url)

  PostMan.PostMessage({
    target: input,
    type: "INITINPUT",
    payload: [ivrinput, ivroverlay]
  })
  PostMan.PostMessage({
    target: [hmd, webxr],
    type: "INITOPENVR",
    payload: ivrsystem
  })

  PostMan.PostMessage({
    target: [origin, laser, vraggles], //
    type: "INITOVROVERLAY",
    payload: ivroverlay
  })
  //await wait(1000)
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

  /* PostMan.PostMessage({
  target: origin,
  type: "ADDOVERLAY",
  payload: dogoverlay1,
  });
  /* PostMan.PostMessage({
    target: dogoverlay1,
    type: "STARTOVERLAY",
    payload: {
      name: "pet1",
      texture: "../resources/P1.png",
      sync: true,
    },
  });
  PostMan.PostMessage({
    target: dogoverlay2,
    type: "STARTOVERLAY",
    payload: {
      name: "pet2",
      texture: "../resources/P2.png",
      sync: true,
    },
  });
  const handle = await PostMan.PostMessage({
    target: dogoverlay1,
    type: "GETOVERLAYHANDLE",
    payload: null
  }, true);
  PostMan.PostMessage({
    target: updater,
    type: "STARTUPDATER",
    payload: {
      overlayclass: ivroverlay,
      overlayhandle: handle,
    }
  })
  await wait(3000)

  const handle2 = await PostMan.PostMessage({
    target: dogoverlay2,
    type: "GETOVERLAYHANDLE",
    payload: null
  }, true);
  PostMan.PostMessage({
    target: updater2,
    type: "STARTUPDATER",
    payload: {
      overlayclass: ivroverlay,
      overlayhandle: handle2,
      framesource: updater
    }
  }) */


  PostMan.PostMessage({
    target: vraggles,
    type: "STARTOVERLAY",
    payload: {
      name: "pet1",
      texture: "./resources/P1.png",
      sync: true,
    },
  });
  const handle = await PostMan.PostMessage({
    target: vraggles,
    type: "GETOVERLAYHANDLE",
    payload: null
  }, true);
  PostMan.PostMessage({
    target: webxr,
    type: "STARTUPDATER",
    payload: {
      overlayclass: ivroverlay,
      overlayhandle: handle,
    }
  })
  /* PostMan.PostMessage({
    target: hmd,
    type: "ASSIGNWEB",
    payload: webupdater
  }) */



  const endTime = performance.now();
  const timeElapsed = Math.round(endTime - startTime);
  CustomLogger.log("default", `scene created in ${timeElapsed} ms`);
  //state.overlays.push(vraggles)
  //state.overlays.push(dogoverlay2)
  inputloop(input);

  state.socket = createWebSocketServer(8888);

  state.menusocket = createWebSocketServer(8889);

  if (state.menusocket) {
  state.menusocket.onmessage = (socket, event) => {
    try {
      const message = JSON.parse(event.data);
      CustomLogger.log("network", `Received menu state: ${JSON.stringify(message)}`);

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
      CustomLogger.log("error", `Failed to parse or handle menu message: ${error}`);
      CustomLogger.log("error", `Raw message data: ${event.data}`);
    }
  };
  }

}

function setDesktopOverlayEnabled(enabled: boolean) {
  // Only update and react if the value actually changes
  console.log("set", enabled)
  if (state.desktopOverlay.enabled !== enabled) {
    state.desktopOverlay.enabled = enabled;
    CustomLogger.log("info", `Desktop overlay enabled state changed to: ${enabled}`);

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

async function spawnOvelay(name: string): Promise<ToAddress> {
  CustomLogger.log("actor", `Attempting to spawn overlay with name: ${name}`);
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
        [1.0000000,  0.0000000,  0.0000000, 0],
        [0.0000000,  0.7071068,  0.7071068, 0],
        [0.0000000, -0.7071068, 0.7071068, 0]
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

    sendcontroller(inputstate)

    await wait(10)
  }
}

function sendcontroller(pose: actionData) {
  if (state.socket && state.socket.hasClients()) {
  try {
    const replacer = (key: string, value: any) =>
    typeof value === 'bigint'
      ? value.toString()
      : value;

    state.socket.send(JSON.stringify(pose, replacer));

  } catch (error) {
    console.error("Error sending controller data:", error);
    // Decide if re-throwing is necessary or just log the error
    // throw new Error("wtf" ) 
  }
  } else {
  // Optional: Log if the socket is not open or available
  // console.warn("WebSocket not open, cannot send controller data.");
  }
}

type actionData = [
  OpenVR.InputPoseActionData,
  OpenVR.InputPoseActionData,
  OpenVR.InputDigitalActionData,
  OpenVR.InputDigitalActionData,
]