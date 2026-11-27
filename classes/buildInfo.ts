/**
 * Which PetPlay this is: the version (`git describe --tags`, e.g. `v0.0.17` or
 * `v0.0.16-9-g777e0e3` between tags), commit and build time. A release reads them from
 * `dist/build-info.json`, written by `deno task build` and embedded in the binary; a source
 * checkout asks git.
 */

export type BuildInfo = {
  version: string;
  commit: string | null;
  /** ISO time of the build; `null` for a checkout. */
  built: string | null;
  /** `production` / `development` for builds, `checkout` for source runs. */
  mode: string;
  /**
   * The update channel CI built it for (classes/updater.ts): `stable` for a release tag,
   * `owner/repo#branch` for a branch build; absent for local builds and older releases.
   */
  channel?: string | null;
};

/**
 * Version of the `--json` installer commands (classes/installerCli.ts) this build speaks. A front
 * end runs an executable for an install or update only once its `--version --json` reports it:
 * older builds start PetPlay on flags they do not know.
 */
export const INSTALLER_PROTOCOL = 1;

let cached: BuildInfo | undefined;

export function getBuildInfo(): BuildInfo {
  if (cached != null) return cached;
  if (Deno.build.standalone) {
    try {
      const info = JSON.parse(
        Deno.readTextFileSync(new URL("../dist/build-info.json", import.meta.url)),
      ) as Partial<BuildInfo>;
      cached = {
        version: info.version ?? shortCommit(info.commit) ?? "unknown",
        commit: info.commit ?? null,
        built: info.built ?? null,
        mode: info.mode ?? "unknown",
        channel: info.channel ?? null,
      };
    } catch {
      cached = { version: "unknown", commit: null, built: null, mode: "unknown" };
    }
    return cached;
  }
  cached = {
    // Release tags only: branch builds tag `build-…` too (utils/publish-branch-build.ts).
    version: git(["describe", "--tags", "--always", "--dirty", "--match", "v[0-9]*"]) ?? "dev",
    commit: git(["rev-parse", "HEAD"]),
    built: null,
    mode: "checkout",
  };
  return cached;
}

/** One line for logs and `--version`: `PetPlay v0.0.17 (production, 2026-11-12, abc1234)`. */
export function describeBuild(info = getBuildInfo()): string {
  const details = [info.mode, info.built?.slice(0, 10), shortCommit(info.commit)].filter(Boolean);
  return `PetPlay ${info.version} (${details.join(", ")})`;
}

/** Two builds are the same when they come from the same commit and build. */
export function sameBuild(a: Partial<BuildInfo>, b: Partial<BuildInfo>): boolean {
  return a.commit === b.commit && a.built === b.built && a.version === b.version;
}

function shortCommit(commit: string | null | undefined): string | null {
  return commit ? commit.slice(0, 7) : null;
}

function git(args: string[]): string | null {
  try {
    const output = new Deno.Command("git", {
      args,
      cwd: new URL("../", import.meta.url),
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    const text = new TextDecoder().decode(output.stdout).trim();
    return output.success && text !== "" ? text : null;
  } catch {
    return null;
  }
}
