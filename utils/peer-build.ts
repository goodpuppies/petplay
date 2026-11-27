/**
 * `deno task peer-build`: put this checkout, as a full PetPlay build, on a trusted coop peer's
 * machine, without CI or a release. Builds it locally (cross-compiling for the peer's OS, with
 * natives CI already built for these commits when they are not this machine's), then sends only
 * the chunks the peer's PetPlay does not already have over the trusted link (classes/peerBuild.ts),
 * and the peer installs it with the installer backend and restarts into it.
 *
 *   deno task peer-build --peer blise                 # build for blise's OS and send
 *   deno task peer-build --peer blise --no-restart    # install, restart from their Settings
 *   deno task peer-build --peer blise --binary dist/petplay.exe   # send an existing build
 *
 * Function-body edits are faster with `deno task peer-patch --watch`; this is for everything a
 * patch cannot carry. The peer needs Settings → Install → Peer Code Patches on.
 */
import { join, resolve } from "@std/path";
import { indexFile } from "../classes/updateChunks.ts";
import { PEER_BUILD_PIECE_BYTES, type PeerBuildPlan } from "../classes/peerBuild.ts";
import type { PeerProbeReply } from "../classes/peerProbe.ts";
import type { BuildInfo } from "../classes/buildInfo.ts";
import type { InstallerResult } from "../classes/installer.ts";
import { ensureNatives } from "./natives.ts";
import { DEFAULT_REPL_PORT, peerCall, unwrap } from "./peerRepl.ts";

const root = resolve(new URL("../", import.meta.url).pathname);

type Options = {
  peer: string;
  binary?: string;
  target?: string;
  restart: boolean;
  port: number;
  rebuildWebxr: boolean;
};

function parseArgs(args: string[]): Options {
  const options: Partial<Options> = { restart: true, port: DEFAULT_REPL_PORT, rebuildWebxr: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = () => {
      const next = args[++i];
      if (next == null) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--peer") options.peer = value();
    else if (arg === "--binary") options.binary = value();
    else if (arg === "--target") options.target = value();
    else if (arg === "--no-restart") options.restart = false;
    else if (arg === "--rebuild-webxr") options.rebuildWebxr = true;
    else if (arg === "--repl-port") options.port = Number(value());
    else throw new Error(`unknown option ${arg}`);
  }
  if (!options.peer) {
    throw new Error("usage: deno task peer-build --peer NAME [--binary PATH] [--no-restart]");
  }
  return options as Options;
}

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, () => false);
}

