/**
 * How a CI branch build is named and described on GitHub Releases, shared by the publisher
 * (utils/publish-branch-build.ts, which runs with --no-config: keep this module import-free) and
 * the updater that reads them (classes/updater.ts).
 *
 * A branch build is a prerelease tagged `build-<branch slug>-<short sha>`. Its notes end with one
 * machine-readable comment, `<!-- petplay-build {"branch":…,"commit":…,…} -->`, which carries the
 * exact branch name (slugs are lossy) and commit.
 */

export const BRANCH_BUILD_TAG_PREFIX = "build-";

export type BranchBuildMetadata = {
  branch: string;
  commit: string;
  version?: string;
  /** The CI run that built it. */
  run?: string;
};

const METADATA_PATTERN = /<!--\s*petplay-build\s+(\{.*?\})\s*-->/s;

export function branchSlug(branch: string): string {
  const slug = branch.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return slug.slice(0, 48).replace(/[-.]+$/, "") || "branch";
}

export function branchBuildTag(branch: string, commit: string): string {
  return `${BRANCH_BUILD_TAG_PREFIX}${branchSlug(branch)}-${commit.slice(0, 7)}`;
}

export function formatBuildMetadata(metadata: BranchBuildMetadata): string {
  return `<!-- petplay-build ${JSON.stringify(metadata)} -->`;
}

export function parseBuildMetadata(body: string | null | undefined): BranchBuildMetadata | null {
  const match = body?.match(METADATA_PATTERN);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]!) as Partial<BranchBuildMetadata>;
    if (typeof value.branch !== "string" || typeof value.commit !== "string") return null;
    return {
      branch: value.branch,
      commit: value.commit,
      version: typeof value.version === "string" ? value.version : undefined,
      run: typeof value.run === "string" ? value.run : undefined,
    };
  } catch {
    return null;
  }
}
