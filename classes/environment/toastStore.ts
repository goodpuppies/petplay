/**
 * Toast notifications: a small queue shown head-locked in the headset (see `toastOverlay.tsx`).
 *
 * Anything in the webxr isolate can call {@link pushToast}: PetPlay's own status (layout saved,
 * capture lost) and the XSOverlay-compatible receiver in `xsoNotificationReceiver.ts`, which is
 * how VRChat tools that already target XSO reach it.
 *
 * At most {@link MAX_VISIBLE_TOASTS} show at once; the rest wait in arrival order. A toast's
 * timeout starts when it becomes visible, not when it arrives, so a burst does not expire unseen.
 */
import { useSyncExternalStore } from "react";

export const MAX_VISIBLE_TOASTS = 4;
export const DEFAULT_TOAST_MS = 14000;
/** XSO senders pass seconds and sometimes absurd values; keep a toast on screen 1–60 s. */
export const MIN_TOAST_MS = 1000;
export const MAX_TOAST_MS = 60000;

export type ToastTone = "info" | "warning" | "error";

export type ToastInput = {
  title: string;
  content?: string;
  /** Who sent it, shown small ("PetPlay", or an XSO `sourceApp`). */
  source?: string;
  timeoutMs?: number;
  tone?: ToastTone;
};

export type Toast = Required<Omit<ToastInput, "timeoutMs">> & {
  id: number;
  timeoutMs: number;
  /** Set when the toast becomes visible. */
  shownAt: number | null;
};

export type ToastQueue = {
  push: (input: ToastInput) => Toast;
  dismiss: (id: number) => void;
  /** Expire visible toasts whose time is up and promote waiting ones. */
  tick: () => void;
  visible: () => readonly Toast[];
  pending: () => number;
  subscribe: (listener: () => void) => () => void;
};

export function clampToastMs(ms: number | undefined): number {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return DEFAULT_TOAST_MS;
  return Math.min(MAX_TOAST_MS, Math.max(MIN_TOAST_MS, ms));
}

export function createToastQueue(now: () => number = Date.now): ToastQueue {
  let nextId = 1;
  let shown: Toast[] = [];
  let waiting: Toast[] = [];
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };

  const promote = (): boolean => {
    let changed = false;
    while (shown.length < MAX_VISIBLE_TOASTS && waiting.length > 0) {
      const [next, ...rest] = waiting;
      waiting = rest;
      shown = [...shown, { ...next, shownAt: now() }];
      changed = true;
    }
    return changed;
  };

  return {
    push(input) {
      const toast: Toast = {
        id: nextId++,
        title: input.title,
        content: input.content ?? "",
        source: input.source ?? "PetPlay",
        tone: input.tone ?? "info",
        timeoutMs: clampToastMs(input.timeoutMs),
        shownAt: null,
      };
      waiting = [...waiting, toast];
      promote();
      emit();
      return shown.find((t) => t.id === toast.id) ?? toast;
    },
    dismiss(id) {
      const before = shown.length + waiting.length;
      shown = shown.filter((t) => t.id !== id);
      waiting = waiting.filter((t) => t.id !== id);
      if (shown.length + waiting.length === before) return;
      promote();
      emit();
    },
    tick() {
      const t = now();
      const kept = shown.filter((toast) => t - (toast.shownAt ?? t) < toast.timeoutMs);
      const expired = kept.length !== shown.length;
      shown = kept;
      if (promote() || expired) emit();
    },
    visible: () => shown,
    pending: () => waiting.length,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The isolate's queue. */
export const toastQueue = createToastQueue();

export function pushToast(input: ToastInput): Toast {
  return toastQueue.push(input);
}

export function useVisibleToasts(): readonly Toast[] {
  return useSyncExternalStore(toastQueue.subscribe, toastQueue.visible, toastQueue.visible);
}
