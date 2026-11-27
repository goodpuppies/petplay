/**
 * PetPlay's in-program updater, for release builds (a checkout updates with `git pull`).
 *
 * **Channels.** `stable` is the latest GitHub release of `goodpuppies/petplay`. Every branch that
 * passes CI, in that repo or in any fork whose Actions are enabled, also publishes a prerelease
 * (`.github/workflows/branch-build.yml`); `owner/repo#branch` follows one. A build follows the
 * channel it was built from unless Settings → Install picks another, so a tester given a branch
 * build keeps getting that branch.
 *
 * **Applying** runs in its own process (`petplay --update`, classes/updateCli.ts), never in a
 * scene worker: it reads ~500 MB. It takes a lock, fetches only the chunks the executables on
 * disk do not already contain (classes/updateChunks.ts; falls back to a resumable full download),
 * checks the result against the release's `SHA256SUMS`, runs the new binary's `--version` to
 * prove it starts, and only then swaps it in, keeping the old one for `--update-rollback`.
 */
import { dirname, join } from "@std/path";
import { createHash } from "node:crypto";
import { installDir, installedExecutablePath } from "./appPaths.ts";
import { type BuildInfo, getBuildInfo } from "./buildInfo.ts";
import {
  BRANCH_BUILD_TAG_PREFIX,
  type BranchBuildMetadata,
  parseBuildMetadata,
} from "./branchBuild.ts";
import { GitHubClient, GitHubNotFoundError } from "./githubApi.ts";
import { installState, previousExecutablePath, swapInExecutable } from "./install.ts";
import {
  type ChunkIndex,
  type FetchRange,
  indexLocalFiles,
  parseChunkIndex,
  planDelta,
  readFileBlocks,
} from "./updateChunks.ts";

export const STABLE_CHANNEL = "stable";
const DEFAULT_RELEASE_REPO = "goodpuppies/petplay";
const SUMS_ASSET = "SHA256SUMS";
/** Below this share of reused bytes a delta is not worth its extra requests. */
const MIN_DELTA_REUSE = 0.1;
const DOWNLOAD_ATTEMPTS = 5;
const IDLE_TIMEOUT_MS = 30_000;
const RANGE_CONCURRENCY = 4;
const SMOKE_TIMEOUT_MS = 90_000;
const STALE_LOCK_MS = 60 * 60 * 1000;

export type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
  /** `sha256:<hex>`, which GitHub computes on upload (absent on older assets). */
  digest?: string | null;
};

function pickAsset(asset: ReleaseAsset | undefined): ReleaseAsset | null {
  return asset
    ? {
      name: asset.name,
      browser_download_url: asset.browser_download_url,
      size: asset.size,
      digest: asset.digest ?? null,
    }
    : null;
}

export type GitHubRelease = {
  tag_name: string;
  name?: string | null;
  body?: string | null;
  html_url: string;
  target_commitish?: string;
  published_at?: string | null;
  created_at?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  assets: ReleaseAsset[];
};

export function releaseRepo(): string {
  return Deno.env.get("PETPLAY_UPDATE_REPO") || DEFAULT_RELEASE_REPO;
}

/** Matches the release asset names in `.github/workflows/release.yml`. */
export function releaseAssetName(
  os: string = Deno.build.os,
  arch: string = Deno.build.arch,
): string | null {
  if (os === "windows" && arch === "x86_64") return "petplay.exe";
  if (os === "linux" && arch === "x86_64") return "petplay";
  if (os === "linux" && arch === "aarch64") return "petplay-aarch64";
  return null;
}

export function chunkIndexAssetName(assetName: string): string {
  return `${assetName}.chunks.json`;
}

// ---------------------------------------------------------------------------------------------
// Versions

export type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  commitsAhead: number;
};

/** Parses `v0.0.17` or `v0.0.17-5-gabc1234(-dirty)`; returns `null` for non-semver tags. */
export function parseVersionTag(version: string): ParsedVersion | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-(\d+)-g[0-9a-f]+)?(?:-dirty)?$/i);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    commitsAhead: match[4] ? Number(match[4]) : 0,
  };
}

