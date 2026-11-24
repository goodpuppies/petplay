import React from "react";
import { useXRInputSourceStateContext } from "@react-three/xr";
import { useSetting } from "../settings.ts";
import { PetplayDefaultXRController } from "./petplayXrController.tsx";
import {
  WristMenuControllerHud,
  WristMenuPanel,
  type WristMenuTransform,
} from "./wristMenu/logic.tsx";

export type NativeHudTransform = WristMenuTransform;
export type NativeControllerHudProps = {
  actorId?: string | null;
};

export const NativeHudPanel = WristMenuPanel;

export function NativeFrontend() {
  return <WristMenuPanel />;
}

/** Either controller: the one named by the `wristMenuHand` setting wears the wrist menu. */
export function NativeControllerHud({ actorId }: NativeControllerHudProps) {
  const handedness = useXRInputSourceStateContext().inputSource.handedness;
  const wristHand = useSetting("wristMenuHand");
  return handedness === wristHand
    ? <WristMenuControllerHud actorId={actorId} />
    : <PetplayDefaultXRController model={false} rayPointer={{ minDistance: -1 }} />;
}
