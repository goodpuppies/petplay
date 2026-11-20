/**
 * The household: machines that share a secret (`.secret` at the repo root, gitignored, the same
 * on each machine; or `PETPLAY_HOUSEHOLD_SECRET`) and offer their desktops to each other. Their
 * desktopSource and desktopInput actors meet on a topic derived from it (`householdTopic`), the
 * way a session's do (`session.ts`).
 *
 * The topic server relays topic names in the clear, so anyone listening could join the topic and
 * message the actors. A household actor therefore takes requests only inside
 * `GUARDED {proof, type, payload}`, with `proof = HMAC(secret, recipient actor id)`: the proof
 * names its recipient, so a fake desktop announced on the topic collects nothing that works on a
 * real one. Requests travel over iroh, end to end encrypted, so a proof is not seen in transit.
 *
 * Not covered yet: an actor relaying between a household member and a real desktop (actor routes
 * do not bind actor ids to iroh node ids); see markdown/rdp/peers.md.
 */

const encoder = new TextEncoder();

/** The household secret, or null when this machine has none. */
export function householdSecret(path?: string): string | null {
  const fromEnv = Deno.env.get("PETPLAY_HOUSEHOLD_SECRET");
  if (fromEnv) return fromEnv.trim() || null;
  const file = path ?? Deno.env.get("PETPLAY_HOUSEHOLD_SECRET_FILE") ??
    new URL("../../.secret", import.meta.url);
  try {
    const secret = Deno.readTextFileSync(file).trim();
    if (secret.length < 16) throw new Error("the household secret needs 16+ characters");
    return secret;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function hex(bytes: ArrayBuffer, length = 32): Promise<string> {
  return [...new Uint8Array(bytes).slice(0, length)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function householdTopic(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`rdp-home:${secret}`));
  return `rdp-home-${await hex(digest, 16)}`;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    encoder.encode(`rdp-home-proof:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** What a member presents to `recipient` (an actor id). */
export async function householdProof(secret: string, recipient: string): Promise<string> {
  const key = await hmacKey(secret);
  return await hex(await crypto.subtle.sign("HMAC", key, encoder.encode(recipient)));
}

/** Constant-time string comparison. */
function same(a: unknown, b: string): boolean {
  if (typeof a !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The receiving side: once enabled, requests need the proof made for this actor. */
export class HouseholdGuard {
  #expected: string | null = null;
  rejected = 0;

  get active(): boolean {
    return this.#expected !== null;
  }

  async enable(secret: string, self: string): Promise<void> {
    this.#expected = await householdProof(secret, self);
  }

  check(proof: unknown): boolean {
    const ok = this.#expected !== null && same(proof, this.#expected);
    if (!ok) this.rejected++;
    return ok;
  }
}

export type Guarded = { proof: string; type: string; payload?: unknown };

/**
 * The `GUARDED` handler: checks the proof and runs one of `handlers`. A household actor's other
 * entry points refuse while the guard is active (`refuseWhenGuarded`).
 */
export function guardedDispatch(
  guard: HouseholdGuard,
  handlers: Record<string, (payload: unknown) => unknown>,
): (request: Guarded) => unknown {
  return (request: Guarded) => {
    if (!guard.active) throw new Error("not a household actor");
    if (!guard.check(request?.proof)) throw new Error("not part of this household");
    const handler = handlers[request.type];
    if (!handler) throw new Error(`no household request ${request.type}`);
    return handler(request.payload);
  };
}

export function refuseWhenGuarded<P, R>(
  guard: HouseholdGuard,
  handler: (payload: P) => R,
): (payload: P) => R {
  return (payload: P) => {
    if (guard.active) {
      guard.rejected++;
      throw new Error("household actor: send GUARDED with a proof");
    }
    return handler(payload);
  };
}