/**
 * True when `latestTag` is strictly newer than `currentVersion`.
 * A build with commits ahead of `vX.Y.Z` (`vX.Y.Z-N-g...`) is considered newer than `vX.Y.Z`,
 * and older than `vX.Y.(Z+1)`.
 */
export function isNewerRelease(currentVersion: string, latestTag: string): boolean {
  const latest = parseVersionTag(latestTag);
  if (!latest) return false;
  const current = parseVersionTag(currentVersion);
  if (!current) return currentVersion !== latestTag;
  if (latest.major !== current.major) return latest.major > current.major;
  if (latest.minor !== current.minor) return latest.minor > current.minor;
  if (latest.patch !== current.patch) return latest.patch > current.patch;
  return latest.commitsAhead > current.commitsAhead;
}

// ---------------------------------------------------------------------------------------------
// Channels and the builds they offer

export type ChannelRef = { id: string; repo: string; branch: string | null };

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isChannelId(value: unknown): value is string {
  return typeof value === "string" && parseChannel(value) != null;
}

/** `stable` or `owner/repo#branch`. */
export function parseChannel(id: string): ChannelRef | null {
  if (id === STABLE_CHANNEL) return { id, repo: releaseRepo(), branch: null };
  const hash = id.indexOf("#");
  if (hash <= 0) return null;
  const repo = id.slice(0, hash);
  const branch = id.slice(hash + 1);
  if (!REPO_PATTERN.test(repo) || branch === "" || /[\s~^:?*\[\\]/.test(branch)) return null;
  return { id, repo, branch };
}

export function branchChannelId(repo: string, branch: string): string {
  return `${repo}#${branch}`;
}

/** The channel the running build came from: its build-info, else `stable` for a release tag. */
export function buildChannel(build: BuildInfo = getBuildInfo()): string | null {
  if (build.channel && isChannelId(build.channel)) return build.channel;
  // Releases up to v0.0.36 call themselves "-dirty" (CI touched submodules); still a release.
  const parsed = parseVersionTag(build.version);
  return parsed && parsed.commitsAhead === 0 ? STABLE_CHANNEL : null;
}

/** What the Settings channel picker and checks use: the setting, else the build's own channel. */
export function effectiveChannel(setting: string | null, build = getBuildInfo()): string {
  if (setting && isChannelId(setting)) return setting;
  return buildChannel(build) ?? STABLE_CHANNEL;
}

export type BuildCandidate = {
  channel: string;
  repo: string;
  branch: string | null;
  tag: string;
  version: string;
  commit: string | null;
  publishedAt: string | null;
  releaseUrl: string;
  /** The CI run that built it, for branch builds. */
  runUrl: string | null;
  binary: ReleaseAsset;
  chunks: ReleaseAsset | null;
  sums: ReleaseAsset;
};

function candidateFrom(
  channel: string,
  repo: string,
  release: GitHubRelease,
  assetName: string,
  meta: BranchBuildMetadata | null,
): BuildCandidate | null {
  const binary = pickAsset(release.assets.find((a) => a.name === assetName));
  const sums = pickAsset(release.assets.find((a) => a.name === SUMS_ASSET));
  // A release still uploading (or one CI never finished) is not offered.
  if (!binary || !sums) return null;
  return {
    channel,
    repo,
    branch: meta?.branch ?? null,
    tag: release.tag_name,
    version: meta?.version ?? release.tag_name,
    commit: meta?.commit ?? null,
    publishedAt: release.published_at ?? release.created_at ?? null,
    releaseUrl: release.html_url,
    runUrl: meta?.run ?? null,
    binary,
    chunks: pickAsset(release.assets.find((a) => a.name === chunkIndexAssetName(assetName))),
    sums,
  };
}

export function stableCandidate(
  repo: string,
  release: GitHubRelease,
  assetName: string,
): BuildCandidate | null {
  if (release.draft || release.prerelease) return null;
  return candidateFrom(STABLE_CHANNEL, repo, release, assetName, null);
}

/** The newest complete build of each branch among a repo's releases. */
export function branchCandidates(
  repo: string,
  releases: readonly GitHubRelease[],
  assetName: string,
): BuildCandidate[] {
  const newest = new Map<string, BuildCandidate>();
  for (const release of releases) {
    if (release.draft || !release.tag_name.startsWith(BRANCH_BUILD_TAG_PREFIX)) continue;
    const meta = parseBuildMetadata(release.body);
    if (!meta) continue;
    const candidate = candidateFrom(
      branchChannelId(repo, meta.branch),
      repo,
      release,
      assetName,
      meta,
    );
    if (!candidate) continue;
    const seen = newest.get(meta.branch);
    if (!seen || (candidate.publishedAt ?? "") > (seen.publishedAt ?? "")) {
      newest.set(meta.branch, candidate);
    }
  }
  return [...newest.values()].sort((a, b) =>
    (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")
  );
}

type GitHubRepo = { full_name: string; pushed_at?: string | null; archived?: boolean };

/** Forks pushed to within this long are scanned for branch builds. */
const FORK_RECENCY_MS = 90 * 24 * 3600 * 1000;
const MAX_FORKS = 20;

export type ChannelListing = {
  channels: BuildCandidate[];
  /** Repos that could not be read (rate limit, network), one line each. */
  warnings: string[];
};

function userAgent(): string {
  return `PetPlay-updater/${getBuildInfo().version}`;
}

export function defaultClient(fetchImpl?: typeof fetch): GitHubClient {
  return new GitHubClient({ fetchImpl, userAgent: userAgent() });
}

/**
 * Every channel with a build for this platform: stable, then branch builds of the main repo, its
 * recently pushed forks and `extraRepos`, newest first.
 */
export async function listChannels(
  options: { extraRepos?: readonly string[]; client?: GitHubClient } = {},
): Promise<ChannelListing> {
  const client = options.client ?? defaultClient();
  const assetName = releaseAssetName();
  const warnings: string[] = [];
  if (!assetName) {
    return { channels: [], warnings: [`No builds for ${Deno.build.os}/${Deno.build.arch}`] };
  }
  const upstream = releaseRepo();
  const channels: BuildCandidate[] = [];
  try {
    const latest = await client.get<GitHubRelease>(`/repos/${upstream}/releases/latest`);
    const stable = stableCandidate(upstream, latest, assetName);
    if (stable) channels.push(stable);
  } catch (error) {
    warnings.push(`${upstream} stable: ${message(error)}`);
  }
  const repos = [upstream];
  try {
    const forks = await client.get<GitHubRepo[]>(
      `/repos/${upstream}/forks?sort=newest&per_page=100`,
    );
    const cutoff = Date.now() - FORK_RECENCY_MS;
    for (const fork of forks) {
      if (fork.archived || Date.parse(fork.pushed_at ?? "") < cutoff) continue;
      repos.push(fork.full_name);
      if (repos.length > MAX_FORKS) break;
    }
  } catch (error) {
    warnings.push(`${upstream} forks: ${message(error)}`);
  }
  for (const repo of options.extraRepos ?? []) {
    if (REPO_PATTERN.test(repo) && !repos.includes(repo)) repos.push(repo);
  }
  for (const repo of repos) {
    try {
      const releases = await client.get<GitHubRelease[]>(`/repos/${repo}/releases?per_page=100`);
      channels.push(...branchCandidates(repo, releases, assetName));
    } catch (error) {
      if (!(error instanceof GitHubNotFoundError)) warnings.push(`${repo}: ${message(error)}`);
    }
  }
  return { channels, warnings };
}

/** The newest build on one channel, or `null` when it has none for this platform. */
export async function latestOnChannel(
  channel: string,
  client: GitHubClient = defaultClient(),
): Promise<BuildCandidate | null> {
  const ref = parseChannel(channel);
  const assetName = releaseAssetName();
  if (!ref) throw new Error(`Not an update channel: ${channel}`);
  if (!assetName) return null;
  if (ref.branch == null) {
    try {
      const latest = await client.get<GitHubRelease>(`/repos/${ref.repo}/releases/latest`);
      return stableCandidate(ref.repo, latest, assetName);
    } catch (error) {
      if (error instanceof GitHubNotFoundError) return null;
      throw error;
    }
  }
  const releases = await client.get<GitHubRelease[]>(`/repos/${ref.repo}/releases?per_page=100`);
  return branchCandidates(ref.repo, releases, assetName).find((c) => c.branch === ref.branch) ??
    null;
}

// ---------------------------------------------------------------------------------------------
// Checking

export type UpdateStatus =
  /** The channel's build is the one running. */
  | "up-to-date"
  /** A newer build on the channel this build came from. */
  | "update"
  /** A different build: another channel, or an older stable after a branch build. */
  | "switch"
  /** The channel has no build for this platform. */
  | "unavailable";

export type UpdateCheckResult = {
  current: BuildInfo;
  channel: string;
  status: UpdateStatus;
  candidate: BuildCandidate | null;
  /** This process can install it (a release build); otherwise `reason` says why not. */
  canApply: boolean;
  reason: string | null;
};

function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length, 40);
  return n >= 7 && a.slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase();
}

