/**
 * site: serves the built RDP page (`dist/rdp`, `deno task rdp:build`) as static files. The page
 * only carries code, so this can be any static host; this actor is the one that comes with rdp.
 */
import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import { fromFileUrl } from "@std/path";

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  wasm: "application/wasm",
};

const state = actorState({
  name: "rdp-site",
  url: null as string | null,
  requests: 0,
});

let server: Deno.HttpServer | null = null;

new PostMan(state, {
  /** Serve `dir` (default dist/rdp) on `hostname:port`; resolves with the base URL. */
  SERVE: (payload: { hostname?: string; port?: number; dir?: string }) => {
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
