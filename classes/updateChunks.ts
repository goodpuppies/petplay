/**
 * Delta updates for PetPlay's ~500 MB release executables, without per-version patches.
 *
 * CI cuts every release binary into content-defined chunks (a gear-hash FastCDC, so an edit only
 * moves the chunk boundaries next to it) and publishes the list as `<asset>.chunks.json` next to
 * the binary. An updating PetPlay cuts the executables it already has (itself, the installed copy)
 * the same way, keeps every chunk whose hash it already holds, and fetches only the missing byte
 * ranges of the published binary with HTTP `Range` requests. Unlike Deno's bsdiff chain
 * (`deno upgrade` patches N→N+1, at most three steps), this works from any build to any other,
 * which is what switching between branch builds needs, and CI needs no previous binary.
 *
 * Every fetched range is checked against its chunk hashes, and the assembled file against the
 * whole-file SHA-256, so a wrong chunk can only cost a full download, never a broken install.
 */
import { createHash } from "node:crypto";

export const CHUNK_ALGORITHM = "gear-fastcdc-v1";
const MIN_CHUNK = 16 * 1024;
const AVG_CHUNK = 64 * 1024;
const MAX_CHUNK = 256 * 1024;
/** Stricter mask before the average size, looser after (FastCDC normalized chunking). */
const MASK_SMALL = 0xffffc000; // top 18 bits
const MASK_LARGE = 0xfffc0000; // top 14 bits
const READ_BLOCK = 8 * 1024 * 1024;

export type ChunkIndex = {
  version: 1;
  algorithm: typeof CHUNK_ALGORITHM;
  /** The file the chunks make up. */
  size: number;
  sha256: string;
  /** Chunk lengths in file order; offsets are their running sum. */
  lengths: number[];
  /** Truncated (128-bit) SHA-256 of each chunk, hex. */
  hashes: string[];
};

export type Chunk = { offset: number; length: number; hash: string };

/** The fixed gear table: splitmix32 from a constant seed, so CI and every client agree. */
const GEAR = (() => {
  const table = new Uint32Array(256);
  let state = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    table[i] = (z ^ (z >>> 16)) >>> 0;
  }
  return table;
})();

function chunkHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

/**
 * Cuts a byte stream into chunks. Yields each chunk with its offset and hash, and finally the
 * whole stream's SHA-256 through `onDone`.
 */
export async function* chunkStream(
  source: AsyncIterable<Uint8Array>,
  onDone?: (whole: { size: number; sha256: string }) => void,
): AsyncGenerator<Chunk> {
  const whole = createHash("sha256");
  let pending = new Uint8Array(0);
  let offset = 0;
  const cutAll = function* (final: boolean): Generator<Chunk> {
    let start = 0;
    while (pending.length - start >= (final ? 1 : MAX_CHUNK)) {
      const length = cutPoint(pending, start, Math.min(pending.length, start + MAX_CHUNK));
      const bytes = pending.subarray(start, start + length);
      yield { offset, length, hash: chunkHash(bytes) };
      offset += length;
      start += length;
    }
    pending = pending.slice(start);
  };
  for await (const block of source) {
    whole.update(block);
    const joined = new Uint8Array(pending.length + block.length);
    joined.set(pending);
    joined.set(block, pending.length);
    pending = joined;
    yield* cutAll(false);
  }
  yield* cutAll(true);
  onDone?.({ size: offset, sha256: whole.digest("hex") });
}

/** Length of the chunk starting at `start`, ending no later than `end`. */
function cutPoint(bytes: Uint8Array, start: number, end: number): number {
  const available = end - start;
  if (available <= MIN_CHUNK) return available;
  const normal = Math.min(start + AVG_CHUNK, end);
  let hash = 0;
  let i = start + MIN_CHUNK;
  for (; i < normal; i++) {
    hash = ((hash << 1) + GEAR[bytes[i]!]!) >>> 0;
    if ((hash & MASK_SMALL) === 0) return i + 1 - start;
  }
  for (; i < end; i++) {
    hash = ((hash << 1) + GEAR[bytes[i]!]!) >>> 0;
    if ((hash & MASK_LARGE) === 0) return i + 1 - start;
  }
  return available;
}