export function classifyCandidate(
  current: BuildInfo,
  channel: string,
  candidate: BuildCandidate | null,
): UpdateStatus {
  if (!candidate) return "unavailable";
  const fromChannel = buildChannel(current);
  if (candidate.branch == null) {
    if (current.version.replace(/-dirty$/, "") === candidate.tag) return "up-to-date";
    if (fromChannel === STABLE_CHANNEL) {
      return isNewerRelease(current.version, candidate.tag) ? "update" : "up-to-date";
    }
    return "switch";
  }
  if (sameCommit(current.commit, candidate.commit)) return "up-to-date";
  return fromChannel === channel ? "update" : "switch";
}

export async function checkForUpdate(
  options: { channel?: string; client?: GitHubClient; build?: BuildInfo } = {},
): Promise<UpdateCheckResult> {
  const current = options.build ?? getBuildInfo();
  const channel = options.channel ?? effectiveChannel(null, current);
  const candidate = await latestOnChannel(channel, options.client);
  const status = classifyCandidate(current, channel, candidate);
  const reason = !Deno.build.standalone
    ? "a source checkout updates with git pull"
    : candidate == null
    ? `no ${releaseAssetName() ?? Deno.build.target} build on ${channel}`
    : null;
  return { current, channel, status, candidate, canApply: reason == null, reason };
}

