/**
 * How sharp PetPlay renders, relative to what SteamVR asks for.
 *
 * The eye targets follow SteamVR's recommended size (`GetRecommendedRenderTargetSize`, which
 * already includes SteamVR's own resolution setting). Some headsets look fine at that size (a
 * Bigscreen Beyond at native); others want more (a Quest 3 over Steam Link). So the scale is saved
 * per recommended size, "<width>x<height>": changing headset, or SteamVR's resolution, picks up
 * that size's own scale.
 *
 * Module state lives in the webxr worker, which both renders and runs the wrist menu.
 */
import { useSyncExternalStore } from "react";
import { getSetting, setSetting, subscribeSettings } from "./settings.ts";

/** The steps the Settings page cycles through. */
export const RENDER_SCALE_STEPS = [1, 1.25, 1.5, 1.75, 2] as const;
/** Largest eye target, in pixels per side: VRAM grows with the square of it. */
export const MAX_EYE_SIZE = 4096;

let recommended: { width: number; height: number } | null = null;
const listeners = new Set<() => void>();

/** SteamVR's recommended per-eye size, once the headset is known. */
export function setRecommendedEyeSize(width: number, height: number): void {
  const valid = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0;
  const next = valid ? { width, height } : null;
  if (next?.width === recommended?.width && next?.height === recommended?.height) return;
  recommended = next;
  for (const listener of listeners) listener();
}

/** The key the scale is saved under: the recommended size, or `null` before a headset is known. */
export function renderResolutionKey(): string | null {
  return recommended == null ? null : `${recommended.width}x${recommended.height}`;
}

export function getRenderScale(): number {
  const key = renderResolutionKey();
  return key == null ? 1 : getSetting("renderScaleByResolution")[key] ?? 1;
}

/** Saves `scale` for the current recommended size; 1 (SteamVR's own) removes the entry. */
export function setRenderScale(scale: number): void {
  const key = renderResolutionKey();
  if (key == null) return;
  const next = { ...getSetting("renderScaleByResolution") };
  if (scale === 1) delete next[key];
  else next[key] = scale;
  setSetting("renderScaleByResolution", next);
}

/** `base` (the square eye SteamVR's size calls for) at the saved scale, within the limit. */
export function scaledEyeSize(base: number, scale = getRenderScale()): number {
  return Math.min(MAX_EYE_SIZE, Math.round(base * scale));
}

/** The square eye the recommended size calls for, before scaling; `null` before a headset. */
export function baseEyeSize(): number | null {
  return recommended == null ? null : Math.max(recommended.width, recommended.height);
}

export function subscribeRenderResolution(listener: () => void): () => void {
  listeners.add(listener);
  const unsubscribeSettings = subscribeSettings(listener);
  return () => {
    listeners.delete(listener);
    unsubscribeSettings();
  };
}

/** For the Settings page: the key, the scale, and the resulting eye size. */
export function useRenderResolution(): { key: string | null; scale: number; eye: number | null } {
  const snapshot = useSyncExternalStore(
    subscribeRenderResolution,
    () => `${renderResolutionKey() ?? ""}|${getRenderScale()}`,
  );
  const [key, scaleText] = snapshot.split("|");
  const scale = Number(scaleText);
  const base = baseEyeSize();
  return { key: key || null, scale, eye: base == null ? null : scaledEyeSize(base, scale) };
}
