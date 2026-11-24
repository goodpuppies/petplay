/**
 * site: serves the built RDP page (`dist/rdp`, `deno task rdp:build`) as static files, plus a
 * same-origin `/session` endpoint so Tailnet clients don't need `#<id>.<secret>` in the URL.
 * When `password` is set, `/session` requires `POST /session { password }` (constant-time checked)
 * before returning `{ id, secret }`.
 */
import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { fromFileUrl } from "@std/path";
import { sameSecret } from "./classes/session.ts";

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  wasm: "application/wasm",
};

const state = actorState({
  name: "rdp-site",
  url: null as string | null,
  requests: 0,
  passwordProtected: false,
});

let server: Deno.HttpServer | null = null;
let sessionCreds: { id: string; secret: string } | null = null;
let requiredPassword: string | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function isSameOrigin(request: Request, selfUrl: string): boolean {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(selfUrl).origin) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  return true;
}

new PostMan(state, {
  /** Serve `dir` (default dist/rdp) on `hostname:port`; resolves with the base URL. */
  SERVE: (payload: {
    hostname?: string;
    port?: number;
    dir?: string;
    session?: { id: string; secret: string };
    password?: string;
  }) => {
    if (payload.session) sessionCreds = payload.session;
    if (payload.password !== undefined) {
      requiredPassword = payload.password || null;
      state.passwordProtected = requiredPassword != null;
    }
    if (state.url) return state.url;
    const dir = payload.dir ?? fromFileUrl(new URL("../dist/rdp", import.meta.url));
    const hostname = payload.hostname ?? "127.0.0.1";
    return new Promise<string>((resolve) => {
      server = Deno.serve({
        hostname,
        port: payload.port ?? 0,
        onListen: ({ port }) => {
          state.url = `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}/`;
          resolve(state.url);
        },
      }, async (request) => {
        state.requests++;
        const path = new URL(request.url).pathname;
        if (path === "/favicon.ico") return new Response(null, { status: 204 });
        if (path === "/session") {
          if (!sessionCreds) return jsonResponse({ error: "No session configured" }, 404);
          if (state.url && !isSameOrigin(request, state.url)) {
            return jsonResponse({ error: "Cross-origin session access denied" }, 403);
          }
          if (!requiredPassword) {
            if (request.method !== "GET" && request.method !== "POST") {
              return jsonResponse({ error: "Method not allowed" }, 405);
            }
            return jsonResponse(sessionCreds);
          }
          if (request.method === "GET") {
            return jsonResponse({ authRequired: true }, 401);
          }
          if (request.method === "POST") {
            let given: unknown;
            try {
              const body = await request.json() as { password?: unknown };
              given = body?.password;
            } catch {
              return jsonResponse({ authRequired: true, error: "Invalid JSON" }, 400);
            }
            if (!sameSecret(given, requiredPassword)) {
              return jsonResponse({ authRequired: true, error: "Invalid password" }, 401);
            }
            return jsonResponse(sessionCreds);
          }
          return jsonResponse({ error: "Method not allowed" }, 405);
        }
        const name = path === "/" ? "index.html" : path.slice(1);
        if (name.split("/").some((part) => part === ".." || part.startsWith("."))) {
          return new Response("Not found", { status: 404 });
        }
        try {
          const body = await Deno.readFile(`${dir}/${name}`);
          const type = TYPES[name.split(".").pop() ?? ""] ?? "application/octet-stream";
          return new Response(body, { headers: { "content-type": type, "cache-control": "no-cache" } });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      });
    });
  },
  __SHUTDOWN__: async () => {
    await server?.shutdown();
    server = null;
  },
  __HEALTH__: () => ({ ...state }),
} as const);