// ---------------------------------------------------------------------------------------------
// Applying

export type UpdateProgress = {
  phase: "preparing" | "indexing" | "downloading" | "verifying" | "testing" | "installing";
  /** `delta` fetches only missing chunks; `full` downloads the whole binary. */
  mode?: "delta" | "full";
  receivedBytes: number;
  /** Bytes this phase will fetch (download size for a delta, not the binary size). */
  totalBytes: number | null;
  /** Bytes a delta took from executables already on disk. */
  reusedBytes?: number;
};

export type UpdateApplyResult = {
  installed: BuildInfo;
  targetPath: string;
  mode: "delta" | "full";
  downloadedBytes: number;
  reusedBytes: number;
  previousPath: string | null;
};

type ApplyOptions = {
  onProgress?: (progress: UpdateProgress) => void;
  fetchImpl?: typeof fetch;
  /** Where to install; default the installed copy, else the running executable. */
  targetPath?: string;
  /** Skip running the new binary (tests with fake binaries). */
  skipSmokeTest?: boolean;
};

/** Where an update goes: the installed copy when there is one, else the running executable. */
export function updateTargetPath(): string {
  return installState().installed ? installedExecutablePath() : Deno.execPath();
}

function incomingPath(target: string): string {
  return Deno.build.os === "windows"
    ? target.replace(/\.exe$/i, "") + ".incoming.exe"
    : `${target}.incoming`;
}

