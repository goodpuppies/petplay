import React from "react";
import { useFrame } from "@react-three/fiber/webgpu";
import { DesktopRemoteServer } from "../desktopRemoteServer.ts";
import { createSteamVrRemotePointer, type StereoInputContext } from "../steamVrRemotePointer.ts";
import { ControllerPoseGizmos } from "./controllerPoseGizmos.tsx";

/** Controls are rendered in PetPlay's live XR scene; the browser only sends raw input. */
export function SteamVrRemoteControls(
  { getContext, driverSocket, port, origin }: {
    getContext: () => StereoInputContext | null;
    driverSocket?: string;
    port: number;
    origin?: string;
  },
) {
  const active = React.useRef<ReturnType<typeof createSteamVrRemotePointer> | null>(null);
  const remote = React.useMemo(() => new DesktopRemoteServer(), []);
  useFrame(() => active.current?.update());
  React.useEffect(() => {
    const detach = remote.attach(() => {
      active.current?.destroy();
      const input = createSteamVrRemotePointer(getContext);
      active.current = input;
      return {
        receive: (value) => input.receive(value),
        cancel: () => input.cancel(),
        close: () => {
          input.destroy();
          if (active.current === input) active.current = null;
        },
      };
    });
    let server: Deno.HttpServer;
    try {
      server = Deno.serve({
        hostname: "127.0.0.1",
        port,
        onListen: () => console.log(`[remote-input] listening on 127.0.0.1:${port}`),
      }, (req) => {
        if (new URL(req.url).pathname !== "/input") {
          return new Response("Not found", { status: 404 });
        }
        return remote.handle(req, origin);
      });
    } catch (error) {
      detach();
      console.error("[remote-input]", error);
      return;
    }
    return () => {
      detach();
      active.current?.destroy();
      active.current = null;
      void server.shutdown();
    };
  }, [remote, getContext, port, origin]);
  return driverSocket ? <ControllerPoseGizmos socket={driverSocket} /> : null;
}
