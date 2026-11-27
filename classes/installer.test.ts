import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createHash } from "node:crypto";
import {
  branchCandidates,
  type BuildCandidate,
  buildChannel,
  classifyCandidate,
  effectiveChannel,
  type GitHubRelease,
  isNewerRelease,
  parseChannel,
  parseSha256Sums,
  parseVersionTag,
  releaseAssetName,
} from "./updater.ts";
import { previousExecutablePath } from "./install.ts";
import { install, rollback, uninstall, update } from "./installer.ts";
import {
  branchBuildTag,
  branchSlug,
  formatBuildMetadata,
  parseBuildMetadata,
} from "./branchBuild.ts";
import { chunkIndexAssetName } from "./updater.ts";
import { indexFile } from "./updateChunks.ts";
import type { BuildInfo } from "./buildInfo.ts";

Deno.test("parseVersionTag handles release tags and git describe versions", () => {
  assertEquals(parseVersionTag("v0.0.17"), { major: 0, minor: 0, patch: 17, commitsAhead: 0 });
  assertEquals(parseVersionTag("0.1.2-9-g777e0e3"), {
    major: 0,
    minor: 1,
    patch: 2,
    commitsAhead: 9,
  });
  assertEquals(parseVersionTag("v0.0.17-3-gabcdef1-dirty"), {
    major: 0,
    minor: 0,
    patch: 17,
    commitsAhead: 3,
  });
  assertEquals(parseVersionTag("dev"), null);
});

Deno.test("isNewerRelease compares semver and commitsAhead accurately", () => {
  assertEquals(isNewerRelease("v0.0.17", "v0.0.18"), true);
  assertEquals(isNewerRelease("v0.0.17", "v0.0.17"), false);
  assertEquals(isNewerRelease("v0.0.18", "v0.0.17"), false);
  assertEquals(isNewerRelease("v0.0.17-5-gabc1234", "v0.0.17"), false);
  assertEquals(isNewerRelease("v0.0.17-5-gabc1234", "v0.0.18"), true);
  assertEquals(isNewerRelease("v0.9.9", "v1.0.0"), true);
});

Deno.test("parseSha256Sums extracts matching hash for platform asset", () => {
  const sums = [
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  petplay",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  petplay.exe",
    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc *dist/petplay-aarch64",
  ].join("\n");
  assertEquals(parseSha256Sums(sums, "petplay"), "a".repeat(64));
  assertEquals(parseSha256Sums(sums, "petplay.exe"), "b".repeat(64));
  assertEquals(parseSha256Sums(sums, "petplay-aarch64"), "c".repeat(64));
  assertEquals(parseSha256Sums(sums, "missing"), null);
});

Deno.test("releaseAssetName maps supported OS/arch targets", () => {
  assertEquals(releaseAssetName("linux", "x86_64"), "petplay");
  assertEquals(releaseAssetName("linux", "aarch64"), "petplay-aarch64");
  assertEquals(releaseAssetName("windows", "x86_64"), "petplay.exe");
  assertEquals(releaseAssetName("darwin", "aarch64"), null);
});

Deno.test("channels parse as stable or owner/repo#branch", () => {
  assertEquals(parseChannel("stable")?.branch, null);
  assertEquals(parseChannel("Blise518B/petplay#feat/coop-sync"), {
    id: "Blise518B/petplay#feat/coop-sync",
    repo: "Blise518B/petplay",
    branch: "feat/coop-sync",
  });
  assertEquals(parseChannel("petplay#main"), null);
  assertEquals(parseChannel("a/b#"), null);
  assertEquals(parseChannel("a/b#has space"), null);
});

const build = (over: Partial<BuildInfo>): BuildInfo => ({
  version: "v0.0.36",
  commit: "1111111111111111111111111111111111111111",
  built: "2026-11-27T21:00:00Z",
  mode: "production",
  ...over,
});

Deno.test("a build follows its own channel; release tags count as stable", () => {
  assertEquals(buildChannel(build({})), "stable");
  assertEquals(buildChannel(build({ version: "v0.0.36-2-gabcdef1" })), null);
  assertEquals(buildChannel(build({ channel: "a/b#x" })), "a/b#x");
  assertEquals(effectiveChannel(null, build({ channel: "a/b#x" })), "a/b#x");
  assertEquals(effectiveChannel("stable", build({ channel: "a/b#x" })), "stable");
  assertEquals(effectiveChannel(null, build({ version: "dev" })), "stable");
});

