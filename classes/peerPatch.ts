/**
 * Peer code patches: a trusted peer pushes edited functions into this PetPlay while it runs, so
 * coop prototyping does not wait for a CI release.
 *
 * The sender (`utils/peer-patch.ts`) emits each changed module to JavaScript the way Deno runs it
 * and addresses it by its repo-relative path. This machine maps that path onto its own module
 * root (a source checkout, or a compiled release's `deno-compile-petplay/` tree), and every local
 * actor applies it through Stageforge's `HOTPATCH` (`submodules/stageforge/src/lib/HotPatch.ts`).
 *
 * Only function bodies change. A patch that changes a module's top level (imports, exports,
 * constants, new handler entries) is refused as `structural` and needs a release, as does one for
 * a module the release does not match. Patches are accepted only from trusted peers, and only
 * while the `acceptPeerPatches` setting is on (off by default).
 */
import type { PatchModule, PatchResult } from "../submodules/stageforge/src/lib/HotPatch.ts";
import { getSettingsPath, parseSettings } from "./settings.ts";

export type PeerPatchModule = { path: string; source: string };

export type PeerPatchRequest = {
  modules: PeerPatchModule[];
  /** Who sent it, for the log (the sender's VRChat display name). */
  label?: string;
};

export type PeerPatchActorResult = { actor: string } & PatchResult;

export type PeerPatchReply =
  | { ok: true; patched: string[]; results: PeerPatchActorResult[] }
  | { ok: false; error: string; results?: PeerPatchActorResult[] };

/** This PetPlay's module root: the folder holding `petplay/` and `classes/`. */
export const MODULE_ROOT: URL = new URL("../", import.meta.url);

const MAX_MODULES = 64;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

/**
 * Maps repo-relative module paths onto `root`. Throws on anything that is not a plain relative
 * path to a script inside the tree, so a patch cannot address files outside PetPlay's modules.
 */
export function resolvePatchModules(
  modules: unknown,
  root: URL = MODULE_ROOT,
): PatchModule[] {
  if (!Array.isArray(modules) || modules.length === 0) throw new Error("no modules in the patch");
  if (modules.length > MAX_MODULES) throw new Error(`too many modules (${modules.length})`);
  return modules.map((module) => {
    const { path, source } = (module ?? {}) as Partial<PeerPatchModule>;
    if (typeof path !== "string" || typeof source !== "string") {
      throw new Error("each module needs a string path and source");
    }
    if (source.length > MAX_SOURCE_BYTES) throw new Error(`${path}: source too large`);
    const segments = path.split("/");
    if (
      path.startsWith("/") || path.includes("\\") || path.includes(":") ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
      !/\.(ts|tsx|js|jsx|mjs)$/.test(path)
    ) {
      throw new Error(`refusing module path ${JSON.stringify(path)}`);
    }
    return { url: new URL(path, root).href, source };
  });
}

/** Read from the settings file on each patch: this actor's worker never loads settings. */
export function peerPatchesAccepted(path: string = getSettingsPath()): boolean {
  try {
    return parseSettings(Deno.readTextFileSync(path)).settings.acceptPeerPatches === true;
  } catch {
    return false;
  }
}

/** One line per outcome, for the log and the sender. */
export function summarizePeerPatch(results: PeerPatchActorResult[]): string {
  const patched = results.filter((r) => r.status === "patched");
  const refused = results.filter((r) =>
    r.status === "structural" || r.status === "blocked" || r.status === "error"
  );
  const parts: string[] = [];
  if (patched.length > 0) {
    parts.push(
      `patched ${patched.map((r) => `${r.actor} (${(r.functions ?? []).join(", ")})`).join("; ")}`,
    );
  }
  for (const r of refused) parts.push(`${r.actor}: ${r.status}${r.detail ? ` (${r.detail})` : ""}`);
  if (parts.length === 0) {
    parts.push(
      results.some((r) => r.status === "unchanged")
        ? "already up to date"
        : "no running actor loaded these modules",
    );
  }
  return parts.join(" | ");
}
