/**
 * Pending VRChat TOFU trust prompts shown floating in front of the user
 * (see `vrcTofuPromptOverlay.tsx`).
 *
 * `petplay/vrcPeers.ts` pushes `VRCPEERSUPDATE` into `webxr`, which feeds this store. Only peers
 * currently in the same VRChat instance whose status is `pending` or `key_mismatch` appear here;
 * clicking Ignore dismisses that `(vrcUserId, fingerprint)` pair for this session so polling does
 * not re-open it.
 */
import { useSyncExternalStore } from "react";

export type VrcTofuPromptStatus = "pending" | "key_mismatch";

export type VrcTofuPromptItem = {
  actorId: string;
  vrcUserId: string;
  displayName: string;
  fingerprint: string;
  trust: VrcTofuPromptStatus;
  pinnedFingerprint?: string | null;
};

export type VrcPeerUpdateEntry = {
  actorId: string;
  vrcUserId: string;
  displayName: string;
  fingerprint: string;
  inInstance: boolean;
  trust: "trusted" | "pending" | "key_mismatch" | "not_in_instance";
  pinnedFingerprint?: string | null;
};

export type VrcTofuStore = {
  setPeers: (peers: readonly VrcPeerUpdateEntry[]) => void;
  pushPrompt: (item: VrcTofuPromptItem) => void;
  dismiss: (vrcUserId: string, fingerprint: string) => void;
  remove: (vrcUserId: string) => void;
  clear: () => void;
  prompts: () => readonly VrcTofuPromptItem[];
  subscribe: (listener: () => void) => () => void;
};

function dismissKey(vrcUserId: string, fingerprint: string): string {
  return `${vrcUserId}:${fingerprint}`;
}

export function createVrcTofuStore(): VrcTofuStore {
  let items: VrcTofuPromptItem[] = [];
  const dismissed = new Set<string>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };

  return {
    setPeers(peers) {
      const next: VrcTofuPromptItem[] = [];
      for (const peer of peers) {
        if (!peer.inInstance) continue;
        if (peer.trust !== "pending" && peer.trust !== "key_mismatch") continue;
        if (dismissed.has(dismissKey(peer.vrcUserId, peer.fingerprint))) continue;
        next.push({
          actorId: peer.actorId,
          vrcUserId: peer.vrcUserId,
          displayName: peer.displayName,
          fingerprint: peer.fingerprint,
          trust: peer.trust,
          pinnedFingerprint: peer.pinnedFingerprint ?? null,
        });
      }
      // Avoid redundant re-renders when nothing changed.
      if (
        next.length === items.length &&
        next.every((n, i) =>
          n.actorId === items[i].actorId &&
          n.vrcUserId === items[i].vrcUserId &&
          n.displayName === items[i].displayName &&
          n.fingerprint === items[i].fingerprint &&
          n.trust === items[i].trust &&
          n.pinnedFingerprint === items[i].pinnedFingerprint
        )
      ) {
        return;
      }
      items = next;
      emit();
    },
    pushPrompt(item) {
      dismissed.delete(dismissKey(item.vrcUserId, item.fingerprint));
      items = [...items.filter((i) => i.vrcUserId !== item.vrcUserId), item];
      emit();
    },
    dismiss(vrcUserId, fingerprint) {
      dismissed.add(dismissKey(vrcUserId, fingerprint));
      const before = items.length;
      items = items.filter((i) => !(i.vrcUserId === vrcUserId && i.fingerprint === fingerprint));
      if (items.length !== before) emit();
    },
    remove(vrcUserId) {
      const before = items.length;
      items = items.filter((i) => i.vrcUserId !== vrcUserId);
      if (items.length !== before) emit();
    },
    clear() {
      dismissed.clear();
      if (items.length === 0) return;
      items = [];
      emit();
    },
    prompts: () => items,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const vrcTofuStore = createVrcTofuStore();

export function useVrcTofuPrompts(): readonly VrcTofuPromptItem[] {
  return useSyncExternalStore(
    vrcTofuStore.subscribe,
    vrcTofuStore.prompts,
    vrcTofuStore.prompts,
  );
}
