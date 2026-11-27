/**
 * The native parts of a PetPlay build for one target (capture helper, media/link helper, overlay
 * presenter, ARM64 raylib), as one archive, so a machine that cannot compile them for another OS
 * can still build PetPlay for it: `deno task peer-build` cross-compiles the TypeScript for a
 * coop peer on another OS with natives CI already built.
 *
 *   deno run -A --no-config utils/natives.ts pack <target> <out-dir>     # CI, after a build
 *   deno run -A --no-config utils/natives.ts keys                        # this checkout's keys
 *
 * CI publishes `natives-<target>.tar.gz` and `natives-<target>.json` with every branch build
 * (.github/workflows/branch-build.yml). The JSON names the commits the natives were built from;
 * {@link ensureNatives} uses an archive only when those match this checkout exactly.
 * Runs with --no-config in CI: node: and relative imports only.
 */
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

export type NativeKeys = {
  screenStreamer: string;
  mediatransport: string;
  overlayPresenter: string;
};

export type NativesManifest = { target: string; keys: NativeKeys; files: string[] };

async function git(args: string[], cwd = root): Promise<{ ok: boolean; text: string }> {
  const out = await new Deno.Command("git", { args, cwd, stdout: "piped", stderr: "null" })
    .output();
  return { ok: out.success, text: new TextDecoder().decode(out.stdout).trim() };
}

/** Commit of a submodule as checked out, or `dirty:…` when it has local edits. */
async function treeKey(path: string, submodule: boolean): Promise<string> {
  const dir = join(root, path);
  if (submodule) {
    const head = await git(["rev-parse", "HEAD"], dir);
    const status = await git(["status", "--porcelain", "--untracked-files=no"], dir);
    return status.text !== "" ? `dirty:${head.text}` : head.text;
  }
  const tree = await git(["rev-parse", `HEAD:${path}`]);
  const status = await git(["status", "--porcelain", "--untracked-files=no", "--", path]);
  return status.text !== "" ? `dirty:${tree.text}` : tree.text;
}

/** What the natives are built from, in this checkout. */
export async function nativeKeys(): Promise<NativeKeys> {
  return {
    screenStreamer: await treeKey("submodules/screen-streamer", true),
    mediatransport: await treeKey("submodules/petplay_mediatransport", true),
    overlayPresenter: await treeKey("native/overlayPresenter", false),
  };
}

export function sameKeys(a: NativeKeys, b: NativeKeys): boolean {
  return !a.screenStreamer.startsWith("dirty:") && !a.mediatransport.startsWith("dirty:") &&
    !a.overlayPresenter.startsWith("dirty:") &&
    a.screenStreamer === b.screenStreamer && a.mediatransport === b.mediatransport &&
    a.overlayPresenter === b.overlayPresenter;
}

/** The repo-relative native files a build for `target` embeds. */
export function nativeFiles(target: string): string[] {
  const windows = target.includes("windows");
  const exe = windows ? ".exe" : "";
  const files = [
    `dist/native/${target}/screen-streamer${exe}`,
    `dist/native/${target}/petplay-media${exe}`,
  ];
  if (target === "aarch64-unknown-linux-gnu") {
    files.push(`dist/native/${target}/libraylib.so`);
  } else {
    files.push(
      windows
        ? "resources/petplay_overlay_presenter.dll"
        : "resources/libpetplay_overlay_presenter.so",
    );
  }
  return files;
}

function stampPath(target: string): string {
  return join(root, "dist", "native", target, "natives.json");
}

/** CI: archive the natives of `target` next to the build, with the manifest. */
async function pack(target: string, outDir: string): Promise<void> {
  const files = nativeFiles(target).filter((file) => {
    try {
      return Deno.statSync(join(root, file)).isFile;
    } catch {
      return false;
    }
  });
  const manifest: NativesManifest = { target, keys: await nativeKeys(), files };
  await Deno.mkdir(outDir, { recursive: true });
  await Deno.writeTextFile(
    join(outDir, `natives-${target}.json`),
    JSON.stringify(manifest, null, 2),
  );
  const archive = join(outDir, `natives-${target}.tar.gz`);
  const out = await new Deno.Command("tar", {
    args: ["-czf", archive, "-C", root, ...files],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!out.success) throw new Error(`tar failed (${out.code})`);
  console.log(`${archive}: ${files.join(", ")}`);
}

type Release = {
  tag_name: string;
  draft?: boolean;
  assets: Array<{ name: string; browser_download_url: string }>;
};

/**
 * Makes sure dist/native (and the presenter in resources/) hold `target`'s natives for this
 * checkout's commits: already there (stamped with matching keys), or fetched from the newest
 * published build of `repos` built from the same commits.
 * @returns where they came from, or throws when no build has them.
 */
export async function ensureNatives(target: string, repos: readonly string[]): Promise<string> {
  const keys = await nativeKeys();
  try {
    const stamp = JSON.parse(await Deno.readTextFile(stampPath(target))) as NativesManifest;
    if (
      sameKeys(keys, stamp.keys) && stamp.files.every((f) => Deno.statSync(join(root, f)).isFile)
    ) {
      return "already in dist/native";
    }
  } catch {
    // Not fetched yet.
  }
  if (Object.values(keys).some((k) => k.startsWith("dirty:"))) {
    throw new Error(
      `native sources have local edits (${
        JSON.stringify(keys)
      }); natives for ${target} must be built on ${target} or by CI`,
    );
  }
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "petplay-peer-build",
  };
  const token = Deno.env.get("PETPLAY_GITHUB_TOKEN") || Deno.env.get("GITHUB_TOKEN");
  if (token) headers["Authorization"] = `Bearer ${token}`;
  for (const repo of repos) {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=50`, {
      headers,
    });
    if (!res.ok) {
      await res.body?.cancel();
      continue;
    }
    for (const release of await res.json() as Release[]) {
      if (release.draft) continue;
      const manifestAsset = release.assets.find((a) => a.name === `natives-${target}.json`);
      const archiveAsset = release.assets.find((a) => a.name === `natives-${target}.tar.gz`);
      if (!manifestAsset || !archiveAsset) continue;
      const manifest = await (await fetch(manifestAsset.browser_download_url))
        .json() as NativesManifest;
      if (!sameKeys(keys, manifest.keys)) continue;
      const archive = join(root, "dist", `natives-${target}.tar.gz`);
      const bytes = new Uint8Array(
        await (await fetch(archiveAsset.browser_download_url)).arrayBuffer(),
      );
      await Deno.mkdir(join(root, "dist", "native", target), { recursive: true });
      await Deno.writeFile(archive, bytes);
      const out = await new Deno.Command("tar", { args: ["-xzf", archive, "-C", root] }).output();
      if (!out.success) throw new Error(`could not unpack ${archive}`);
      await Deno.writeTextFile(stampPath(target), JSON.stringify(manifest, null, 2));
      return `${repo} ${release.tag_name}`;
    }
  }
  throw new Error(
    `no published build has ${target} natives for these commits (${
      keys.screenStreamer.slice(0, 7)
    } ` +
      `${keys.mediatransport.slice(0, 7)} ${
        keys.overlayPresenter.slice(0, 7)
      }); push the branch once so CI builds them`,
  );
}

if (import.meta.main) {
  const [command, ...rest] = Deno.args;
  if (command === "pack" && rest.length === 2) await pack(rest[0]!, rest[1]!);
  else if (command === "keys") console.log(JSON.stringify(await nativeKeys(), null, 2));
  else {
    console.error("usage: natives.ts pack <target> <out-dir> | keys");
    Deno.exit(2);
  }
}
