import React from "react";
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

export function NativeControllerHud({ actorId }: NativeControllerHudProps) {
  return <WristMenuControllerHud actorId={actorId} />;
}
