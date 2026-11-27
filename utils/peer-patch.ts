/**
 * Live-patch trusted coop peers' running PetPlay with this checkout's edits, without a release
 * (`classes/peerPatch.ts` explains what applies and what is refused).
 *
 *   deno task peer-patch classes/environment/scene.tsx petplay/displayShare.ts
 *   deno task peer-patch --since v0.0.36           # every module changed since the peer's release
 *   deno task peer-patch --watch                   # push each saved module that type-checks
 *   deno task peer-patch --peer blise <files...>   # only peers whose display name matches
 *
 * Sends through this machine's running PetPlay (its agent REPL, `--repl-port`, default 3987), whose
 * `vrcPeers` signs nothing new: the peer checks that the patch comes from a trusted `vrcPeers`
 * actor and that its own Settings → Install → Peer Code Patches is on.
 */
import { relative, resolve } from "@std/path";
import { denoCompilerOptions, emitModule } from "../submodules/stageforge/src/lib/HotPatch.ts";
import type { PeerPatchModule, PeerPatchReply } from "../classes/peerPatch.ts";
import { summarizePeerPatch } from "../classes/peerPatch.ts";

const root = resolve(new URL("../", import.meta.url).pathname);
const WATCHED_DIRS = ["petplay", "classes", "rdp"];
const SCRIPT = /\.(ts|tsx)$/;

type Options = { files: string[]; since?: string; watch: boolean; peer?: string; port: number };

function parseArgs(args: string[]): Options {
  const options: Options = { files: [], watch: false, port: 3987 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = () => {
      const next = args[++i];
      if (next == null) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--watch") options.watch = true;
    else if (arg === "--since") options.since = value();
    else if (arg === "--peer") options.peer = value();
    else if (arg === "--repl-port") options.port = Number(value());
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else options.files.push(arg);
  }
  if (!options.watch && options.files.length === 0 && options.since == null) {
    throw new Error("usage: deno task peer-patch [--peer NAME] [--since REF | --watch | FILES...]");
  }
  return options;
}

async function git(args: string[]): Promise<string> {
  const out = await new Deno.Command("git", { args, cwd: root, stdout: "piped" }).output();
  if (!out.success) throw new Error(`git ${args.join(" ")} failed`);
  return new TextDecoder().decode(out.stdout);
}

async function changedSince(ref: string): Promise<string[]> {
  const listed = await git(["diff", "--name-only", ref, "--", ...WATCHED_DIRS]);
  return listed.split("\n").filter((path) => SCRIPT.test(path) && !path.endsWith(".test.ts"));
}

async function typeCheck(): Promise<boolean> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["task", "check"],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    console.error(new TextDecoder().decode(out.stdout).trim().split("\n").slice(-15).join("\n"));
  }
  return out.success;
}

async function emit(files: string[]): Promise<PeerPatchModule[]> {
  const compilerOptions = await denoCompilerOptions(root);
  return await Promise.all(files.map(async (file) => {
    const absolute = resolve(root, file);
    const path = relative(root, absolute).replaceAll("\\", "/");
    if (path.startsWith("..")) throw new Error(`${file} is outside the checkout`);
    return { path, source: await emitModule(absolute, compilerOptions) };
  }));
}

async function send(modules: PeerPatchModule[], options: Options): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${options.port}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      target: "vrcPeers",
      type: "SENDPEERPATCH",
      payload: { modules, ...(options.peer ? { peer: options.peer } : {}) },
      reply: true,
      timeoutMs: 45_000,
    }),
  });
  const body = await response.json() as {
    ok: boolean;
    error?: string;
    result?: Array<{ peer: string; reply: PeerPatchReply }>;
  };
  if (!body.ok) throw new Error(body.error ?? `agent REPL answered ${response.status}`);
  const replies = body.result ?? [];
  if (replies.length === 0) {
    console.log("no trusted peer in this VRChat instance" + (options.peer ? ` matches ${options.peer}` : ""));
  }
  for (const { peer, reply } of replies) {
    console.log(
      reply.ok
        ? `${peer}: ${summarizePeerPatch(reply.results)}`
        : `${peer}: refused, ${reply.error}${reply.results ? ` (${summarizePeerPatch(reply.results)})` : ""}`,
    );
  }
}

async function push(files: string[], options: Options): Promise<void> {
  const modules = await emit(files);
  console.log(`sending ${modules.map((m) => m.path).join(", ")}`);
  await send(modules, options);
}

async function watch(options: Options): Promise<never> {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = async () => {
    const files = [...pending];
    pending.clear();
    if (files.length === 0) return;
    if (!await typeCheck()) {
      console.error(`not sent: deno task check failed (${files.join(", ")})`);
      return;
    }
    await push(files, options).catch((error) => console.error(`${error}`));
  };
  console.log(`watching ${WATCHED_DIRS.join(", ")} for saves to push to trusted peers`);
  const watcher = Deno.watchFs(WATCHED_DIRS.map((dir) => resolve(root, dir)));
  for await (const event of watcher) {
    if (event.kind !== "modify" && event.kind !== "create") continue;
    for (const path of event.paths) {
      if (SCRIPT.test(path) && !path.endsWith(".test.ts")) pending.add(relative(root, path));
    }
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), 400);
  }
  throw new Error("file watcher ended");
}

if (import.meta.main) {
  const options = parseArgs(Deno.args);
  if (options.watch) await watch(options);
  const files = [...options.files, ...(options.since ? await changedSince(options.since) : [])];
  if (files.length === 0) {
    console.log(`nothing changed since ${options.since}`);
    Deno.exit(0);
  }
  await push([...new Set(files)], options);
}