export async function* readFileBlocks(path: string, blockSize = READ_BLOCK) {
  const file = await Deno.open(path, { read: true });
  try {
    const buffer = new Uint8Array(blockSize);
    for (;;) {
      const read = await file.read(buffer);
      if (read == null || read === 0) break;
      yield buffer.slice(0, read);
    }
  } finally {
    file.close();
  }
}

/** The chunk index of a file on disk (CI runs this on every release binary). */
export async function indexFile(path: string): Promise<ChunkIndex> {
  const lengths: number[] = [];
  const hashes: string[] = [];
  let whole = { size: 0, sha256: "" };
  for await (const chunk of chunkStream(readFileBlocks(path), (w) => whole = w)) {
    lengths.push(chunk.length);
    hashes.push(chunk.hash);
  }
  return {
    version: 1,
    algorithm: CHUNK_ALGORITHM,
    size: whole.size,
    sha256: whole.sha256,
    lengths,
    hashes,
  };
}

export function parseChunkIndex(value: unknown): ChunkIndex {
  const index = value as Partial<ChunkIndex>;
  if (
    index?.version !== 1 || index.algorithm !== CHUNK_ALGORITHM ||
    !Array.isArray(index.lengths) || !Array.isArray(index.hashes) ||
    index.lengths.length !== index.hashes.length || typeof index.size !== "number" ||
    typeof index.sha256 !== "string"
  ) {
    throw new Error("unsupported or malformed chunk index");
  }
  let total = 0;
  for (const length of index.lengths) {
    if (!Number.isInteger(length) || length <= 0 || length > MAX_CHUNK) {
      throw new Error("chunk index has an invalid chunk length");
    }
    total += length;
  }
  if (total !== index.size) throw new Error("chunk index lengths do not add up to its size");
  return index as ChunkIndex;
}

export type LocalChunk = { path: string; offset: number; length: number };
export type FetchRange = { start: number; end: number }; // end exclusive

export type DeltaPlan = {
  /** For each target chunk: where to copy it from locally, or `null` to fetch it. */
  sources: (LocalChunk | null)[];
  offsets: number[];
  /** Missing bytes, merged into few `Range` requests (small gaps are fetched rather than split). */
  ranges: FetchRange[];
  reusedBytes: number;
  fetchBytes: number;
};

/** Indexes local files (by chunk hash) so a plan can reuse them. */
export async function indexLocalFiles(paths: readonly string[]): Promise<Map<string, LocalChunk>> {
  const local = new Map<string, LocalChunk>();
  for (const path of new Set(paths)) {
    try {
      for await (const chunk of chunkStream(readFileBlocks(path))) {
        if (!local.has(chunk.hash)) {
          local.set(chunk.hash, { path, offset: chunk.offset, length: chunk.length });
        }
      }
    } catch {
      // Unreadable (gone, or locked on Windows): it just contributes nothing.
    }
  }
  return local;
}

export function planDelta(
  target: ChunkIndex,
  local: ReadonlyMap<string, LocalChunk>,
  options: { mergeGap?: number; maxRanges?: number } = {},
): DeltaPlan {
  const mergeGap = options.mergeGap ?? 256 * 1024;
  const maxRanges = options.maxRanges ?? 64;
  const sources: (LocalChunk | null)[] = [];
  const offsets: number[] = [];
  let ranges: FetchRange[] = [];
  let offset = 0;
  let reusedBytes = 0;
  for (let i = 0; i < target.lengths.length; i++) {
    const length = target.lengths[i]!;
    const hit = local.get(target.hashes[i]!);
    const source = hit && hit.length === length ? hit : null;
    sources.push(source);
    offsets.push(offset);
    if (source) {
      reusedBytes += length;
    } else {
      const last = ranges.at(-1);
      if (last && offset - last.end <= mergeGap) last.end = offset + length;
      else ranges.push({ start: offset, end: offset + length });
    }
    offset += length;
  }
  // Too many requests: keep merging across the smallest gaps.
  while (ranges.length > maxRanges) {
    let smallest = 1;
    for (let i = 2; i < ranges.length; i++) {
      if (
        ranges[i]!.start - ranges[i - 1]!.end < ranges[smallest]!.start - ranges[smallest - 1]!.end
      ) {
        smallest = i;
      }
    }
    ranges[smallest - 1]!.end = ranges[smallest]!.end;
    ranges = ranges.filter((_, i) => i !== smallest);
  }
  const fetchBytes = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
  return { sources, offsets, ranges, reusedBytes, fetchBytes };
}
