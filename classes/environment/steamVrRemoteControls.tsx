import React from "react";
import { useFrame } from "@react-three/fiber/webgpu";
import { DesktopRemoteServer } from "../desktopRemoteServer.ts";
import { createSteamVrRemotePointer, type StereoInputContext } from "../steamVrRemotePointer.ts";
import { type ControllerButton, ControllerPoseGizmos } from "./controllerPoseGizmos.tsx";

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
  const controllerButton = React.useRef<((button: ControllerButton) => Promise<void>) | null>(null);
  const remote = React.useMemo(() => new DesktopRemoteServer(), []);
  useFrame(() => active.current?.update());
  React.useEffect(() => {
    const detach = remote.attach(() => {
      active.current?.destroy();
      const input = createSteamVrRemotePointer(getContext);
      active.current = input;
      return {
        receive: (value) => {
          const message = value as { type?: unknown; button?: unknown } | null;
          if (driverSocket && message?.type === "controller-button") {
            const { button } = message;
            if (button === "dashboard" || button === "left-trigger" || button === "right-trigger") {
              void controllerButton.current?.(button).catch((error) => {
                console.warn("[remote-input] controller button", error);
              });
              return;
            }
          }
          input.receive(value);
        },
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
        return remote.handle(req, origin, Boolean(driverSocket));
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
  }, [remote, getContext, port, origin, driverSocket]);
  return driverSocket
    ? <ControllerPoseGizmos socket={driverSocket} onButton={controllerButton} />
    : null;
}
