/**
 * Overlay keys are global to the SteamVR runtime, and every PetPlay instance used
 * the same one — so two sessions fought over a single overlay and whichever
 * started second destroyed the first one's handle. Each host process now claims
 * `<base>.<pid>` (stable across an actor reload, distinct between instances), and
 * the claim file records who holds what so the next process can destroy the
 * overlays of instances that died without cleaning up (a `/reload`, a group
 * signal, a native crash) instead of leaving a ghost overlay behind.
 *
 * Liveness is only checked where it is cheap and reliable (`/proc` on Linux);
 * elsewhere claims are treated as live, which errs towards not touching another
 * session's overlay.
 */
export type OverlayKeyClaim = {
  /** Keys this process owns. */
  keys: string[];
  /** Keys owned by processes that are gone, handed over for destruction. */
  staleKeys: string[];
};

const CLAIMS_PATH_ENV = "PETPLAY_OVERLAY_CLAIMS_PATH";
const DEFAULT_CLAIMS_PATH = "./tmp/webxr-overlay-claims.json";
/** Only the most recent claims are worth keeping; a sweep list is not a log. */
const MAX_RECORDED_CLAIMS = 8;

type RecordedClaim = { pid: number; keys: string[] };

export function claimWebXrOverlayKeys(baseKeys: string[]): OverlayKeyClaim {
  const path = Deno.env.get(CLAIMS_PATH_ENV) ?? DEFAULT_CLAIMS_PATH;
  const recorded = readClaims(path);
  const staleKeys: string[] = [];
  const alive: RecordedClaim[] = [];
  const pid = Deno.pid;
  for (const claim of recorded) {
    if (claim.pid === pid || isProcessAlive(claim.pid)) {
      alive.push(claim);
      continue;
    }
    staleKeys.push(...claim.keys);
  }
  const keys = baseKeys.map((base) => `${base}.${pid}`);
  const next = [...alive.filter((claim) => claim.pid !== pid), { pid, keys }]
    .slice(-MAX_RECORDED_CLAIMS);
  writeClaims(path, next);
  return { keys, staleKeys };
}

function readClaims(path: string): RecordedClaim[] {
  try {
    const parsed = JSON.parse(Deno.readTextFileSync(path)) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is RecordedClaim =>
      entry != null && typeof entry === "object" &&
      typeof (entry as RecordedClaim).pid === "number" &&
      Array.isArray((entry as RecordedClaim).keys)
    );
  } catch {
    return [];
  }
}

function writeClaims(path: string, claims: RecordedClaim[]): void {
  try {
    Deno.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    Deno.writeTextFileSync(path, JSON.stringify(claims));
  } catch {
    // No claim file: keys are still unique per process, only ghost sweeping is lost.
  }
}

function isProcessAlive(pid: number): boolean {
  if (Deno.build.os !== "linux") {
    return true;
  }
  try {
    Deno.statSync(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
}
