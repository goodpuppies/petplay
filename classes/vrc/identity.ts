/**
 * Persistent PetPlay Ed25519 identity, VRChat instance topic derivation, and TOFU trust store.
 *
 * - Identity (`identity.json` in `configDir()`): an Ed25519 keypair persisted across restarts so
 *   peers recognize each other even when the underlying iroh node id is ephemeral.
 * - Instance topic (`vrcInstanceTopic`): `vrc-inst-<sha256>` of the full VRChat instance id
 *   (including any `~hidden(...)` / `~private(...)` / `~nonce(...)` tags). The public topic server
 *   only ever sees the hash, never the world id or instance nonce.
 * - Challenge-response (`signChallenge` / `verifyChallenge`): binds `(actorId, vrcUserId,
 *   instanceId, nonce)` to the Ed25519 key so a peer proves both live key possession and knowledge
 *   of the raw VRChat `instanceId` (not just its public topic hash), without ever sending
 *   `instanceId` over the wire.
 * - Preimage proof (`instancePreimageProof` / `verifyInstancePreimageProof`): sent in `CHALLENGE`
 *   requests so peers refuse to reveal their `vrcUserId`/`displayName`/`publicKey` to an attacker
 *   who only knows the topic hash.
 * - TOFU trust store (`vrc-trust.json` in `configDir()`): pins `vrcUserId -> publicKey`. Once a
 *   user confirms a peer in VR, future sessions in any instance auto-trust that peer; a different
 *   key claiming the same `vrcUserId` is flagged as `key_mismatch`.
 */
import { dirname, join } from "@std/path";
import { configDir } from "../appPaths.ts";

const encoder = new TextEncoder();

export const IDENTITY_FILENAME = "identity.json";
export const VRC_TRUST_FILENAME = "vrc-trust.json";

export type LocalIdentity = {
  publicKey: string;
  fingerprint: string;
  privateKey: CryptoKey;
};

export type TrustedPeerRecord = {
  userId: string;
  publicKey: string;
  fingerprint: string;
  displayName: string;
  trustedAt: string;
  lastSeenAt: string;
};

export type TrustEvaluation = "trusted" | "pending" | "key_mismatch" | "not_in_instance";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toHex(bytes: ArrayBuffer, length = 32): string {
  return [...new Uint8Array(bytes).slice(0, length)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Short human-readable fingerprint (e.g. `a1b2-c3d4-e5f6`) derived from a base64url public key. */
export async function keyFingerprint(publicKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`petplay:id:${publicKey}`));
  const hex = toHex(digest, 6);
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

/** Deterministic, privacy-preserving Stageforge topic name for a VRChat instance id. */
export async function vrcInstanceTopic(instanceId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`petplay:vrc:instance:v1:${instanceId}`),
  );
  return `vrc-inst-${toHex(digest, 16)}`;
}

/**
 * Symmetric 256-bit AES-GCM key (base64url) derived from the raw VRChat `instanceId`
 * (domain-separated from `vrcInstanceTopic`) used to seal `actorId` and Iroh routes on the
 * public topic server.
 */
export async function vrcInstanceTopicKey(instanceId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`petplay:vrc:topic-key:v1:${instanceId}`),
  );
  return toBase64Url(new Uint8Array(digest));
}

