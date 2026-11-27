/**
 * What the decoupled renderer last reported about its native overlays (docs/NATIVE_OVERLAYS.md),
 * for Settings → Debug. Fed by the `webxr` actor from `OVERLAYRENDERSTATUS`.
 */
import { useSyncExternalStore } from "react";

export type NativeOverlayStatus = {
  /** The renderer has been asked to show marked panels as SteamVR quads. */
  enabled: boolean;
  panels: number;
  stereo: number;
  /** Why the renderer turned native overlays off, if it did. */
  error: string | null;
};

const NONE: NativeOverlayStatus = {
  enabled: false,
  panels: 0,
  stereo: 0,
  error: null,
};

let status = NONE;
const listeners = new Set<() => void>();

/** Reads the renderer's health (`overlayRenderOwner.ts` state); returns true when the error is new. */
export function reportNativeOverlayStatus(health: unknown): boolean {
  const h = (health ?? {}) as {
    nativePanels?: boolean;
    nativeError?: string | null;
    native?: {
      panels?: number;
      stereo?: number;
    } | null;
  };
  const next: NativeOverlayStatus = {
    enabled: h.nativePanels === true,
    panels: h.native?.panels ?? 0,
    stereo: h.native?.stereo ?? 0,
    error: h.nativeError ?? null,
  };
  const newError = next.error != null && next.error !== status.error;
  if (
    next.enabled !== status.enabled || next.panels !== status.panels ||
    next.stereo !== status.stereo || next.error !== status.error
  ) {
    status = next;
    for (const listener of listeners) listener();
  }
  return newError;
}

export function getNativeOverlayStatus(): NativeOverlayStatus {
  return status;
}

export function useNativeOverlayStatus(): NativeOverlayStatus {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => status,
  );
}
