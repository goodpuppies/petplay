/**
 * Publishes a CI branch build as a GitHub prerelease the in-app updater can follow
 * (`.github/workflows/branch-build.yml`), in whatever repository CI runs: `goodpuppies/petplay`
 * or a contributor's fork. Needs `gh` and `GH_TOKEN` with `contents: write`.
 *
 *   deno run -A --no-config utils/publish-branch-build.ts publish <dir> <file>...
 *   deno run -A --no-config utils/publish-branch-build.ts delete-branch <branch>
 *
 * `publish` creates the release as a draft, uploads every file, and only then publishes it, so the
 * updater (which never sees drafts) never offers a half-uploaded build. It then deletes that
 * branch's older builds except the newest {@link KEEP}, so an update already downloading the one
 * before keeps working. `delete-branch` removes every build of a deleted branch.
 */
import {
  BRANCH_BUILD_TAG_PREFIX,
  type BranchBuildMetadata,
  branchBuildTag,
  formatBuildMetadata,
  parseBuildMetadata,
} from "../classes/branchBuild.ts";

const KEEP = 2;

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function gh(args: string[], options: { allowFailure?: boolean } = {}): Promise<string> {
  const output = await new Deno.Command("gh", { args, stdout: "piped", stderr: "piped" }).output();
  const text = new TextDecoder().decode(output.stdout);
  if (!output.success && !options.allowFailure) {
    throw new Error(
      `gh ${args.slice(0, 3).join(" ")} failed: ${new TextDecoder().decode(output.stderr)}`,
    );
  }
  return output.success ? text : "";
}

type Release = { tag_name: string; body: string | null; draft: boolean; created_at: string };

async function branchReleases(repo: string, branch: string): Promise<Release[]> {
  const lines = await gh([
    "api",
    `repos/${repo}/releases?per_page=100`,
    "--paginate",
    "--jq",
    ".[] | @json",
  ]);
  return lines.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Release).filter((r) =>
    r.tag_name.startsWith(BRANCH_BUILD_TAG_PREFIX) && parseBuildMetadata(r.body)?.branch === branch
  ).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function deleteRelease(repo: string, tag: string): Promise<void> {
  await gh(["release", "delete", tag, "--repo", repo, "--cleanup-tag", "--yes"], {
    allowFailure: true,
  });
  console.log(`deleted ${tag}`);
}

/** The version the Linux binary reports, else `git describe`. */
async function buildVersion(dir: string, commit: string): Promise<string> {
  try {
    const output = await new Deno.Command(`${dir}/petplay`, {
      args: ["--version", "--json"],
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(60_000),
    }).output();
    const info = JSON.parse(new TextDecoder().decode(output.stdout)) as { version?: string };
    if (info.version) return info.version;
  } catch {
    // Not runnable here.
  }
  const describe = await new Deno.Command("git", {
    args: ["describe", "--tags", "--always", "--match", "v[0-9]*"],
    stdout: "piped",
    stderr: "null",
  }).output();
  return new TextDecoder().decode(describe.stdout).trim() || commit.slice(0, 7);
}

async function publish(dir: string, files: string[]): Promise<void> {
  const repo = env("GITHUB_REPOSITORY");
  const branch = env("GITHUB_REF_NAME");
  const commit = env("GITHUB_SHA");
  const run = `${env("GITHUB_SERVER_URL")}/${repo}/actions/runs/${env("GITHUB_RUN_ID")}`;
  const tag = branchBuildTag(branch, commit);
  const metadata: BranchBuildMetadata = {
    branch,
    commit,
    version: await buildVersion(dir, commit),
    run,
  };
  const channel = `${repo}#${branch}`;
  const notes = [
    `Branch build of \`${branch}\` at ${commit}, from [this CI run](${run}).`,
    "",
    "Not a release. To test it, pick the channel in PetPlay (Settings → Install → Update Channel)",
    "or run:",
    "",
    "```",
    `petplay --update --channel=${channel}`,
    "```",
    "",
    "`petplay --update --channel=stable` goes back to the latest release.",
    "",
    formatBuildMetadata(metadata),
  ].join("\n");

  // A re-run of the same commit replaces its release.
  await deleteRelease(repo, tag);
  await gh([
    "release",
    "create",
    tag,
    "--repo",
    repo,
    "--target",
    commit,
    "--title",
    `${branch} @ ${commit.slice(0, 7)}`,
    "--notes",
    notes,
    "--prerelease",
    "--draft",
    ...files.map((file) => `${dir}/${file}`),
  ]);
  await gh([
    "release",
    "edit",
    tag,
    "--repo",
    repo,
    "--draft=false",
    "--prerelease",
    "--latest=false",
  ]);
  console.log(`published ${tag} (${channel}, ${metadata.version})`);

  const older = (await branchReleases(repo, branch)).filter((r) => r.tag_name !== tag);
  // Drafts are uploads a cancelled run left behind.
  for (const release of older.filter((r) => r.draft)) await deleteRelease(repo, release.tag_name);
  for (const release of older.filter((r) => !r.draft).slice(KEEP - 1)) {
    await deleteRelease(repo, release.tag_name);
  }
}

async function deleteBranch(branch: string): Promise<void> {
  const repo = env("GITHUB_REPOSITORY");
  for (const release of await branchReleases(repo, branch)) {
    await deleteRelease(repo, release.tag_name);
  }
}

const [command, ...rest] = Deno.args;
if (command === "publish" && rest.length >= 2) {
  await publish(rest[0]!, rest.slice(1));
} else if (command === "delete-branch" && rest.length === 1) {
  await deleteBranch(rest[0]!);
} else {
  console.error("usage: publish-branch-build.ts publish <dir> <file>... | delete-branch <branch>");
  Deno.exit(2);
}
