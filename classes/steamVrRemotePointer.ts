import * as THREE from "three";
import { forwardHtmlEvents } from "@pmndrs/pointer-events";
import { type DesktopPointerMessage, DesktopRemotePointer } from "./desktopRemotePointer.ts";
import { installSyntheticDomEventPolyfills, SyntheticCanvas } from "./desktopPointerSurface.ts";
export type StereoInputContext = {
  scene: THREE.Scene;
  leftCamera: THREE.Camera;
  rightCamera: THREE.Camera;
};
/** Raycast the same PetPlay scene with the same eye cameras used to render SteamVR. */
export function createSteamVrRemotePointer(getContext: () => StereoInputContext | null) {
  installSyntheticDomEventPolyfills();
  const context = getContext();
  if (!context) throw Error("SteamVR eye cameras not ready");
  const surfaces = [
    new SyntheticCanvas(1000, 1000, "[remote-left]"),
    new SyntheticCanvas(1000, 1000, "[remote-right]"),
  ];
  const eyes = [0, 1].map((eye) => {
    const bridge = forwardHtmlEvents(
      surfaces[eye] as never,
      () => {
        const current = getContext() ?? context;
        return (eye === 0 ? current.leftCamera : current.rightCamera) as THREE.PerspectiveCamera;
      },
      context.scene,
      { batchEvents: false, intersectEveryFrame: true },
    );
    const input = new DesktopRemotePointer(surfaces[eye], `steamvr-eye-${eye}`);
    return { bridge, input };
  });
  let lastSequence = -1;
  const pointers = new Map<number, { eye: number; buttons: number }>();
  return {
    receive(value: unknown) {
      if (!getContext()) throw Error("SteamVR eye cameras unavailable");
      if (!value || typeof value !== "object") throw Error("Invalid pointer message");
      const message = value as DesktopPointerMessage;
      if (
        message.viewport !== "steamvr-stereo" || !Number.isFinite(message.x) ||
        !Number.isSafeInteger(message.sequence) || message.sequence <= lastSequence
      ) {
        throw Error("Wrong SteamVR viewport");
      }
      const previous = pointers.get(message.pointerId);
      // Keep a drag in its original eye even when it crosses the stereo seam.
      const eye = previous?.buttons ? previous.eye : message.x < .5 ? 0 : 1;
      if (previous && previous.eye !== eye) {
        eyes[previous.eye].input.cancelPointer(message.pointerId);
      }
      eyes[eye].input.receive({
        ...message,
        viewport: `steamvr-eye-${eye}`,
        x: message.x * 2 - eye,
      });
      lastSequence = message.sequence;
      eyes[eye].bridge.update();
      pointers.set(message.pointerId, { eye, buttons: message.buttons });
      if (message.type === "pointercancel" || message.type === "pointerleave" && !message.buttons) {
        pointers.delete(message.pointerId);
      }
    },
    update() {
      if (!getContext()) {
        this.cancel();
        return;
      }
      for (const eye of eyes) eye.bridge.update();
    },
    cancel() {
      for (const eye of eyes) eye.input.cancel();
      pointers.clear();
    },
    destroy() {
      this.cancel();
      for (const eye of eyes) eye.bridge.destroy();
    },
  };
}