/** Fresh random challenge nonce (16 bytes, base64url). */
export function randomNonce(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * One-way proof that a peer knows the raw VRChat `instanceId` (not just its public topic hash),
 * bound to `(from, to, nonce)` so it cannot be replayed in reverse or to another peer.
 */
export async function instancePreimageProof(params: {
  instanceId: string;
  from: string;
  to: string;
  nonce: string;
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(
      `petplay:vrc:preimage:v1|${params.instanceId}|${params.from}|${params.to}|${params.nonce}`,
    ),
  );
  return toBase64Url(new Uint8Array(digest));
}

/** Verifies a peer's one-way `instanceId` preimage proof in constant time. */
export async function verifyInstancePreimageProof(params: {
  proof: string;
  instanceId: string;
  from: string;
  to: string;
  nonce: string;
}): Promise<boolean> {
  if (typeof params.proof !== "string" || !params.proof) return false;
  const expected = await instancePreimageProof(params);
  if (params.proof.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= params.proof.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function challengePayload(params: {
  actorId: string;
  vrcUserId: string;
  instanceId: string;
  nonce: string;
}): Uint8Array<ArrayBuffer> {
  const text = `petplay:vrc:challenge:v2|${params.actorId}|${params.vrcUserId}|${params.instanceId}|${params.nonce}`;
  const encoded = encoder.encode(text);
  const buf = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  buf.set(encoded);
  return buf;
}

/** Signs a peer challenge proving this actor holds `identity` and knows the raw `instanceId`. */
export async function signChallenge(
  identity: LocalIdentity,
  params: { actorId: string; vrcUserId: string; instanceId: string; nonce: string },
): Promise<string> {
  const sig = await crypto.subtle.sign("Ed25519", identity.privateKey, challengePayload(params));
  return toBase64Url(new Uint8Array(sig));
}

/** Verifies a peer's challenge response signature against its claimed raw Ed25519 public key. */
export async function verifyChallenge(params: {
  publicKey: string;
  signature: string;
  actorId: string;
  vrcUserId: string;
  instanceId: string;
  nonce: string;
}): Promise<boolean> {
  try {
    const rawKey = fromBase64Url(params.publicKey);
    if (rawKey.byteLength !== 32) return false;
    const rawSig = fromBase64Url(params.signature);
    if (rawSig.byteLength !== 64) return false;
    const key = await crypto.subtle.importKey("raw", rawKey, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, rawSig, challengePayload(params));
  } catch {
    return false;
  }
}

type StoredIdentityFile = {
  version: 1;
  jwk: JsonWebKey;
};

function writeJsonAtomic(path: string, data: unknown): void {
  Deno.mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  Deno.writeTextFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  Deno.renameSync(tmp, path);
}

export function defaultIdentityPath(): string {
  return Deno.env.get("PETPLAY_IDENTITY_PATH") ?? join(configDir(), IDENTITY_FILENAME);
}

export function defaultVrcTrustPath(): string {
  return Deno.env.get("PETPLAY_VRC_TRUST_PATH") ?? join(configDir(), VRC_TRUST_FILENAME);
}

/** Loads the persisted Ed25519 identity from disk, or generates and saves one if absent. */
export async function loadOrCreateIdentity(path = defaultIdentityPath()): Promise<LocalIdentity> {
  try {
    const parsed = JSON.parse(Deno.readTextFileSync(path)) as Partial<StoredIdentityFile>;
    if (parsed?.version === 1 && parsed.jwk && typeof parsed.jwk.x === "string") {
      const privateKey = await crypto.subtle.importKey(
        "jwk",
        parsed.jwk,
        { name: "Ed25519" },
        true,
        ["sign"],
      );
      const publicKey = parsed.jwk.x;
      return {
        publicKey,
        fingerprint: await keyFingerprint(publicKey),
        privateKey,
      };
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      console.warn(`[vrc] failed to load identity from ${path}, generating a new one:`, error);
    }
  }

  const pair = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const publicKey = toBase64Url(rawPub);
  writeJsonAtomic(path, { version: 1, jwk } satisfies StoredIdentityFile);
  return {
    publicKey,
    fingerprint: await keyFingerprint(publicKey),
    privateKey: pair.privateKey,
  };
}

type StoredTrustFile = {
  version: 1;
  peers: Record<string, TrustedPeerRecord>;
};

/** Persistent TOFU trust store mapping VRChat `usr_...` ids to pinned Ed25519 public keys. */
export class VrcTrustStore {
  #path: string;
  #peers = new Map<string, TrustedPeerRecord>();

  constructor(path = defaultVrcTrustPath()) {
    this.#path = path;
    this.reload();
  }

  get path(): string {
    return this.#path;
  }

  reload(): void {
    this.#peers.clear();
    try {
      const parsed = JSON.parse(Deno.readTextFileSync(this.#path)) as Partial<StoredTrustFile>;
      if (parsed?.version === 1 && parsed.peers && typeof parsed.peers === "object") {
        for (const [userId, rec] of Object.entries(parsed.peers)) {
          if (
            rec && typeof rec.publicKey === "string" && typeof rec.fingerprint === "string" &&
            typeof rec.displayName === "string"
          ) {
            this.#peers.set(userId, { ...rec, userId });
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        console.warn(`[vrc] failed to load trust store from ${this.#path}:`, error);
      }
    }
  }

  #save(): void {
    const peers: Record<string, TrustedPeerRecord> = {};
    for (const [userId, rec] of this.#peers.entries()) peers[userId] = rec;
    writeJsonAtomic(this.#path, { version: 1, peers } satisfies StoredTrustFile);
  }

  list(): TrustedPeerRecord[] {
    return [...this.#peers.values()];
  }

  get(userId: string): TrustedPeerRecord | null {
    return this.#peers.get(userId) ?? null;
  }

  /** Evaluates a verified peer's trust status given whether they are in our VRChat instance. */
  evaluate(userId: string, publicKey: string, inInstance: boolean): TrustEvaluation {
    if (!inInstance) return "not_in_instance";
    const pinned = this.#peers.get(userId);
    if (!pinned) return "pending";
    return pinned.publicKey === publicKey ? "trusted" : "key_mismatch";
  }

  /** Pins `userId -> publicKey`. Refuses to overwrite a mismatched key unless `force` is true. */
  trust(
    params: { userId: string; publicKey: string; fingerprint: string; displayName: string },
    options?: { force?: boolean },
  ): TrustedPeerRecord {
    const existing = this.#peers.get(params.userId);
    if (existing && existing.publicKey !== params.publicKey && !options?.force) {
      throw new Error(
        `key mismatch for ${params.userId}: pinned ${existing.fingerprint}, got ${params.fingerprint} (pass force: true to replace)`,
      );
    }
    const now = new Date().toISOString();
    const record: TrustedPeerRecord = {
      userId: params.userId,
      publicKey: params.publicKey,
      fingerprint: params.fingerprint,
      displayName: params.displayName,
      trustedAt: existing && existing.publicKey === params.publicKey ? existing.trustedAt : now,
      lastSeenAt: now,
    };
    this.#peers.set(params.userId, record);
    this.#save();
    return record;
  }

  /** Updates `lastSeenAt` / `displayName` for an already-trusted peer. */
  touch(userId: string, displayName: string): void {
    const existing = this.#peers.get(userId);
    if (!existing) return;
    existing.lastSeenAt = new Date().toISOString();
    if (displayName) existing.displayName = displayName;
    this.#save();
  }

  untrust(userId: string): boolean {
    const existed = this.#peers.delete(userId);
    if (existed) this.#save();
    return existed;
  }
}
