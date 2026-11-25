/**
 * In-program GitHub Releases updater for PetPlay.
 *
 * Checks `goodpuppies/petplay` latest release, compares against the running version,
 * downloads the platform binary (`petplay`, `petplay-aarch64`, or `petplay.exe`),
 * verifies its SHA-256 against the release's `SHA256SUMS` asset when present, and
 * atomically swaps the executable in place (Linux `rename`; Windows move-aside + `rename`).
 */
import { join } from "@std/path";
import { installDir, installedExecutablePath } from "./appPaths.ts";
import { getBuildInfo } from "./buildInfo.ts";
import { installState, replaceExecutable } from "./install.ts";

const DEFAULT_RELEASE_REPO = "goodpuppies/petplay";

export type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

export type GitHubRelease = {
  tag_name: string;
  name?: string;
  html_url: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: ReleaseAsset[];
};

export type UpdateCheckResult = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  canApply: boolean;
  releaseUrl: string;
  publishedAt: string | null;
  assetName: string | null;
  assetUrl: string | null;
  assetSize: number | null;
  checksumUrl: string | null;
};

export type UpdateProgress = {
  phase: "downloading" | "verifying" | "installing";
  receivedBytes: number;
  totalBytes: number | null;
};

export type UpdateApplyResult = {
  updatedTo: string;
  targetPath: string;
  verifiedSha256: boolean;
};

export function releaseRepo(): string {
  return Deno.env.get("PETPLAY_UPDATE_REPO") || DEFAULT_RELEASE_REPO;
}

/** Matches `.github/workflows/release.yml` asset naming. */
export function releaseAssetName(
  os: string = Deno.build.os,
  arch: string = Deno.build.arch,
): string | null {
  if (os === "windows" && arch === "x86_64") return "petplay.exe";
  if (os === "linux" && arch === "x86_64") return "petplay";
  if (os === "linux" && arch === "aarch64") return "petplay-aarch64";
  return null;
}

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

/** Parses standard `sha256sum` output (`<64-hex>  <filename>`) for `assetName`. */
export function parseSha256Sums(content: string, assetName: string): string | null {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!match) continue;
    const [, hash, file] = match;
    const base = file.split(/[\\/]/).pop() ?? file;
    if (file === assetName || base === assetName) {
      return hash.toLowerCase();
    }
  }
  return null;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

export async function sha256File(path: string): Promise<string> {
  const bytes = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

export async function checkForUpdate(
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateCheckResult> {
  const build = getBuildInfo();
  const repo = releaseRepo();
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": `PetPlay/${build.version}`,
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub release check failed (HTTP ${res.status})`);
  }
  const release = (await res.json()) as GitHubRelease;
  const assetName = releaseAssetName();
  const asset = assetName
    ? release.assets.find((a) => a.name === assetName) ?? null
    : null;
  const checksumAsset = release.assets.find((a) => a.name === "SHA256SUMS") ?? null;

  return {
    currentVersion: build.version,
    latestVersion: release.tag_name,
    updateAvailable: isNewerRelease(build.version, release.tag_name),
    canApply: Deno.build.standalone && asset != null,
    releaseUrl: release.html_url,
    publishedAt: release.published_at ?? null,
    assetName,
    assetUrl: asset?.browser_download_url ?? null,
    assetSize: asset?.size ?? null,
    checksumUrl: checksumAsset?.browser_download_url ?? null,
  };
}

export async function downloadAndApplyUpdate(
  check: UpdateCheckResult,
  onProgress?: (progress: UpdateProgress) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateApplyResult> {
  if (!Deno.build.standalone) {
    throw new Error("In-app updates only apply to release builds (use git pull in a checkout).");
  }
  if (!check.assetUrl || !check.assetName) {
    throw new Error(`No release asset available for ${Deno.build.os}/${Deno.build.arch}.`);
  }

  const inst = installState();
  const targetPath = inst.installed ? installedExecutablePath() : Deno.execPath();
  const downloadPath = `${targetPath}.download`;

  onProgress?.({ phase: "downloading", receivedBytes: 0, totalBytes: check.assetSize });

  try {
    const res = await fetchImpl(check.assetUrl, {
      headers: { "User-Agent": `PetPlay/${check.currentVersion}` },
    });
    if (!res.ok || !res.body) {
      throw new Error(`Failed to download ${check.assetName} (HTTP ${res.status})`);
    }
    const contentLength = Number(res.headers.get("content-length") ?? "");
    const totalBytes = Number.isFinite(contentLength) && contentLength > 0
      ? contentLength
      : check.assetSize;

    const file = await Deno.open(downloadPath, { write: true, create: true, truncate: true });
    let receivedBytes = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          let offset = 0;
          while (offset < value.byteLength) {
            offset += await file.write(value.subarray(offset));
          }
          receivedBytes += value.byteLength;
          onProgress?.({ phase: "downloading", receivedBytes, totalBytes });
        }
      }
    } finally {
      file.close();
    }

    let verifiedSha256 = false;
    if (check.checksumUrl) {
      onProgress?.({ phase: "verifying", receivedBytes, totalBytes });
      const sumRes = await fetchImpl(check.checksumUrl, {
        headers: { "User-Agent": `PetPlay/${check.currentVersion}` },
      });
      if (!sumRes.ok) {
        throw new Error(`Failed to fetch SHA256SUMS (HTTP ${sumRes.status})`);
      }
      const expected = parseSha256Sums(await sumRes.text(), check.assetName);
      if (expected) {
        const actual = await sha256File(downloadPath);
        if (actual !== expected) {
          throw new Error(
            `SHA-256 mismatch for ${check.assetName} (expected ${expected.slice(0, 12)}, got ${
              actual.slice(0, 12)
            })`,
          );
        }
        verifiedSha256 = true;
      }
    }

    onProgress?.({ phase: "installing", receivedBytes, totalBytes });
    replaceExecutable(downloadPath, targetPath);

    if (inst.installed) {
      try {
        Deno.writeTextFileSync(
          join(installDir(), "install.json"),
          JSON.stringify(
            {
              version: check.latestVersion,
              commit: null,
              built: check.publishedAt,
              mode: "production",
              installedAt: new Date().toISOString(),
              from: check.releaseUrl,
            },
            null,
            2,
          ) + "\n",
        );
      } catch {
        // Non-fatal: binary is already updated.
      }
    }

    return {
      updatedTo: check.latestVersion,
      targetPath,
      verifiedSha256,
    };
  } finally {
    try {
      await Deno.remove(downloadPath);
    } catch {
      // Already cleaned up or moved.
    }
  }
}
