/**
 * VRChat instance peer discovery + TOFU identity actor (`vrcPeers`).
 *
 * Watches VRChat's local `output_log_*.txt` (`classes/vrc/logParser.ts`), joins the hashed
 * Stageforge topic for the current VRChat instance (`vrc-inst-<sha256>`), runs a mutual Ed25519
 * challenge-response handshake over iroh with every `vrcPeers@*` actor on that topic, and
 * evaluates each peer against:
 *   1. Live instance membership (`OnPlayerJoined` / `OnPlayerLeft` from the local VRChat log).
 *   2. The local TOFU trust store (`vrc-trust.json`, mapping `usr_... -> Ed25519 public key`).
 *
 * No VRChat API credentials are required. Friend-list filtering (`vrcApi`) can layer onto this
 * actor later without changing the topic or handshake protocol.
 */
import { type ActorId, actorState, PostMan, System } from "../submodules/stageforge/mod.ts";
import type { IrohEndpoint } from "../classes/irohCarrier.ts";
import { type VrcLogState, VrcLogWatcher, type VrcPlayer } from "../classes/vrc/logParser.ts";
import {
  instancePreimageProof,
  keyFingerprint,
  loadOrCreateIdentity,
  type LocalIdentity,
  randomNonce,
  signChallenge,
  type TrustEvaluation,
  type TrustedPeerRecord,
  verifyChallenge,
  verifyInstancePreimageProof,
  vrcInstanceTopic,
  vrcInstanceTopicKey,
  VrcTrustStore,
} from "../classes/vrc/identity.ts";
import {
  type PeerPatchActorResult,
  peerPatchesAccepted,
  type PeerPatchReply,
  type PeerPatchRequest,
  resolvePatchModules,
  summarizePeerPatch,
} from "../classes/peerPatch.ts";
import {
  type PeerProbe,
  type PeerProbeReply,
  type ProbeSharedDisplay,
  type ProbeViewedDisplay,
  recentLogErrors,
} from "../classes/peerProbe.ts";
import { getBuildInfo } from "../classes/buildInfo.ts";
import { getSettingsPath, parseSettings } from "../classes/settings.ts";
import type { IrohConnectionInfo } from "../classes/irohCarrier.ts";

export const VRC_PEERS_ACTOR_NAME = "vrcPeers";
const DEFAULT_POLL_MS = 1000;
const CHALLENGE_TIMEOUT_MS = 10_000;

export type VrcPeerInfo = {
  actorId: ActorId;
  vrcUserId: string;
  displayName: string;
  publicKey: string;
  fingerprint: string;
  inInstance: boolean;
  trust: TrustEvaluation;
  pinnedFingerprint?: string | null;
  verifiedAt: string;
};

export type VrcPeersConfig = {
  logDir?: string | null;
  identityPath?: string;
  trustPath?: string;
  pollIntervalMs?: number;
};

type ChallengeRequest = {
  from: ActorId;
  nonce: string;
  instanceProof: string;
};

type ChallengeResponse = {
  actorId: ActorId;
  vrcUserId: string;
  displayName: string;
  publicKey: string;
  signature: string;
};

const state = actorState({
  name: VRC_PEERS_ACTOR_NAME,
  instanceId: null as string | null,
  worldName: null as string | null,
  instanceTopic: null as string | null,
  self: null as VrcPlayer | null,
  players: [] as VrcPlayer[],
  fingerprint: null as string | null,
  publicKey: null as string | null,
  peerCount: 0,
  trustedCount: 0,
});

let watcher = new VrcLogWatcher();
let identity: LocalIdentity | null = null;
let trustStore: VrcTrustStore | null = null;
let identityPath: string | undefined;
let trustPath: string | undefined;
let pollIntervalMs = DEFAULT_POLL_MS;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let currentTopic: string | null = null;
let currentTopicKey: string | null = null;
let topicGeneration = 0;
let webxrActor: ActorId | null = null;
let displayShareActor: ActorId | null = null;
let householdDesktopsActor: ActorId | null = null;

type ShareOffer = {
  from: ActorId;
  vrcUserId: string;
  displayName: string;
  shareActor: ActorId;
  token: string;
};

type DirectOffer = {
  from: ActorId;
  endpoint: IrohEndpoint;
  /** True once the sender has already allowlisted our direct endpoint id. */
  allowed?: boolean;
};