export async function applyUpdate(
  candidate: BuildCandidate,
  options: ApplyOptions = {},
): Promise<UpdateApplyResult> {
  if (!Deno.build.standalone && options.targetPath == null) {
    throw new Error("In-app updates only apply to release builds (use git pull in a checkout).");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const progress = options.onProgress ?? (() => {});
  const target = options.targetPath ?? updateTargetPath();
  const incoming = incomingPath(target);
  const release = await acquireUpdateLock(dirname(target));
  try {
    progress({ phase: "preparing", receivedBytes: 0, totalBytes: null });
    const sums = await fetchText(candidate.sums.browser_download_url, fetchImpl);
    const expected = parseSha256Sums(sums, candidate.binary.name);
    if (!expected) {
      throw new Error(`${SUMS_ASSET} of ${candidate.tag} lists no ${candidate.binary.name}`);
    }
    // GitHub's own digest of the upload must agree with what CI wrote.
    const digest = candidate.binary.digest?.replace(/^sha256:/, "").toLowerCase();
    if (digest && digest !== expected) {
      throw new Error(
        `${candidate.binary.name} of ${candidate.tag} does not match its ${SUMS_ASSET}`,
      );
    }
    let index: ChunkIndex | null = null;
    if (candidate.chunks) {
      try {
        const text = await fetchText(candidate.chunks.browser_download_url, fetchImpl);
        const indexSum = parseSha256Sums(sums, candidate.chunks.name);
        if (indexSum && sha256Text(text) === indexSum) {
          const parsed = parseChunkIndex(JSON.parse(text));
          if (parsed.sha256 === expected && parsed.size === candidate.binary.size) index = parsed;
        }
      } catch {
        // No usable index: full download.
      }
    }

    const sources = [target, previousExecutablePath(target), Deno.execPath()];
    let mode: "delta" | "full" = "full";
    let downloadedBytes = 0;
    let reusedBytes = 0;
    if (index) {
      progress({ phase: "indexing", mode: "delta", receivedBytes: 0, totalBytes: null });
      const local = await indexLocalFiles(sources.filter(exists));
      const plan = planDelta(index, local);
      if (plan.reusedBytes >= index.size * MIN_DELTA_REUSE) {
        mode = "delta";
        reusedBytes = plan.reusedBytes;
        try {
          await assembleDelta(
            index,
            plan,
            incoming,
            candidate.binary.browser_download_url,
            fetchImpl,
            (n) => {
              downloadedBytes = n;
              progress({
                phase: "downloading",
                mode: "delta",
                receivedBytes: n,
                totalBytes: plan.fetchBytes,
                reusedBytes,
              });
            },
          );
          progress({
            phase: "verifying",
            mode,
            receivedBytes: downloadedBytes,
            totalBytes: plan.fetchBytes,
            reusedBytes,
          });
          // A wrong range (a proxy that ignores Range, a replaced asset) fails here.
          if (await sha256File(incoming) !== expected) throw new Error("delta result mismatch");
        } catch (error) {
          console.warn(`[updater] delta update failed (${message(error)}); downloading in full`);
          mode = "full";
          reusedBytes = 0;
        }
      }
    }
    if (mode === "full") {
      await downloadFull(
        candidate.binary.browser_download_url,
        incoming,
        candidate.binary.size,
        fetchImpl,
        (n) => {
          downloadedBytes = n;
          progress({
            phase: "downloading",
            mode,
            receivedBytes: n,
            totalBytes: candidate.binary.size,
          });
        },
      );
      progress({
        phase: "verifying",
        mode,
        receivedBytes: downloadedBytes,
        totalBytes: candidate.binary.size,
      });
      const actual = await sha256File(incoming);
      if (actual !== expected) {
        throw new Error(
          `SHA-256 mismatch for ${candidate.binary.name} (expected ${expected.slice(0, 12)}, got ${
            actual.slice(0, 12)
          })`,
        );
      }
    }

    if (Deno.build.os !== "windows") Deno.chmodSync(incoming, 0o755);
    progress({ phase: "testing", mode, receivedBytes: downloadedBytes, totalBytes: null });
    const installed = options.skipSmokeTest
      ? {
        version: candidate.version,
        commit: candidate.commit,
        built: candidate.publishedAt,
        mode: "production",
        channel: candidate.channel,
      }
      : await smokeTestExecutable(incoming);
    installed.channel ??= candidate.channel;

    progress({ phase: "installing", mode, receivedBytes: downloadedBytes, totalBytes: null });
    const previousPath = swapInExecutable(incoming, target);
    writeInstallRecord(target, installed, candidate.releaseUrl);
    return { installed, targetPath: target, mode, downloadedBytes, reusedBytes, previousPath };
  } finally {
    try {
      Deno.removeSync(incoming);
    } catch {
      // Moved into place, or never written.
    }
    release();
  }
}

/** Puts the kept previous build back (and keeps the current one as the new previous). */
export async function rollbackUpdate(
  options: { targetPath?: string; skipSmokeTest?: boolean } = {},
): Promise<UpdateApplyResult> {
  const target = options.targetPath ?? updateTargetPath();
  const previous = previousExecutablePath(target);
  if (!exists(previous)) throw new Error(`No previous build kept at ${previous}`);
  const release = await acquireUpdateLock(dirname(target));
  const incoming = incomingPath(target);
  try {
    Deno.copyFileSync(previous, incoming);
    if (Deno.build.os !== "windows") Deno.chmodSync(incoming, 0o755);
    const installed = options.skipSmokeTest
      ? { version: "unknown", commit: null, built: null, mode: "production" }
      : await smokeTestExecutable(incoming);
    const previousPath = swapInExecutable(incoming, target);
    writeInstallRecord(target, installed, previous);
    return {
      installed,
      targetPath: target,
      mode: "full",
      downloadedBytes: 0,
      reusedBytes: 0,
      previousPath,
    };
  } finally {
    try {
      Deno.removeSync(incoming);
    } catch {
      // Moved into place.
    }
    release();
  }
}

function writeInstallRecord(target: string, build: BuildInfo, from: string): void {
  if (target !== installedExecutablePath()) return;
  try {
    Deno.writeTextFileSync(
      join(installDir(), "install.json"),
      JSON.stringify({ ...build, installedAt: new Date().toISOString(), from }, null, 2) + "\n",
    );
  } catch {
    // Non-fatal: the binary is already updated, and reports its own build.
  }
}

/**
 * Runs `<binary> --version --json` and returns the build it reports. Every PetPlay release
 * handles `--version` before starting anything; builds before `--json` print one line instead.
 */
export async function smokeTestExecutable(path: string): Promise<BuildInfo> {
  const output = await new Deno.Command(path, {
    args: ["--version", "--json"],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: { PETPLAY_LOG_PARENT_PID: "" },
    signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS),
  }).output();
  const text = new TextDecoder().decode(output.stdout).trim();
  if (!output.success) {
    const err = new TextDecoder().decode(output.stderr).trim().split("\n").at(-1) ?? "";
    throw new Error(`The new build does not start (exit ${output.code}): ${err}`);
  }
  try {
    const info = JSON.parse(text) as Partial<BuildInfo>;
    if (typeof info.version === "string") {
      return {
        version: info.version,
        commit: info.commit ?? null,
        built: info.built ?? null,
        mode: info.mode ?? "production",
        channel: info.channel ?? null,
      };
    }
  } catch {
    // An older build's one line: `PetPlay v0.0.36 (production, 2026-11-27, abc1234)`.
  }
  const line = text.match(/PetPlay (\S+) \(([^)]*)\)/);
  if (!line) {
    throw new Error(`The new build answered --version with ${JSON.stringify(text.slice(0, 120))}`);
  }
  const details = line[2]!.split(", ");
  return {
    version: line[1]!,
    commit: details.find((d) => /^[0-9a-f]{7,40}$/.test(d)) ?? null,
    built: details.find((d) => /^\d{4}-\d{2}-\d{2}/.test(d)) ?? null,
    mode: details[0] ?? "production",
  };
}

