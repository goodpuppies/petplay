/**
 * The few GitHub REST calls the updater makes, done so a user never hits the anonymous rate limit
 * (60 requests an hour per IP) in normal use:
 *
 * - Responses are cached on disk with their `ETag`; a repeat request is conditional and GitHub
 *   does not count a `304 Not Modified` against the limit.
 * - `PETPLAY_GITHUB_TOKEN` (or `GITHUB_TOKEN`), when set, authenticates the calls (5000/hour), for
 *   contributors who check branch builds often.
 * - A rate-limited answer becomes an error that says when the limit resets, instead of a bare 403.
 */
import { join } from "@std/path";
import { stateDir } from "./appPaths.ts";

const API = "https://api.github.com";
const CACHE_FILE = "github-cache.json";
/** Entries unused for this long are dropped when the cache is written. */
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;

type CacheEntry = { etag: string; body: unknown; usedAt: number };

export class GitHubRateLimitError extends Error {
  constructor(readonly resetAt: Date | null) {
    super(
      `GitHub rate limit reached${
        resetAt ? `; try again after ${resetAt.toLocaleTimeString()}` : ""
      } (set PETPLAY_GITHUB_TOKEN to raise it)`,
    );
  }
}

export class GitHubNotFoundError extends Error {}

export type GitHubClientOptions = {
  fetchImpl?: typeof fetch;
  userAgent?: string;
  /** Where the ETag cache lives; `null` disables it (tests). */
  cachePath?: string | null;
  token?: string | null;
};

export class GitHubClient {
  readonly #fetch: typeof fetch;
  readonly #userAgent: string;
  readonly #cachePath: string | null;
  readonly #token: string | null;
  #cache: Map<string, CacheEntry> | null = null;

  constructor(options: GitHubClientOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#userAgent = options.userAgent ?? "PetPlay-updater";
    this.#cachePath = options.cachePath === undefined
      ? join(stateDir(), CACHE_FILE)
      : options.cachePath;
    this.#token = options.token === undefined
      ? Deno.env.get("PETPLAY_GITHUB_TOKEN") || Deno.env.get("GITHUB_TOKEN") || null
      : options.token;
  }

  /** GET a JSON API path (`/repos/o/r/releases`), conditional on the cached ETag. */
  async get<T>(path: string): Promise<T> {
    const url = path.startsWith("https://") ? path : `${API}${path}`;
    const cache = this.#loadCache();
    const cached = cache.get(url);
    const headers: Record<string, string> = {
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": this.#userAgent,
    };
    if (this.#token) headers["Authorization"] = `Bearer ${this.#token}`;
    if (cached) headers["If-None-Match"] = cached.etag;
    const res = await this.#fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (res.status === 304 && cached) {
      await res.body?.cancel();
      cached.usedAt = Date.now();
      return cached.body as T;
    }
    if (res.status === 404) {
      await res.body?.cancel();
      throw new GitHubNotFoundError(`GitHub: ${url} not found`);
    }
    if (
      (res.status === 403 || res.status === 429) &&
      (res.headers.get("x-ratelimit-remaining") === "0" || res.status === 429)
    ) {
      await res.body?.cancel();
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      throw new GitHubRateLimitError(
        Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null,
      );
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`GitHub request failed (HTTP ${res.status}) for ${url}`);
    }
    const body = await res.json() as T;
    const etag = res.headers.get("etag");
    if (etag) {
      cache.set(url, { etag, body, usedAt: Date.now() });
      this.#saveCache();
    }
    return body;
  }

  #loadCache(): Map<string, CacheEntry> {
    if (this.#cache) return this.#cache;
    this.#cache = new Map();
    if (this.#cachePath == null) return this.#cache;
    try {
      const raw = JSON.parse(Deno.readTextFileSync(this.#cachePath)) as Record<string, CacheEntry>;
      for (const [url, entry] of Object.entries(raw)) {
        if (entry && typeof entry.etag === "string") this.#cache.set(url, entry);
      }
    } catch {
      // No cache yet, or unreadable: start empty.
    }
    return this.#cache;
  }

  #saveCache(): void {
    if (this.#cachePath == null || this.#cache == null) return;
    const now = Date.now();
    const kept: Record<string, CacheEntry> = {};
    for (const [url, entry] of this.#cache) {
      if (now - entry.usedAt < CACHE_TTL_MS) kept[url] = entry;
    }
    try {
      Deno.mkdirSync(join(this.#cachePath, ".."), { recursive: true });
      const temp = `${this.#cachePath}.${Deno.pid}.tmp`;
      Deno.writeTextFileSync(temp, JSON.stringify(kept));
      Deno.renameSync(temp, this.#cachePath);
    } catch {
      // A cache that cannot be written only costs rate limit.
    }
  }
}