function release(over: Partial<GitHubRelease> & { tag_name: string }): GitHubRelease {
  return {
    html_url: `https://example.test/${over.tag_name}`,
    assets: [
      { name: "petplay", browser_download_url: "u/petplay", size: 10 },
      { name: "SHA256SUMS", browser_download_url: "u/sums", size: 1 },
    ],
    ...over,
  };
}

Deno.test("branch builds: newest complete build per branch; drafts and partial uploads skipped", () => {
  const meta = (branch: string, commit: string) =>
    `Built by CI.\n\n${formatBuildMetadata({ branch, commit, version: "abc" })}`;
  const releases: GitHubRelease[] = [
    release({
      tag_name: "build-main-aaaaaaa",
      body: meta("main", "a".repeat(40)),
      published_at: "2026-11-27T10:00:00Z",
      prerelease: true,
    }),
    release({
      tag_name: "build-main-bbbbbbb",
      body: meta("main", "b".repeat(40)),
      published_at: "2026-11-27T12:00:00Z",
      prerelease: true,
    }),
    release({
      tag_name: "build-main-ccccccc",
      body: meta("main", "c".repeat(40)),
      published_at: "2026-11-27T13:00:00Z",
      draft: true,
    }),
    release({
      tag_name: "build-feat-x-ddddddd",
      body: meta("feat/x", "d".repeat(40)),
      published_at: "2026-11-27T14:00:00Z",
      assets: [{ name: "petplay", browser_download_url: "u", size: 1 }],
    }),
    release({
      tag_name: "build-feat-x-eeeeeee",
      body: meta("feat/x", "e".repeat(40)),
      published_at: "2026-11-27T09:00:00Z",
    }),
    release({ tag_name: "v0.0.36", body: "notes" }),
  ];
  const found = branchCandidates("o/petplay", releases, "petplay");
  assertEquals(found.map((c) => [c.channel, c.commit?.[0]]), [
    ["o/petplay#main", "b"],
    ["o/petplay#feat/x", "e"],
  ]);
  assertEquals(parseBuildMetadata("no metadata"), null);
});

Deno.test("branch build tags are tag-safe; metadata keeps the exact branch", () => {
  assertEquals(branchSlug("feat/Coop Sync!"), "feat-coop-sync");
  assertEquals(branchSlug("///"), "branch");
  assertEquals(branchBuildTag("feat/x", "abcdef1234"), "build-feat-x-abcdef1");
  const body = `notes\n${formatBuildMetadata({ branch: "feat/x", commit: "abc", run: "u" })}\n`;
  assertEquals(parseBuildMetadata(body), {
    branch: "feat/x",
    commit: "abc",
    version: undefined,
    run: "u",
  });
});

Deno.test("classifyCandidate: update on own channel, switch across channels", () => {
  const candidate = (over: Partial<BuildCandidate>): BuildCandidate => ({
    channel: "stable",
    repo: "o/r",
    branch: null,
    tag: "v0.0.37",
    version: "v0.0.37",
    commit: null,
    publishedAt: null,
    releaseUrl: "",
    runUrl: null,
    binary: { name: "petplay", browser_download_url: "", size: 1 },
    chunks: null,
    sums: { name: "SHA256SUMS", browser_download_url: "", size: 1 },
    ...over,
  });
  assertEquals(classifyCandidate(build({}), "stable", candidate({})), "update");
  assertEquals(classifyCandidate(build({}), "stable", candidate({ tag: "v0.0.36" })), "up-to-date");
  assertEquals(classifyCandidate(build({}), "stable", candidate({ tag: "v0.0.35" })), "up-to-date");
  assertEquals(classifyCandidate(build({}), "stable", null), "unavailable");
  const branch = candidate({
    channel: "o/r#x",
    branch: "x",
    tag: "build-x-2222222",
    commit: "2".repeat(40),
  });
  assertEquals(classifyCandidate(build({}), "o/r#x", branch), "switch");
  assertEquals(classifyCandidate(build({ channel: "o/r#x" }), "o/r#x", branch), "update");
  assertEquals(
    classifyCandidate(build({ channel: "o/r#x", commit: "2".repeat(40) }), "o/r#x", branch),
    "up-to-date",
  );
  // Back to stable from a branch build: offered even when the tag is older.
  assertEquals(
    classifyCandidate(
      build({ channel: "o/r#x", version: "abc1234" }),
      "stable",
      candidate({ tag: "v0.0.30" }),
    ),
    "switch",
  );
});