/** `deno task build` for `target`, reusing what is already built where that is safe. */
async function build(
  target: string,
  options: Options,
): Promise<{ binary: string; info: BuildInfo }> {
  const local = target === Deno.build.target;
  const env: Record<string, string> = {};
  if (!local) {
    // cargo cannot cross-link these here; use the ones CI built from the same commits.
    const from = await ensureNatives(target, ["goodpuppies/petplay"]);
    console.log(`natives for ${target}: ${from}`);
    env.PETPLAY_PREBUILT_CAPTURE_HELPER = "1";
    env.PETPLAY_PREBUILT_MEDIA_HELPER = "1";
    if (target.startsWith("aarch64")) env.PETPLAY_PREBUILT_RAYLIB = "1";
  }
  // Natives for this machine rebuild incrementally (cargo is quick when nothing changed).
  const webxrBundle = join(
    root,
    "submodules/threewebxrwebgpudeno/submodules/iwer/packages/iwer/build/iwer.module.js",
  );
  if (!options.rebuildWebxr && await exists(webxrBundle)) env.PETPLAY_PREBUILT_WEBXR = "1";
  const exe = target.includes("windows") ? ".exe" : "";
  const output = join(root, "dist", "peer", target, "petplay");
  console.log(`building PetPlay for ${target}…`);
  const started = performance.now();
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["task", "build", `--target=${target}`, `--output=${output}`],
    cwd: root,
    env,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) throw new Error(`build failed (${result.code})`);
  const info = JSON.parse(
    await Deno.readTextFile(join(root, "dist", "build-info.json")),
  ) as BuildInfo;
  console.log(`built ${info.version} in ${((performance.now() - started) / 1000).toFixed(0)} s`);
  return { binary: `${output}${exe}`, info };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function main(options: Options): Promise<void> {
  const probe = await peerCall<PeerProbeReply>(options.port, options.peer, "PEERPROBE");
  const remote = unwrap(probe.peer, probe.reply).probe;
  const target = options.target ?? remote.build.target;
  if (!target) throw new Error(`${probe.peer}'s PetPlay does not report its target; pass --target`);
  console.log(`${probe.peer} runs ${remote.build.version} (${target}, ${remote.build.mode})`);
  if (remote.build.mode === "checkout") {
    throw new Error(`${probe.peer} runs a checkout: they pull your branch and restart instead`);
  }

  const built = options.binary
    ? {
      binary: resolve(options.binary),
      info: {
        version: `local ${options.binary}`,
        commit: null,
        built: null,
        mode: "production",
        target,
      },
    }
    : await build(target, options);
  const index = await indexFile(built.binary);
  const id = crypto.randomUUID();
  const offer = await peerCall<({ ok: true } & PeerBuildPlan) | { ok: false; error: string }>(
    options.port,
    probe.actorId,
    "PEERBUILDOFFER",
    { id, build: { ...built.info, target }, target, index },
    120_000,
  );
  const plan = unwrap(offer.peer, offer.reply);
  console.log(
    `${offer.peer} has ${(plan.reusedBytes / 1e6).toFixed(0)} MB of it; sending ${
      (plan.fetchBytes / 1e6).toFixed(1)
    } MB`,
  );

  const file = await Deno.open(built.binary, { read: true });
  let sent = 0;
  let last = 0;
  const started = performance.now();
  try {
    for (const range of plan.ranges) {
      for (let offset = range.start; offset < range.end; offset += PEER_BUILD_PIECE_BYTES) {
        const length = Math.min(PEER_BUILD_PIECE_BYTES, range.end - offset);
        const bytes = new Uint8Array(length);
        await file.seek(offset, Deno.SeekMode.Start);
        for (let read = 0; read < length;) {
          const n = await file.read(bytes.subarray(read));
          if (n == null) throw new Error(`${built.binary} ended early`);
          read += n;
        }
        const piece = await peerCall<{ ok: boolean; error?: string }>(
          options.port,
          probe.actorId,
          "PEERBUILDDATA",
          { id, offset, data: toBase64(bytes) },
          60_000,
        );
        unwrap(piece.peer, piece.reply);
        sent += length;
        if (performance.now() - last > 1000) {
          last = performance.now();
          const rate = sent / 1e6 / ((last - started) / 1000);
          console.log(
            `  ${(sent / 1e6).toFixed(1)} / ${(plan.fetchBytes / 1e6).toFixed(1)} MB (${
              rate.toFixed(1)
            } MB/s)`,
          );
        }
      }
    }
  } catch (error) {
    await peerCall(options.port, probe.actorId, "PEERBUILDABORT", { id }).catch(() => {});
    throw error;
  } finally {
    file.close();
  }

  console.log(`sent; ${offer.peer} is checking and installing it…`);
  const commit = await peerCall<
    { ok: true; result: InstallerResult; restarting: boolean } | { ok: false; error: string }
  >(options.port, probe.actorId, "PEERBUILDCOMMIT", { id, restart: options.restart }, 300_000);
  const done = unwrap(commit.peer, commit.reply);
  for (const note of done.result.notes) console.log(`  ${note}`);
  console.log(
    done.restarting
      ? `${commit.peer}'s PetPlay is restarting into it; run deno task coop:verify once they are back`
      : `installed; ${commit.peer} restarts from Settings → Install → RESTART`,
  );
}

if (import.meta.main) {
  try {
    await main(parseArgs(Deno.args));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