// ---------------------------------------------------------------------------------------------
// Locking: one update at a time per install directory (two PetPlays, or a CLI and the UI).

async function acquireUpdateLock(directory: string): Promise<() => void> {
  Deno.mkdirSync(directory, { recursive: true });
  const path = join(directory, ".petplay-update.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = Deno.openSync(path, { write: true, createNew: true });
      file.writeSync(new TextEncoder().encode(JSON.stringify({ pid: Deno.pid, at: Date.now() })));
      file.close();
      return () => {
        try {
          Deno.removeSync(path);
        } catch {
          // Already gone.
        }
      };
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      if (!lockIsStale(path)) {
        throw new Error("Another PetPlay update is already running.");
      }
      try {
        Deno.removeSync(path);
      } catch {
        // Someone else took it over.
      }
    }
  }
  throw new Error("Another PetPlay update is already running.");
}

function lockIsStale(path: string): boolean {
  try {
    const { pid, at } = JSON.parse(Deno.readTextFileSync(path)) as { pid?: number; at?: number };
    if (typeof at !== "number" || Date.now() - at > STALE_LOCK_MS) return true;
    if (Deno.build.os === "linux" && typeof pid === "number") return !exists(`/proc/${pid}`);
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Downloads

/** Parses standard `sha256sum` output (`<64-hex>  <filename>`) for `assetName`. */
export function parseSha256Sums(content: string, assetName: string): string | null {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!match) continue;
    const [, hash, file] = match;
    const base = file!.split(/[\\/]/).pop() ?? file;
    if (file === assetName || base === assetName) {
      return hash!.toLowerCase();
    }
  }
  return null;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const block of readFileBlocks(path)) hash.update(block);
  return hash.digest("hex");
}