/** Verified peers discovered on the current instance topic, keyed by their remote actor id. */
const peers = new Map<ActorId, VrcPeerInfo>();
/** Contacts currently being handshaken, to avoid duplicate parallel challenges. */
const handshaking = new Set<ActorId>();
/** Remote `vrcPeers` actor ids we have already sent our `SHAREOFFER` to in this instance. */
const grantedTo = new Set<ActorId>();
/** `SHAREOFFER`s received from remote peers, keyed by their `vrcPeers` actor id. */
const receivedOffers = new Map<ActorId, ShareOffer>();
/** Remote `displayShare` actors currently registered with our local `householdDesktops`. */
const activeSources = new Map<ActorId, ActorId>();
/** Whether we have sent our direct endpoint offer to a trusted peer (`true` = with `allowed: true`). */
const directOfferSent = new Map<ActorId, boolean>();
/** Direct endpoint offers received from remote peers, keyed by their `vrcPeers` actor id. */
const receivedDirectOffers = new Map<ActorId, DirectOffer>();
/** Remote direct iroh endpoint ids allowlisted for each peer, so we can revoke on untrust. */
const directPeerIds = new Map<ActorId, string>();
/** Peers whose direct P2P upgrade has been dialed from this side. */
const upgradedDirect = new Set<ActorId>();

function pushPeersToWebXr(): void {
  if (!webxrActor) return;
  PostMan.PostMessage({
    target: webxrActor,
    type: "VRCPEERSUPDATE",
    payload: { peers: [...peers.values()] },
  });
}

async function grantPeerSharing(peer: VrcPeerInfo): Promise<void> {
  if (!displayShareActor || !state.self || grantedTo.has(peer.actorId)) return;
  if (peer.actorId.startsWith("vrcPeers@sim-")) return;
  grantedTo.add(peer.actorId);
  try {
    const grant = await PostMan.PostMessage({
      target: displayShareActor,
      type: "GRANTPEER",
      payload: { peerKey: peer.vrcUserId },
    }, true) as { shareActor: ActorId; token: string };
    // Re-check trust after async hop.
    const current = peers.get(peer.actorId);
    if (!current || current.trust !== "trusted") {
      grantedTo.delete(peer.actorId);
      PostMan.PostMessage({
        target: displayShareActor,
        type: "REVOKEPEER",
        payload: { peerKey: peer.vrcUserId },
      });
      return;
    }
    PostMan.PostMessage({
      target: peer.actorId,
      type: "SHAREOFFER",
      payload: {
        from: state.id,
        vrcUserId: state.self.userId,
        displayName: state.self.displayName,
        shareActor: grant.shareActor,
        token: grant.token,
      } satisfies ShareOffer,
    });
  } catch (error) {
    grantedTo.delete(peer.actorId);
    console.warn(`[vrcPeers] GRANTPEER failed for ${peer.vrcUserId}:`, error);
  }
}

async function upgradePeerToDirect(peer: VrcPeerInfo): Promise<void> {
  if (peer.actorId.startsWith("vrcPeers@sim-")) return;
  let myDirect: IrohEndpoint | null = null;
  try {
    myDirect = await PostMan.PostMessage({
      target: System,
      type: "DIRECT_ENDPOINT",
      payload: null,
    }, true) as IrohEndpoint | null;
  } catch (error) {
    console.warn(`[vrcPeers] DIRECT_ENDPOINT failed:`, error);
    return;
  }
  if (!myDirect || typeof myDirect.id !== "string" || !myDirect.id) return;

  // Re-check trust after async hop.
  const current = peers.get(peer.actorId);
  if (!current || current.trust !== "trusted" || !current.inInstance) return;

  const remoteOffer = receivedDirectOffers.get(peer.actorId);
  if (remoteOffer) {
    directPeerIds.set(peer.actorId, remoteOffer.endpoint.id);
    await PostMan.PostMessage({
      target: System,
      type: "ALLOW_DIRECT",
      payload: { peerId: remoteOffer.endpoint.id },
    }, true);

    const alreadySentAllowed = directOfferSent.get(peer.actorId) === true;
    const shouldAck = !alreadySentAllowed &&
      (!remoteOffer.allowed || state.id < peer.actorId);
    if (shouldAck) {
      directOfferSent.set(peer.actorId, true);
      PostMan.PostMessage({
        target: peer.actorId,
        type: "DIRECTOFFER",
        payload: {
          from: state.id,
          endpoint: myDirect,
          allowed: true,
        } satisfies DirectOffer,
      });
    }

    if (remoteOffer.allowed === true && !upgradedDirect.has(peer.actorId)) {
      upgradedDirect.add(peer.actorId);
      const actors: ActorId[] = [peer.actorId];
      const shareOffer = receivedOffers.get(peer.actorId);
      if (shareOffer) actors.push(shareOffer.shareActor);
      try {
        await PostMan.PostMessage({
          target: System,
          type: "CONNECT_DIRECT",
          payload: { endpoint: remoteOffer.endpoint, actors },
        }, true);
        // Send one message over the newly upgraded direct connection so the remote hub
        // upgrades our `state.id` route onto that direct connection too.
        PostMan.PostMessage({
          target: peer.actorId,
          type: "DIRECTOFFER",
          payload: {
            from: state.id,
            endpoint: myDirect,
            allowed: true,
          } satisfies DirectOffer,
        });
      } catch (error) {
        upgradedDirect.delete(peer.actorId);
        console.warn(`[vrcPeers] CONNECT_DIRECT failed for ${peer.vrcUserId}:`, error);
      }
    }
    return;
  }

  if (!directOfferSent.has(peer.actorId)) {
    directOfferSent.set(peer.actorId, false);
    PostMan.PostMessage({
      target: peer.actorId,
      type: "DIRECTOFFER",
      payload: {
        from: state.id,
        endpoint: myDirect,
        allowed: false,
      } satisfies DirectOffer,
    });
  }
}

