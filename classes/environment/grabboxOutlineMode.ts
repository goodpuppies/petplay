import { getSetting, setSetting, useSetting } from "../settings.ts";
import { useToolEditMode } from "./toolEditMode.ts";

/** Whether grab-box chrome draws. The interaction hull stays active either way. */
export function getGrabboxOutlineVisible(): boolean {
  return getSetting("grabboxOutline");
}

export function setGrabboxOutlineVisible(visible: boolean): void {
  setSetting("grabboxOutline", visible);
}

export function toggleGrabboxOutlineVisible(): boolean {
  setGrabboxOutlineVisible(!getGrabboxOutlineVisible());
  return getGrabboxOutlineVisible();
}

/** Drawn when the setting is on, and always in edit layout mode, where grab boxes are the point. */
export function useGrabboxOutlineVisible(): boolean {
  const setting = useSetting("grabboxOutline");
  return useToolEditMode() || setting;
}