function sha256Text(text: string): string {
  return createHash("sha256").update(new TextEncoder().encode(text)).digest("hex");
}

async function withRetries<T>(what: string, run: (attempt: number) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      return await run(attempt);
    } catch (error) {
      lastError = error;
      if (error instanceof PermanentDownloadError) throw error;
      await new Promise((r) => setTimeout(r, Math.min(15_000, 1000 * 3 ** attempt)));
    }
  }
  throw new Error(`${what} failed after ${DOWNLOAD_ATTEMPTS} attempts: ${message(lastError)}`);
}

class PermanentDownloadError extends Error {}

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string> {
  return await withRetries(`Fetching ${url}`, async () => {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": userAgent() },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404) {
      await res.body?.cancel();
      throw new PermanentDownloadError(`${url} not found`);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  });
}

/** Reads a response body, aborting when no bytes arrive for {@link IDLE_TIMEOUT_MS}. */
async function readBody(
  res: Response,
  controller: AbortController,
  onBytes: (bytes: Uint8Array) => Promise<void>,
): Promise<void> {
  if (!res.body) throw new Error("empty response");
  const reader = res.body.getReader();
  let timer = setTimeout(() => controller.abort(new Error("download stalled")), IDLE_TIMEOUT_MS);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      clearTimeout(timer);
      if (done) return;
      timer = setTimeout(() => controller.abort(new Error("download stalled")), IDLE_TIMEOUT_MS);
      if (value && value.byteLength > 0) await onBytes(value);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) offset += await file.write(bytes.subarray(offset));
}

