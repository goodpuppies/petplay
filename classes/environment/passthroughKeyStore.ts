/** Persisted key controls shared by the actor and live 3D scene. */
import { getSetting, setSetting, subscribeSettings } from "../settings.ts";
export function parsePassthroughKey(color: unknown): string | null {
  if (color === null) return null;
  if (typeof color !== "string" || !/^[0-9a-f]{6}$/i.test(color)) {
    throw new Error("passthrough key must be RRGGBB or null");
  }
  return color.toLowerCase();
}
export const getPassthroughKey = (): string | null => getSetting("passthroughKey");
export function setPassthroughKey(color: unknown): string | null {
  const key = parsePassthroughKey(color);
  setSetting("passthroughKey", key);
  return key;
}
export const subscribePassthroughKey = subscribeSettings;