// ---------------------------------------------------------------------------------------------
// End to end: a local "release" server with Range support, delta and full paths.

function pseudoRandom(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

type ServedRelease = {
  url: string;
  candidate: BuildCandidate;
  stats: { rangeBytes: number; fullBytes: number; requests: number };
  close: () => Promise<void>;
};

async function serveRelease(
  binary: Uint8Array,
  options: { chunks: boolean; ignoreRange?: boolean },
): Promise<ServedRelease> {
  const dir = await Deno.makeTempDir();
  const binaryPath = join(dir, "petplay");
  await Deno.writeFile(binaryPath, binary);
  const files = new Map<string, Uint8Array<ArrayBuffer>>([[
    "petplay",
    binary as Uint8Array<ArrayBuffer>,
  ]]);
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  let sums = `${sha(binary)}  petplay\n`;
  if (options.chunks) {
    const index = new TextEncoder().encode(JSON.stringify(await indexFile(binaryPath)));
    files.set(chunkIndexAssetName("petplay"), index);
    sums += `${sha(index)}  ${chunkIndexAssetName("petplay")}\n`;
  }
  files.set("SHA256SUMS", new TextEncoder().encode(sums));
  await Deno.remove(dir, { recursive: true });
  const stats = { rangeBytes: 0, fullBytes: 0, requests: 0 };
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, (req) => {
    stats.requests++;
    const name = new URL(req.url).pathname.slice(1);
    const body = files.get(name);
    if (!body) return new Response("missing", { status: 404 });
    const range = req.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
    if (range && !options.ignoreRange) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) + 1 : body.length;
      stats.rangeBytes += end - start;
      return new Response(body.slice(start, end), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end - 1}/${body.length}` },
      });
    }
    if (name === "petplay") stats.fullBytes += body.length;
    return new Response(body as Uint8Array<ArrayBuffer>);
  });
  const url = `http://127.0.0.1:${server.addr.port}`;
  const asset = (name: string) => ({
    name,
    browser_download_url: `${url}/${name}`,
    size: files.get(name)!.length,
  });
  return {
    url,
    stats,
    close: () => server.shutdown(),
    candidate: {
      channel: "o/r#x",
      repo: "o/r",
      branch: "x",
      tag: "build-x-2222222",
      version: "test-build",
      commit: "2".repeat(40),
      publishedAt: null,
      releaseUrl: `${url}/release`,
      runUrl: null,
      binary: asset("petplay"),
      chunks: options.chunks ? asset(chunkIndexAssetName("petplay")) : null,
      sums: asset("SHA256SUMS"),
    },
  };
}

/** Old build and a new one that differs in a few places, like two consecutive releases. */
function twoBuilds(): { oldBuild: Uint8Array; newBuild: Uint8Array } {
  const oldBuild = pseudoRandom(6 * 1024 * 1024, 7);
  const newBuild = new Uint8Array(oldBuild.length + 1000);
  newBuild.set(oldBuild.subarray(0, 2_000_000));
  newBuild.set(pseudoRandom(1000, 99), 2_000_000);
  newBuild.set(oldBuild.subarray(2_000_000), 2_001_000);
  newBuild.set(pseudoRandom(50_000, 5), 5_000_000);
  return { oldBuild, newBuild };
}

Deno.test("update fetches only missing chunks, keeps the previous build, and rolls back", async () => {
  const { oldBuild, newBuild } = twoBuilds();
  const served = await serveRelease(newBuild, { chunks: true });
  const dir = await Deno.makeTempDir();
  try {
    const target = join(dir, "petplay");
    await Deno.writeFile(target, oldBuild);
    const phases = new Set<string>();
    const result = await update(served.candidate, {
      register: false,
      targetPath: target,
      skipSmokeTest: true,
      onProgress: (p: { phase: string }) => phases.add(p.phase),
    });
    assertEquals(result.mode, "delta");
    assertEquals(await Deno.readFile(target), newBuild);
    assert(served.stats.fullBytes === 0, "no full download");
    assert(served.stats.rangeBytes < newBuild.length / 4, `fetched ${served.stats.rangeBytes}`);
    assert(phases.has("indexing") && phases.has("verifying") && phases.has("installing"));
    assertEquals(await Deno.readFile(previousExecutablePath(target)), oldBuild);
    assertEquals([...Deno.readDirSync(dir)].map((e) => e.name).sort(), [
      "petplay",
      "petplay.previous",
    ]);

    await rollback({ targetPath: target, skipSmokeTest: true, register: false });
    assertEquals(await Deno.readFile(target), oldBuild);
    assertEquals(await Deno.readFile(previousExecutablePath(target)), newBuild);
  } finally {
    await served.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update falls back to a full download without an index or Range support", async () => {
  const { oldBuild, newBuild } = twoBuilds();
  for (const options of [{ chunks: false }, { chunks: true, ignoreRange: true }]) {
    const served = await serveRelease(newBuild, options);
    const dir = await Deno.makeTempDir();
    try {
      const target = join(dir, "petplay");
      await Deno.writeFile(target, oldBuild);
      const result = await update(served.candidate, {
        register: false,
        targetPath: target,
        skipSmokeTest: true,
      });
      assertEquals(result.mode, "full");
      assertEquals(await Deno.readFile(target), newBuild);
    } finally {
      await served.close();
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("update refuses a binary whose SHA-256 does not match and leaves the old one", async () => {
  const { oldBuild, newBuild } = twoBuilds();
  const served = await serveRelease(newBuild, { chunks: false });
  const dir = await Deno.makeTempDir();
  try {
    const target = join(dir, "petplay");
    await Deno.writeFile(target, oldBuild);
    const tampered = { ...served.candidate, binary: { ...served.candidate.binary } };
    // Point the binary at the sums file: right name in SHA256SUMS, wrong bytes.
    tampered.binary.browser_download_url = served.candidate.sums.browser_download_url;
    tampered.binary.size = served.candidate.sums.size;
    await assertRejects(
      () => update(tampered, { register: false, targetPath: target, skipSmokeTest: true }),
      Error,
      "SHA-256 mismatch",
    );
    assertEquals(await Deno.readFile(target), oldBuild);
    assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), ["petplay"]);
  } finally {
    await served.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("only one update runs per install directory", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const lock = join(dir, ".petplay-update.lock");
    // A live lock (this process holds it).
    await Deno.writeTextFile(lock, JSON.stringify({ pid: Deno.pid, at: Date.now() }));
    const { newBuild } = twoBuilds();
    const served = await serveRelease(newBuild, { chunks: false });
    try {
      await assertRejects(
        () =>
          update(served.candidate, {
            register: false,
            targetPath: join(dir, "petplay"),
            skipSmokeTest: true,
          }),
        Error,
        "already running",
      );
      // A stale one (its process is gone) is taken over.
      await Deno.writeTextFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
      if (Deno.build.os === "linux") {
        await update(served.candidate, {
          register: false,
          targetPath: join(dir, "petplay"),
          skipSmokeTest: true,
        });
        assertEquals(await Deno.readFile(join(dir, "petplay")), newBuild);
      }
    } finally {
      await served.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install, update, rollback and uninstall share one backend: staged swap, kept previous, lock", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const target = join(dir, "bin", "petplay");
    // Installing copies the running executable (here: deno itself) through the same staging swap.
    const installed = await install({ targetPath: target, register: false });
    assertEquals(installed.action, "install");
    assertEquals(installed.mode, "copy");
    assertEquals(Deno.statSync(target).size, Deno.statSync(Deno.execPath()).size);
    assertEquals(installed.previousPath, null);
    assertEquals([...Deno.readDirSync(join(dir, "bin"))].map((e) => e.name), ["petplay"]);

    const { newBuild } = twoBuilds();
    const served = await serveRelease(newBuild, { chunks: true });
    try {
      const updated = await update(served.candidate, {
        targetPath: target,
        register: false,
        skipSmokeTest: true,
      });
      assertEquals(updated.restartNeeded, true);
      assertEquals(await Deno.readFile(target), newBuild);
      assertEquals(
        Deno.statSync(previousExecutablePath(target)).size,
        Deno.statSync(Deno.execPath()).size,
      );
    } finally {
      await served.close();
    }
    // Installing again over the update keeps the update as the previous build: rollback-able.
    const reinstalled = await install({ targetPath: target, register: false });
    assertEquals(reinstalled.previousPath, previousExecutablePath(target));
    assertEquals(await Deno.readFile(previousExecutablePath(target)), newBuild);

    const removed = await uninstall({ targetPath: target, register: false });
    assertEquals(removed.installed, null);
    let left: string[] = [];
    try {
      left = [...Deno.readDirSync(join(dir, "bin"))].map((e) => e.name);
    } catch {
      // The directory itself is gone.
    }
    assertEquals(left, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