function revokePeerSharing(peerActorId: ActorId, vrcUserId?: string): void {
  if (grantedTo.delete(peerActorId) && displayShareActor && vrcUserId) {
    PostMan.PostMessage({
      target: displayShareActor,
      type: "REVOKEPEER",
      payload: { peerKey: vrcUserId },
    });
  }
  const sourceActor = activeSources.get(peerActorId);
  if (sourceActor) {
    activeSources.delete(peerActorId);
    if (householdDesktopsActor) {
      PostMan.PostMessage({
        target: householdDesktopsActor,
        type: "REMOVEPEERSOURCE",
        payload: { source: sourceActor },
      });
    }
  }
  directOfferSent.delete(peerActorId);
  upgradedDirect.delete(peerActorId);
  const directPeerId = directPeerIds.get(peerActorId);
  if (directPeerId) {
    directPeerIds.delete(peerActorId);
    PostMan.PostMessage({
      target: System,
      type: "REVOKE_DIRECT",
      payload: { peerId: directPeerId },
    });
  }
}

function syncSharingForPeer(peer: VrcPeerInfo): void {
  if (peer.trust === "trusted" && peer.inInstance) {
    void upgradePeerToDirect(peer);
    void grantPeerSharing(peer);
    const offer = receivedOffers.get(peer.actorId);
    if (offer && householdDesktopsActor && activeSources.get(peer.actorId) !== offer.shareActor) {
      activeSources.set(peer.actorId, offer.shareActor);
      PostMan.PostMessage({
        target: householdDesktopsActor,
        type: "ADDPEERSOURCE",
        payload: {
          source: offer.shareActor,
          proof: offer.token,
          label: peer.displayName,
        },
      });
    }
  } else {
    revokePeerSharing(peer.actorId, peer.vrcUserId);
  }
}

function clearAllPeerSharing(): void {
  for (const [peerActorId, peer] of peers.entries()) {
    revokePeerSharing(peerActorId, peer.vrcUserId);
  }
  for (const directPeerId of directPeerIds.values()) {
    PostMan.PostMessage({
      target: System,
      type: "REVOKE_DIRECT",
      payload: { peerId: directPeerId },
    });
  }
  for (const sourceActor of activeSources.values()) {
    if (householdDesktopsActor) {
      PostMan.PostMessage({
        target: householdDesktopsActor,
        type: "REMOVEPEERSOURCE",
        payload: { source: sourceActor },
      });
    }
  }
  grantedTo.clear();
  receivedOffers.clear();
  activeSources.clear();
  directOfferSent.clear();
  receivedDirectOffers.clear();
  directPeerIds.clear();
  upgradedDirect.clear();
}

async function ensureInitialized(): Promise<{ identity: LocalIdentity; trustStore: VrcTrustStore }> {
  if (!identity) {
    identity = await loadOrCreateIdentity(identityPath);
    state.publicKey = identity.publicKey;
    state.fingerprint = identity.fingerprint;
  }
  if (!trustStore) {
    trustStore = new VrcTrustStore(trustPath);
  }
  return { identity, trustStore };
}

function isVrcPeerActor(actorId: ActorId): boolean {
  return actorId !== state.id && actorId.startsWith(`${VRC_PEERS_ACTOR_NAME}@`);
}