/** Downloads `url` into `path`, resuming with `Range` after a dropped connection. */
async function downloadFull(
  url: string,
  path: string,
  size: number,
  fetchImpl: typeof fetch,
  onReceived: (bytes: number) => void,
): Promise<void> {
  const file = await Deno.open(path, { write: true, create: true, truncate: true });
  let received = 0;
  try {
    await withRetries(`Downloading ${url}`, async () => {
      const controller = new AbortController();
      const headers: Record<string, string> = { "User-Agent": userAgent() };
      if (received > 0) headers["Range"] = `bytes=${received}-`;
      const res = await fetchImpl(url, { headers, signal: controller.signal });
      if (res.status === 404) throw new PermanentDownloadError(`${url} not found`);
      if (received > 0 && res.status === 200) {
        // The server ignored Range: start this file over.
        received = 0;
        await file.truncate(0);
        await file.seek(0, Deno.SeekMode.Start);
      } else if (!(res.ok)) {
        await res.body?.cancel();
        throw new Error(`HTTP ${res.status}`);
      }
      await readBody(res, controller, async (bytes) => {
        await writeAll(file, bytes);
        received += bytes.byteLength;
        onReceived(received);
      });
      if (received !== size) throw new Error(`got ${received} of ${size} bytes`);
    });
  } finally {
    file.close();
  }
}

/** Builds `path` from local chunks plus `Range` fetches of the missing ones. */
async function assembleDelta(
  index: ChunkIndex,
  plan: ReturnType<typeof planDelta>,
  path: string,
  url: string,
  fetchImpl: typeof fetch,
  onReceived: (bytes: number) => void,
): Promise<void> {
  const out = await Deno.open(path, { write: true, create: true, truncate: true });
  try {
    await out.truncate(index.size);
    const handles = new Map<string, Deno.FsFile>();
    try {
      const buffer = new Uint8Array(256 * 1024);
      for (let i = 0; i < plan.sources.length; i++) {
        const source = plan.sources[i];
        if (!source) continue;
        let handle = handles.get(source.path);
        if (!handle) {
          handle = await Deno.open(source.path, { read: true });
          handles.set(source.path, handle);
        }
        await handle.seek(source.offset, Deno.SeekMode.Start);
        const view = buffer.subarray(0, source.length);
        let filled = 0;
        while (filled < source.length) {
          const n = await handle.read(view.subarray(filled));
          if (n == null || n === 0) throw new Error(`${source.path} shrank while updating`);
          filled += n;
        }
        await out.seek(plan.offsets[i]!, Deno.SeekMode.Start);
        await writeAll(out, view);
      }
    } finally {
      for (const handle of handles.values()) handle.close();
    }
  } finally {
    out.close();
  }

  let received = 0;
  const queue = [...plan.ranges];
  const worker = async () => {
    const file = await Deno.open(path, { write: true });
    try {
      for (let range = queue.shift(); range; range = queue.shift()) {
        await fetchRange(url, range, file, fetchImpl, (n) => {
          received += n;
          onReceived(received);
        });
      }
    } finally {
      file.close();
    }
  };
  await Promise.all(Array.from({ length: Math.min(RANGE_CONCURRENCY, queue.length) }, worker));
}

async function fetchRange(
  url: string,
  range: FetchRange,
  file: Deno.FsFile,
  fetchImpl: typeof fetch,
  onBytes: (count: number) => void,
): Promise<void> {
  let position = range.start;
  await withRetries(`Fetching bytes ${range.start}-${range.end} of ${url}`, async () => {
    const controller = new AbortController();
    const res = await fetchImpl(url, {
      headers: { "User-Agent": userAgent(), "Range": `bytes=${position}-${range.end - 1}` },
      signal: controller.signal,
    });
    if (res.status !== 206) {
      await res.body?.cancel();
      if (res.status === 200) throw new PermanentDownloadError("server ignores Range requests");
      throw new Error(`HTTP ${res.status}`);
    }
    const contentRange = res.headers.get("content-range") ?? "";
    if (!contentRange.startsWith(`bytes ${position}-`)) {
      await res.body?.cancel();
      throw new PermanentDownloadError(`unexpected Content-Range ${contentRange}`);
    }
    await file.seek(position, Deno.SeekMode.Start);
    await readBody(res, controller, async (bytes) => {
      const room = range.end - position;
      const slice = bytes.byteLength > room ? bytes.subarray(0, room) : bytes;
      await writeAll(file, slice);
      position += slice.byteLength;
      onBytes(slice.byteLength);
    });
    if (position !== range.end) throw new Error(`range ended at ${position}, wanted ${range.end}`);
  });
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
