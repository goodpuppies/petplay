import { PostMan } from "../submodules/stageforge/mod.ts";
import { dirname, extname, join } from "jsr:@std/path";
import { tempDir } from "./appPaths.ts";

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(() => resolve(), ms));
}

/**
 * Control port of the `agentRepl` actor. Server and clients resolve it the same
 * way — `--agent-repl-port=<port>`, then `PETPLAY_AGENT_REPL_PORT`, then 3987 —
 * so a client can be pointed at a server that is not on the default port.
 */
/** Default agent-REPL port; `--agent-repl-port` / `PETPLAY_AGENT_REPL_PORT` override it. */
export const DEFAULT_AGENT_REPL_PORT = 3987;

export function getAgentReplPort(): number {
  const fromArgs = Deno.args
    .find((arg) => arg.startsWith("--agent-repl-port="))
    ?.split("=", 2)[1];
  const parsed = Number(fromArgs ?? Deno.env.get("PETPLAY_AGENT_REPL_PORT"));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AGENT_REPL_PORT;
}

/** `http://127.0.0.1:<agentReplPort>` — the server's actor message surface. */
export function getAgentReplBaseUrl(): string {
  return `http://127.0.0.1:${getAgentReplPort()}`;
}

/**
 * JSON from the agent REPL surface (`/health`, `/message`, `/eval`, …). A
 * non-OK response throws with the server's own error text, so callers can tell
 * "the server refused" from "the server is not there" (which throws from
 * `fetch` itself).
 */
export async function fetchAgentReplJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getAgentReplBaseUrl()}${path}`, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${text.slice(0, 300)}`);
  }
  return (text.length > 0 ? JSON.parse(text) : {}) as T;
}

type ActorAddress = string;

interface ActorNode {
  address: ActorAddress;
  assignMessage?: string; // Message the child should send to parent
  children?: Record<string, ActorNode>;
}

export async function assignActorHierarchy(
  tree: Record<string, ActorNode>,
  parent: ActorAddress | null = null,
): Promise<void> {
  for (const node of Object.values(tree)) {
    if (parent && node.assignMessage) {
      await PostMan.PostMessage({
        target: node.address,
        type: node.assignMessage,
        payload: parent,
      });
    }

    if (node.children) {
      await assignActorHierarchy(node.children, node.address);
    }
  }
}

/**
 * This process's scratch directory. Every server runs from the repo root, so a
 * shared `./tmp` would let one server's shutdown delete files another is still
 * using (SteamVR remembers a binding file it failed to read, and the running
 * server loses controller input). Workers share the pid, so the webxr actor's
 * files land here too.
 */
const RUN_TEMP_DIR = join(tempDir(), `run-${Deno.pid}`);

export function tempFile(filename: string, base: string): string {
  const basepath = join(base, "../");
  const file = Deno.readFileSync(join(basepath, filename));
  ensureRunTemp();
  const temppath = Deno.makeTempFileSync({ dir: RUN_TEMP_DIR, suffix: extname(filename) });
  Deno.writeFileSync(temppath, file);
  const path = Deno.realPathSync(temppath);
  return path;
}

/**
 * Creates this process's scratch directory with all default controller bindings in it.
 * The action manifest names its bindings relative to itself, and SteamVR
 * remembers a binding it once failed to read, so the binding has to be there
 * before any manifest is.
 */
function ensureRunTemp() {
  Deno.mkdirSync(RUN_TEMP_DIR, { recursive: true });
  const resources = join(import.meta.dirname!, "../resources");
  const manifest = JSON.parse(Deno.readTextFileSync(join(resources, "actions.json"))) as {
    default_bindings: { binding_url: string }[];
  };
  for (const { binding_url: name } of manifest.default_bindings) {
    const binding = join(RUN_TEMP_DIR, name);
    const wanted = Deno.readFileSync(join(resources, name));
    let staged: Uint8Array | null = null;
    try {
      staged = Deno.readFileSync(binding);
    } catch {
      // Not staged yet.
    }
    // Refresh a changed binding too: a reboot or webxr reload keeps this process's directory, and
    // a stale copy silently leaves new actions unbound.
    if (staged == null || !bytesEqual(staged, wanted)) Deno.writeFileSync(binding, wanted);
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function createTemp() {
  ensureRunTemp();
  pruneDeadRunTemps();
}

/** Removes the scratch directories of servers that exited without cleaning up. */
function pruneDeadRunTemps() {
  if (Deno.build.os !== "linux") return;
  for (const entry of Deno.readDirSync(tempDir())) {
    const pid = /^run-(\d+)$/.exec(entry.name)?.[1];
    if (!entry.isDirectory || pid == null || Number(pid) === Deno.pid) continue;
    try {
      Deno.statSync(`/proc/${pid}`);
    } catch {
      try {
        Deno.removeSync(join(tempDir(), entry.name), { recursive: true });
      } catch (error) {
        // Servers started together race to prune the same directory.
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
  }
}

export function ensuredenodir() {
  const denoDir = join(Deno.env.get("LOCALAPPDATA") || "", "deno");
  Deno.mkdirSync(denoDir, { recursive: true });
}

export function destroyTemp() {
  console.log("CLEAN");
  try {
    Deno.removeSync(RUN_TEMP_DIR, { recursive: true });
  } catch (error) {
    // A shutdown that races or never created its directory has nothing to remove;
    // only a real failure should surface as a teardown error.
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

const stream = Deno.stdin.readable.values();
/** The next stdin line, or null once stdin has ended (closed, or `/dev/null`). */
export async function asyncPrompt(): Promise<string | null> {
  const next = await stream.next();
  if ("done" in next && next.done) {
    return null;
  } else {
    return new TextDecoder().decode(next.value).slice(0, -1);
  }
}
