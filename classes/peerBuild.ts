/**
 * Receiving a whole PetPlay build from a trusted coop peer, so a pairing never waits on CI: the
 * sender builds locally (`deno task peer-build`, utils/peer-build.ts) and sends only the chunks
 * of the executable this machine does not already have, over the trusted link. This is the same
 * content-defined chunking as delta updates (classes/updateChunks.ts); a typical change is a few
 * MB of a ~500 MB binary. The result is checked against the sender's SHA-256 and installed by the
 * one installer backend (classes/installer.ts `installFile`), then PetPlay restarts into it.
 *
 * Unlike a live patch (classes/peerPatch.ts) this carries anything: new modules, imports and
 * exports, top-level code, the main process, native helpers, resources.
 *
 * The protocol, sender → receiver (vrcPeers `PEERBUILD*`, trusted peers with Peer Code Patches on):
 * 1. `PEERBUILDOFFER {id, build, target, index}` → `{ranges, reusedBytes, fetchBytes}`: the
 *    receiver copies every chunk it already has into a staging file and names the byte ranges
 *    still missing.
 * 2. `PEERBUILDDATA {id, offset, data}` (base64, ≤ 1 MB each) until the ranges are filled.
 * 3. `PEERBUILDCOMMIT {id, restart}` → the installer's result. `PEERBUILDABORT {id}` gives up.
 */
import type { BuildInfo } from "./buildInfo.ts";
import { installerTarget } from "./installer.ts";
import { previousExecutablePath } from "./install.ts";
import {
  type ChunkIndex,
  type FetchRange,
  indexLocalFiles,
  parseChunkIndex,
  planDelta,
} from "./updateChunks.ts";
import { sha256File, writeLocalChunks } from "./updater.ts";

export const PEER_BUILD_PIECE_BYTES = 1024 * 1024;
/** A transfer nobody touched for this long is dropped, staging file and all. */
const IDLE_MS = 3 * 60 * 1000;

export type PeerBuildOffer = {
  id: string;
  build: BuildInfo;
  /** Target triple of the executable; must be this machine's. */
  target: string;
  index: ChunkIndex;
};

export type PeerBuildPlan = {
  ranges: FetchRange[];
  reusedBytes: number;
  fetchBytes: number;
};

export type PeerBuildPiece = { id: string; offset: number; data: string };

type Session = {
  id: string;
  offer: PeerBuildOffer;
  staging: string;
  ranges: FetchRange[];
  received: number;
  fetchBytes: number;
  timer: ReturnType<typeof setTimeout>;
};

function stagingFor(target: string): string {
  return Deno.build.os === "windows"
    ? target.replace(/\.exe$/i, "") + ".peer.exe"
    : `${target}.peer`;
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** One receiving transfer at a time; a new offer replaces an unfinished one. */
export class PeerBuildReceiver {
  #session: Session | null = null;

  constructor(
    private readonly options: {
      targetPath?: () => string;
      localSources?: (target: string) => string[];
    } = {},
  ) {}

  get active(): { id: string; received: number; fetchBytes: number } | null {
    const s = this.#session;
    return s ? { id: s.id, received: s.received, fetchBytes: s.fetchBytes } : null;
  }

  async offer(offer: PeerBuildOffer): Promise<PeerBuildPlan> {
    if (offer.target !== Deno.build.target) {
      throw new Error(
        `this PetPlay runs ${Deno.build.target}; the offered build is ${offer.target}`,
      );
    }
    const index = parseChunkIndex(offer.index);
    this.abort();
    const target = (this.options.targetPath ?? installerTarget)();
    const staging = stagingFor(target);
    const sources = this.options.localSources?.(target) ??
      [target, previousExecutablePath(target), Deno.execPath()];
    const local = await indexLocalFiles(sources);
    // Every missing byte is sent once, so no merging of gaps into bigger requests.
    const plan = planDelta(index, local, { mergeGap: 0, maxRanges: Number.MAX_SAFE_INTEGER });
    await writeLocalChunks(index, plan, staging);
    this.#session = {
      id: offer.id,
      offer: { ...offer, index },
      staging,
      ranges: plan.ranges,
      received: 0,
      fetchBytes: plan.fetchBytes,
      timer: this.#idleTimer(),
    };
    return { ranges: plan.ranges, reusedBytes: plan.reusedBytes, fetchBytes: plan.fetchBytes };
  }

  async piece(piece: PeerBuildPiece): Promise<{ received: number; fetchBytes: number }> {
    const session = this.#require(piece.id);
    const bytes = decodeBase64(piece.data);
    const end = piece.offset + bytes.length;
    if (!session.ranges.some((r) => piece.offset >= r.start && end <= r.end)) {
      throw new Error(`bytes ${piece.offset}-${end} are not part of the requested ranges`);
    }
    const file = await Deno.open(session.staging, { write: true });
    try {
      await file.seek(piece.offset, Deno.SeekMode.Start);
      for (let written = 0; written < bytes.length;) {
        written += await file.write(bytes.subarray(written));
      }
    } finally {
      file.close();
    }
    session.received += bytes.length;
    this.#touch(session);
    return { received: session.received, fetchBytes: session.fetchBytes };
  }

  /**
   * Checks the assembled file and hands it to `install` (the installer backend); the staging
   * file is gone afterwards either way.
   */
  async commit<T>(
    id: string,
    install: (staging: string, sha256: string, build: BuildInfo) => Promise<T>,
  ): Promise<T> {
    const session = this.#require(id);
    clearTimeout(session.timer);
    this.#session = null;
    try {
      const actual = await sha256File(session.staging);
      if (actual !== session.offer.index.sha256) {
        throw new Error(
          `the received build does not match (${session.received} of ${session.fetchBytes} bytes arrived)`,
        );
      }
      return await install(session.staging, actual, session.offer.build);
    } finally {
      try {
        Deno.removeSync(session.staging);
      } catch {
        // Moved into place by the installer.
      }
    }
  }

  abort(id?: string): boolean {
    const session = this.#session;
    if (!session || (id != null && session.id !== id)) return false;
    clearTimeout(session.timer);
    this.#session = null;
    try {
      Deno.removeSync(session.staging);
    } catch {
      // Already gone.
    }
    return true;
  }

  #require(id: string): Session {
    const session = this.#session;
    if (!session || session.id !== id) throw new Error(`no peer build transfer ${id} in progress`);
    return session;
  }

  #idleTimer(): ReturnType<typeof setTimeout> {
    return setTimeout(() => this.abort(), IDLE_MS);
  }

  #touch(session: Session): void {
    clearTimeout(session.timer);
    session.timer = this.#idleTimer();
  }
}