function syncCounts(): void {
  state.peerCount = peers.size;
  let trusted = 0;
  for (const peer of peers.values()) {
    if (peer.trust === "trusted") trusted++;
  }
  state.trustedCount = trusted;
  pushPeersToWebXr();
}

function reevaluatePeers(): void {
  if (!trustStore) return;
  for (const peer of peers.values()) {
    const isSimulated = peer.actorId.startsWith("vrcPeers@sim-");
    const inInstance = isSimulated ? true : watcher.hasPlayer(peer.vrcUserId);
    peer.inInstance = inInstance;
    peer.trust = trustStore.evaluate(peer.vrcUserId, peer.publicKey, inInstance);
    peer.pinnedFingerprint = peer.trust === "key_mismatch"
      ? (trustStore.get(peer.vrcUserId)?.fingerprint ?? null)
      : null;
    if (peer.trust === "trusted") {
      trustStore.touch(peer.vrcUserId, peer.displayName);
    }
    syncSharingForPeer(peer);
  }
  syncCounts();
}

async function switchInstanceTopic(instanceId: string | null): Promise<void> {
  const gen = ++topicGeneration;
  const nextTopic = instanceId ? await vrcInstanceTopic(instanceId) : null;
  const nextKey = instanceId ? await vrcInstanceTopicKey(instanceId) : null;
  if (gen !== topicGeneration) return;
  if (nextTopic === currentTopic) return;

  clearAllPeerSharing();
  if (currentTopic) {
    PostMan.delTopic(currentTopic);
  }
  peers.clear();
  handshaking.clear();
  currentTopic = nextTopic;
  currentTopicKey = nextKey;
  state.instanceTopic = nextTopic;
  syncCounts();

  if (displayShareActor) {
    PostMan.PostMessage({
      target: displayShareActor,
      type: "SETINSTANCETOPIC",
      payload: { topic: nextTopic, key: nextKey },
    });
  }
  if (nextTopic) {
    PostMan.setTopic(nextTopic, nextKey ? { key: nextKey } : undefined);
  }
}

async function pollLog(): Promise<void> {
  await ensureInitialized();
  const changed = watcher.poll();
  const snap: VrcLogState = watcher.state;
  const prevInstanceId = state.instanceId;

  state.self = snap.self;
  state.worldName = snap.worldName;
  state.instanceId = snap.instanceId;
  state.players = snap.players;

  if (snap.instanceId !== prevInstanceId) {
    await switchInstanceTopic(snap.instanceId);
  }
  if (changed) {
    reevaluatePeers();
  }
}

function restartPollTimer(): void {
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    void pollLog().catch((error) => console.warn("[vrcPeers] poll failed:", error));
  }, pollIntervalMs);
}

async function handshakePeer(remoteActorId: ActorId): Promise<void> {
  if (!isVrcPeerActor(remoteActorId) || handshaking.has(remoteActorId)) return;
  const topic = currentTopic;
  const instanceId = state.instanceId;
  if (!topic || !instanceId) return;

  handshaking.add(remoteActorId);
  try {
    const { trustStore: store } = await ensureInitialized();
    const nonce = randomNonce();
    const instanceProof = await instancePreimageProof({
      instanceId,
      from: state.id,
      to: remoteActorId,
      nonce,
    });
    const reply = await Promise.race([
      PostMan.PostMessage({
        target: remoteActorId,
        type: "CHALLENGE",
        payload: { from: state.id, nonce, instanceProof } satisfies ChallengeRequest,
      }, true) as Promise<ChallengeResponse | null>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("challenge timeout")), CHALLENGE_TIMEOUT_MS)
      ),
    ]);

    // If we switched instances while awaiting, ignore the stale reply.
    if (topic !== currentTopic || instanceId !== state.instanceId) return;
    if (
      !reply || reply.actorId !== remoteActorId || typeof reply.vrcUserId !== "string" ||
      typeof reply.publicKey !== "string" || typeof reply.signature !== "string"
    ) {
      return;
    }

    const ok = await verifyChallenge({
      publicKey: reply.publicKey,
      signature: reply.signature,
      actorId: reply.actorId,
      vrcUserId: reply.vrcUserId,
      instanceId,
      nonce,
    });
    if (!ok) {
      console.warn(`[vrcPeers] invalid challenge signature from ${remoteActorId}`);
      return;
    }

    const fingerprint = await keyFingerprint(reply.publicKey);
    const inInstance = watcher.hasPlayer(reply.vrcUserId);
    const trust = store.evaluate(reply.vrcUserId, reply.publicKey, inInstance);
    const pinnedFingerprint = trust === "key_mismatch"
      ? (store.get(reply.vrcUserId)?.fingerprint ?? null)
      : null;
    if (trust === "trusted") {
      store.touch(reply.vrcUserId, reply.displayName);
    }

    const peerInfo: VrcPeerInfo = {
      actorId: remoteActorId,
      vrcUserId: reply.vrcUserId,
      displayName: reply.displayName || reply.vrcUserId,
      publicKey: reply.publicKey,
      fingerprint,
      inInstance,
      trust,
      pinnedFingerprint,
      verifiedAt: new Date().toISOString(),
    };
    peers.set(remoteActorId, peerInfo);
    syncSharingForPeer(peerInfo);
    syncCounts();
  } catch (error) {
    console.warn(`[vrcPeers] handshake with ${remoteActorId} failed:`, error);
  } finally {
    handshaking.delete(remoteActorId);
  }
}

