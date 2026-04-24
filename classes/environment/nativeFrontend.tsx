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
  console.log("[wristMenu] NativeFrontend render");
  return <WristMenuPanel />;
}

export function NativeControllerHud({ actorId }: NativeControllerHudProps) {
  console.log("[wristMenu] NativeControllerHud render", { actorId });
  return <WristMenuControllerHud actorId={actorId} />;
}
