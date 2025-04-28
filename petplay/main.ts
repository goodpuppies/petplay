import { PostMan } from "../submodules/stageforge/mod.ts";
import { wait, assignActorHierarchy } from "../classes/utils.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { CustomLogger } from "../classes/customlogger.ts";
import { stat } from "node:fs";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";

//main process

type actionData = [
  OpenVR.InputPoseActionData,
  OpenVR.InputPoseActionData,
  OpenVR.InputDigitalActionData,
  OpenVR.InputDigitalActionData,
]

const state = {
  name: "main",
  ivroverlay: null as null | string,
  origin: null as null | string,
  overlays: [] as string[],
  socket: null as WebSocket | null
};

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
  //const updater = await PostMan.create("./frameUpdater.ts");
  const webupdater = await PostMan.create("./webUpdater.ts", import.meta.url);
  const vraggles = await PostMan.create("./genericoverlay.ts", import.meta.url)

  PostMan.PostMessage({
    target: input,
    type: "INITINPUT",
    payload: [ivrinput, ivroverlay]
  })
  PostMan.PostMessage({
    target: [hmd, webupdater],
    type: "INITOPENVR",
    payload: ivrsystem
  })

  PostMan.PostMessage({
    target: [origin, vraggles, laser],
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
      texture: "../resources/P1.png",
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
    target: webupdater,
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
  Deno.serve({ port: 8888 }, (req) => {
    if (req.headers.get("upgrade") != "websocket") {
      return new Response(null, { status: 501 }); // Not a WebSocket request
    }

    const { socket, response } = Deno.upgradeWebSocket(req);

    socket.addEventListener("open", () => {
      console.log("WebSocket client connected!");
      if (state.socket && state.socket.readyState !== WebSocket.CLOSED) {
        console.warn("Replacing existing WebSocket connection.");
        state.socket.close();
      }
      state.socket = socket;
    });

    socket.addEventListener("message", (event) => {
      console.log("Received message:", event.data);
      if (event.data === "ping") {
        socket.send("pong");
      }

    });
    socket.addEventListener("close", () => {
      console.log("WebSocket client disconnected.");
      if (state.socket === socket) {
        state.socket = null;
      }
    });
    socket.addEventListener("error", (err) => {
      console.error("WebSocket error:", err);
      if (state.socket === socket) {
        state.socket = null;
      }
    });

    return response; // Return the response to complete the upgrade
  })
}

async function spawnOvelay(name:string) {
  const overlay = await PostMan.create("./genericoverlay.ts");
  //setup
  PostMan.PostMessage({
    target: overlay,
    type: "INITOVROVERLAY",
    payload: state.ivroverlay
  })

  PostMan.PostMessage({
    target: state.origin as string,
    type: "ADDOVERLAY",
    payload: overlay,
  });

  PostMan.PostMessage({
    target: overlay,
    type: "STARTOVERLAY",
    payload: {
      name: name,
      texture: "./resources/P1.png",
      sync: true,
    },
  });
  state.overlays.push(overlay)
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

    sendcontroller(inputstate)

    await wait(10)
  }
}

function sendcontroller(pose: actionData) {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    try {
      // Replacer function to handle BigInt serialization
      const replacer = (key: string, value: any) =>
        typeof value === 'bigint'
          ? value.toString()
          : value; // return everything else unchanged

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