function getStatus() {
  return {
    actorId: state.id,
    self: state.self,
    worldName: state.worldName,
    instanceId: state.instanceId,
    instanceTopic: state.instanceTopic,
    players: state.players,
    fingerprint: state.fingerprint,
    publicKey: state.publicKey,
    peers: [...peers.values()],
  };
}

export const api = {
  __INIT__: async () => {
    await ensureInitialized();
    await pollLog();
    restartPollTimer();
  },
  __SHUTDOWN__: () => {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    clearAllPeerSharing();
    if (displayShareActor) {
      PostMan.PostMessage({
        target: displayShareActor,
        type: "SETINSTANCETOPIC",
        payload: { topic: null },
      });
    }
    if (currentTopic) {
      PostMan.delTopic(currentTopic);
      currentTopic = null;
      currentTopicKey = null;
      state.instanceTopic = null;
    }
    peers.clear();
    handshaking.clear();
    syncCounts();
  },
  __HEALTH__: () => getStatus(),
  STATUS: () => getStatus(),
  ASSIGNWEBXR: (actorId: ActorId | null) => {
    webxrActor = actorId;
    pushPeersToWebXr();
    return { webxrActor };
  },
  ASSIGNSHARING: (payload: {
    displayShare?: ActorId | null;
    householdDesktops?: ActorId | null;
  } | null) => {
    if (payload && "displayShare" in payload) {
      displayShareActor = payload.displayShare ?? null;
      if (displayShareActor && currentTopic) {
        PostMan.PostMessage({
          target: displayShareActor,
          type: "SETINSTANCETOPIC",
          payload: { topic: currentTopic, key: currentTopicKey },
        });
      }
    }
    if (payload && "householdDesktops" in payload) {
      householdDesktopsActor = payload.householdDesktops ?? null;
    }
    for (const peer of peers.values()) syncSharingForPeer(peer);
    return { displayShareActor, householdDesktopsActor };
  },
  SHAREOFFER: (offer: ShareOffer | null) => {
    if (
      !offer || typeof offer.from !== "string" || typeof offer.shareActor !== "string" ||
      typeof offer.token !== "string" || !offer.token
    ) {
      return false;
    }
    if (PostMan.sender && PostMan.sender !== offer.from) {
      console.warn(`[vrcPeers] rejected spoofed SHAREOFFER claiming ${offer.from} from ${PostMan.sender}`);
      return false;
    }
    receivedOffers.set(offer.from, offer);
    const peer = peers.get(offer.from);
    if (peer) {
      syncSharingForPeer(peer);
      // If we already upgraded this peer to direct P2P, attach their shareActor to that connection too.
      const directOffer = receivedDirectOffers.get(offer.from);
      if (peer.trust === "trusted" && upgradedDirect.has(offer.from) && directOffer) {
        void PostMan.PostMessage({
          target: System,
          type: "CONNECT_DIRECT",
          payload: { endpoint: directOffer.endpoint, actors: [offer.shareActor] },
        }, true).catch(() => {});
      }
    }
    return true;
  },
  DIRECTOFFER: (offer: DirectOffer | null) => {
    if (
      !offer || typeof offer.from !== "string" || !offer.endpoint ||
      typeof offer.endpoint.id !== "string" || !offer.endpoint.id
    ) {
      return false;
    }
    if (PostMan.sender && PostMan.sender !== offer.from) {
      console.warn(`[vrcPeers] rejected spoofed DIRECTOFFER claiming ${offer.from} from ${PostMan.sender}`);
      return false;
    }
    receivedDirectOffers.set(offer.from, offer);
    const peer = peers.get(offer.from);
    if (peer && peer.trust === "trusted" && peer.inInstance) {
      void upgradePeerToDirect(peer);
    }
    return true;
  },
  SIMULATEPEER: async (
    payload: { displayName?: string; userId?: string; mismatch?: boolean } | null,
  ): Promise<VrcPeerInfo> => {
    const { trustStore: store } = await ensureInitialized();
    const userId = payload?.userId ?? "usr_00000000-0000-0000-0000-000000000001";
    const displayName = payload?.displayName ?? "TestFriend";
    const actorId = `vrcPeers@sim-${crypto.randomUUID()}` as ActorId;
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const publicKey = btoa(String.fromCharCode(...rawKey))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const fingerprint = await keyFingerprint(publicKey);
    let trust: TrustEvaluation = store.evaluate(userId, publicKey, true);
    let pinnedFingerprint: string | null = null;
    if (payload?.mismatch) {
      trust = "key_mismatch";
      pinnedFingerprint = store.get(userId)?.fingerprint ?? "a1b2-c3d4-e5f6";
    } else if (trust === "key_mismatch") {
      pinnedFingerprint = store.get(userId)?.fingerprint ?? null;
    }
    const info: VrcPeerInfo = {
      actorId,
      vrcUserId: userId,
      displayName,
      publicKey,
      fingerprint,
      inInstance: true,
      trust,
      pinnedFingerprint,
      verifiedAt: new Date().toISOString(),
    };
    peers.set(actorId, info);
    syncCounts();
    return info;
  },
  CLEARSIMULATED: () => {
    let removed = 0;
    for (const id of [...peers.keys()]) {
      if (id.startsWith("vrcPeers@sim-")) {
        peers.delete(id);
        removed++;
      }
    }
    syncCounts();
    return { removed };
  },
  CONFIGURE: async (cfg: VrcPeersConfig | null) => {
    if (!cfg) return getStatus();
    if (cfg.identityPath !== undefined && cfg.identityPath !== identityPath) {
      identityPath = cfg.identityPath;
      identity = null;
    }
    if (cfg.trustPath !== undefined && cfg.trustPath !== trustPath) {
      trustPath = cfg.trustPath;
      trustStore = null;
    }
    if (cfg.logDir !== undefined) {
      watcher.setLogDir(cfg.logDir);
    }
    if (typeof cfg.pollIntervalMs === "number" && cfg.pollIntervalMs >= 20) {
      pollIntervalMs = cfg.pollIntervalMs;
      restartPollTimer();
    }
    await pollLog();
    return getStatus();
  },
  POLL: async () => {
    await pollLog();
    return getStatus();
  },
  LISTPEERS: (): VrcPeerInfo[] => [...peers.values()],
  LISTTRUSTED: async (): Promise<TrustedPeerRecord[]> => {
    const { trustStore: store } = await ensureInitialized();
    return store.list();
  },
  TRUST: async (
    payload: { userId?: string; displayName?: string; force?: boolean },
  ): Promise<TrustedPeerRecord> => {
    const { trustStore: store } = await ensureInitialized();
    const target = [...peers.values()].find((p) =>
      (payload.userId && p.vrcUserId === payload.userId) ||
      (payload.displayName &&
        p.displayName.toLowerCase() === payload.displayName.toLowerCase())
    );
    if (!target) {
      throw new Error(
        `no discovered peer matching ${payload.userId ?? payload.displayName ?? "(none)"} in current instance`,
      );
    }
    const record = store.trust(
      {
        userId: target.vrcUserId,
        publicKey: target.publicKey,
        fingerprint: target.fingerprint,
        displayName: target.displayName,
      },
      { force: payload.force },
    );
    reevaluatePeers();
    return record;
  },
  UNTRUST: async (payload: { userId: string }): Promise<{ removed: boolean }> => {
    const { trustStore: store } = await ensureInitialized();
    const removed = store.untrust(payload.userId);
    reevaluatePeers();
    return { removed };
  },
  CHALLENGE: async (request: ChallengeRequest): Promise<ChallengeResponse | null> => {
    const { identity: id } = await ensureInitialized();
    const instanceId = state.instanceId;
    if (
      !currentTopic || !instanceId || !state.self ||
      typeof request?.from !== "string" || !request.from ||
      typeof request?.nonce !== "string" || !request.nonce ||
      typeof request?.instanceProof !== "string" || !request.instanceProof
    ) {
      return null;
    }
    if (PostMan.sender && PostMan.sender !== request.from) {
      console.warn(
        `[vrcPeers] rejected spoofed CHALLENGE claiming ${request.from} from ${PostMan.sender}`,
      );
      return null;
    }
    const knowsInstance = await verifyInstancePreimageProof({
      proof: request.instanceProof,
      instanceId,
      from: request.from,
      to: state.id,
      nonce: request.nonce,
    });
    if (!knowsInstance) {
      console.warn(`[vrcPeers] rejected CHALLENGE with invalid instance proof from ${request.from}`);
      return null;
    }
    const signature = await signChallenge(id, {
      actorId: state.id,
      vrcUserId: state.self.userId,
      instanceId,
      nonce: request.nonce,
    });
    // Also initiate our own challenge back if we haven't verified them yet.
    if (request.from && isVrcPeerActor(request.from) && !peers.has(request.from)) {
      void handshakePeer(request.from);
    }
    return {
      actorId: state.id,
      vrcUserId: state.self.userId,
      displayName: state.self.displayName,
      publicKey: id.publicKey,
      signature,
    };
  },
  ADDCONTACT: (contactId: ActorId) => {
    state.addressBook.add(contactId);
    if (isVrcPeerActor(contactId)) {
      void handshakePeer(contactId);
    }
  },
  /**
   * A trusted peer's live code patch (`classes/peerPatch.ts`): applied to every local actor that
   * loaded the modules, when the `acceptPeerPatches` setting is on.
   */
  PEERPATCH: async (request: PeerPatchRequest | null): Promise<PeerPatchReply> => {
    const sender = PostMan.sender;
    const peer = sender ? peers.get(sender) : undefined;
    if (!peer || peer.trust !== "trusted") {
      console.warn(`[peerPatch] rejected a patch from untrusted ${sender ?? "unknown sender"}`);
      return { ok: false, error: "not a trusted peer" };
    }
    if (!peerPatchesAccepted()) {
      console.warn(`[peerPatch] ${peer.displayName} sent a patch; Peer Code Patches is off`);
      return {
        ok: false,
        error: `${state.self?.displayName ?? "this peer"} has Settings → Install → Peer Code Patches off`,
      };
    }
    let modules;
    try {
      modules = resolvePatchModules(request?.modules);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const paths = (request?.modules ?? []).map((m) => m.path).join(", ");
    console.log(`[peerPatch] ${peer.displayName} sent ${paths}`);
    const results = await hotPatchLocalActors(modules);
    console.log(`[peerPatch] ${peer.displayName}: ${summarizePeerPatch(results)}`);
    return {
      ok: true,
      patched: results.filter((r) => r.status === "patched").map((r) => r.actor),
      results,
    };
  },
  /**
   * A trusted peer's coop dev check (`deno task coop:verify`): a read-only snapshot of this
   * PetPlay, when Peer Code Patches is on (the same opt-in as live patches).
   */
  PEERPROBE: async (): Promise<PeerProbeReply> => {
    const sender = PostMan.sender;
    const peer = sender ? peers.get(sender) : undefined;
    if (!peer || peer.trust !== "trusted") return { ok: false, error: "not a trusted peer" };
    if (!peerPatchesAccepted()) {
      return {
        ok: false,
        error: `${
          state.self?.displayName ?? "this peer"
        } has Settings → Install → Peer Code Patches off`,
      };
    }
    return { ok: true, probe: await localProbe() };
  },
  /** Local only: probe this machine and every trusted peer in the instance (utils/coop-verify.ts). */
  SENDPEERPROBE: async (
    request: { peer?: string } | null,
  ): Promise<
    { local: PeerProbe; peers: Array<{ peer: string; actorId: ActorId; reply: PeerProbeReply }> }
  > => {
    const [local, replies] = await Promise.all([
      localProbe(),
      Promise.all(
        trustedInInstance(request?.peer).map(async (info) => {
          try {
            const reply = await timeout(
              PostMan.PostMessage(
                { target: info.actorId, type: "PEERPROBE", payload: null },
                true,
              ) as Promise<
                PeerProbeReply
              >,
              20_000,
            );
            return { peer: info.displayName, actorId: info.actorId, reply };
          } catch (error) {
            return {
              peer: info.displayName,
              actorId: info.actorId,
              reply: {
                ok: false as const,
                error: error instanceof Error ? error.message : String(error),
              },
            };
          }
        }),
      ),
    ]);
    return { local, peers: replies };
  },
  /** Local only: send a code patch to every trusted peer in the instance (`utils/peer-patch.ts`). */
  SENDPEERPATCH: async (
    request: (PeerPatchRequest & { peer?: string }) | null,
  ): Promise<Array<{ peer: string; reply: PeerPatchReply }>> => {
    return await Promise.all(
      trustedInInstance(request?.peer).map(async (info) => {
        try {
          const reply = await timeout(
            PostMan.PostMessage({
              target: info.actorId,
              type: "PEERPATCH",
              payload: { modules: request?.modules ?? [], label: state.self?.displayName },
            }, true) as Promise<PeerPatchReply>,
            30_000,
          );
          return { peer: info.displayName, reply };
        } catch (error) {
          return {
            peer: info.displayName,
            reply: { ok: false, error: error instanceof Error ? error.message : String(error) },
          };
        }
      }),
    );
  },
  REMOVECONTACT: (contactId: ActorId) => {
    state.addressBook.delete(contactId);
    const departed = peers.get(contactId);
    receivedOffers.delete(contactId);
    receivedDirectOffers.delete(contactId);
    if (departed) {
      revokePeerSharing(contactId, departed.vrcUserId);
      peers.delete(contactId);
      syncCounts();
    }
  },
};

/** HOTPATCH every local TypeScript actor; ones that never loaded the modules answer `absent`. */
async function hotPatchLocalActors(
  modules: ReturnType<typeof resolvePatchModules>,
): Promise<PeerPatchActorResult[]> {
  const actors = await PostMan.PostMessage({ target: System, type: "INSPECT" }, true) as Array<
    { actorId: string; ownership?: string; actorname?: string }
  >;
  const local = actors.filter((a) =>
    a.ownership !== "external" && /\.tsx?$/.test(a.actorname ?? "")
  );
  return await Promise.all(local.map(async (a) => {
    const actor = a.actorId.slice(0, a.actorId.indexOf("@")) || a.actorId;
    try {
      const result = await timeout(
        PostMan.PostMessage({
          target: a.actorId as ActorId,
          type: "HOTPATCH",
          payload: { modules },
        }, true) as Promise<PeerPatchActorResult>,
        15_000,
      );
      return { ...result, actor };
    } catch (error) {
      return {
        actor,
        status: "error" as const,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}

/** The latest trusted, in-instance record per VRChat user, optionally filtered by display name. */
function trustedInInstance(filter?: string): VrcPeerInfo[] {
  const lower = filter?.toLowerCase();
  const latest = new Map<string, VrcPeerInfo>();
  for (const info of peers.values()) {
    if (info.trust !== "trusted" || !info.inInstance) continue;
    if (lower && !info.displayName.toLowerCase().includes(lower)) continue;
    const prev = latest.get(info.vrcUserId);
    if (!prev || prev.verifiedAt < info.verifiedAt) latest.set(info.vrcUserId, info);
  }
  return [...latest.values()];
}

async function ask<T>(target: ActorId | typeof System, type: string, ms = 3000): Promise<T | null> {
  try {
    return await timeout(
      PostMan.PostMessage({ target, type, payload: null }, true) as Promise<T>,
      ms,
    );
  } catch {
    return null;
  }
}

/** This machine's side of a coop dev check (classes/peerProbe.ts). */
async function localProbe(): Promise<PeerProbe> {
  let settings;
  try {
    settings = parseSettings(Deno.readTextFileSync(getSettingsPath())).settings;
  } catch {
    settings = parseSettings("{}").settings;
  }
  const build = getBuildInfo();
  const [links, direct, sharing, viewing] = await Promise.all([
    ask<IrohConnectionInfo[] | null>(System, "IROH_CONNECTIONS"),
    ask<IrohEndpoint | null>(System, "DIRECT_ENDPOINT", 15_000),
    displayShareActor
      ? ask<{ shared?: ProbeSharedDisplay[] }>(displayShareActor, "HEALTH")
      : Promise.resolve(null),
    householdDesktopsActor
      ? ask<ProbeViewedDisplay[]>(householdDesktopsActor, "DESCRIBEPOSES")
      : Promise.resolve(null),
  ]);
  return {
    at: Date.now(),
    displayName: state.self?.displayName ?? null,
    vrcUserId: state.self?.userId ?? null,
    build,
    updateChannel: settings.updateChannel ?? build.channel ?? "stable",
    acceptPeerPatches: settings.acceptPeerPatches === true,
    directId: direct?.id ?? null,
    links,
    peers: [...peers.values()].map((p) => ({
      displayName: p.displayName,
      actorId: p.actorId,
      trust: p.trust,
      inInstance: p.inInstance,
    })),
    sharing: sharing ? { actor: displayShareActor, shared: sharing.shared ?? [] } : null,
    viewing,
    logErrors: recentLogErrors(),
  };
}

function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

new PostMan(state, api);
