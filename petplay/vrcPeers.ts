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
import { type ActorId, actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { type VrcLogState, VrcLogWatcher, type VrcPlayer } from "../classes/vrc/logParser.ts";
import {
  keyFingerprint,
  loadOrCreateIdentity,
  type LocalIdentity,
  randomNonce,
  signChallenge,
  type TrustEvaluation,
  type TrustedPeerRecord,
  verifyChallenge,
  vrcInstanceTopic,
  VrcTrustStore,
} from "../classes/vrc/identity.ts";

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
let topicGeneration = 0;
let webxrActor: ActorId | null = null;

/** Verified peers discovered on the current instance topic, keyed by their remote actor id. */
const peers = new Map<ActorId, VrcPeerInfo>();
/** Contacts currently being handshaken, to avoid duplicate parallel challenges. */
const handshaking = new Set<ActorId>();

function pushPeersToWebXr(): void {
  if (!webxrActor) return;
  PostMan.PostMessage({
    target: webxrActor,
    type: "VRCPEERSUPDATE",
    payload: { peers: [...peers.values()] },
  });
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
  }
  syncCounts();
}

async function switchInstanceTopic(instanceId: string | null): Promise<void> {
  const gen = ++topicGeneration;
  const nextTopic = instanceId ? await vrcInstanceTopic(instanceId) : null;
  if (gen !== topicGeneration) return;
  if (nextTopic === currentTopic) return;

  if (currentTopic) {
    PostMan.delTopic(currentTopic);
  }
  peers.clear();
  handshaking.clear();
  currentTopic = nextTopic;
  state.instanceTopic = nextTopic;
  syncCounts();

  if (nextTopic) {
    PostMan.setTopic(nextTopic);
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
  if (!topic) return;

  handshaking.add(remoteActorId);
  try {
    const { trustStore: store } = await ensureInitialized();
    const nonce = randomNonce();
    const reply = await Promise.race([
      PostMan.PostMessage({
        target: remoteActorId,
        type: "CHALLENGE",
        payload: { from: state.id, nonce } satisfies ChallengeRequest,
      }, true) as Promise<ChallengeResponse | null>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("challenge timeout")), CHALLENGE_TIMEOUT_MS)
      ),
    ]);

    // If we switched instances while awaiting, ignore the stale reply.
    if (topic !== currentTopic) return;
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
      instanceTopic: topic,
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

    peers.set(remoteActorId, {
      actorId: remoteActorId,
      vrcUserId: reply.vrcUserId,
      displayName: reply.displayName || reply.vrcUserId,
      publicKey: reply.publicKey,
      fingerprint,
      inInstance,
      trust,
      pinnedFingerprint,
      verifiedAt: new Date().toISOString(),
    });
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
    if (currentTopic) {
      PostMan.delTopic(currentTopic);
      currentTopic = null;
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
    if (!currentTopic || !state.self || typeof request?.nonce !== "string" || !request.nonce) {
      return null;
    }
    const signature = await signChallenge(id, {
      actorId: state.id,
      vrcUserId: state.self.userId,
      instanceTopic: currentTopic,
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
  REMOVECONTACT: (contactId: ActorId) => {
    state.addressBook.delete(contactId);
    if (peers.delete(contactId)) {
      syncCounts();
    }
  },
};

new PostMan(state, api);
