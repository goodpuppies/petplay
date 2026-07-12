import { actorState, PostMan, System } from "../submodules/stageforge/mod.ts";
import type { ActorId } from "../submodules/stageforge/src/lib/types.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";

type ActorRegistry = Record<string, ActorId>;

type MessageRequest = {
  target: string;
  type: string;
  payload?: unknown;
  reply?: boolean;
  timeoutMs?: number;
};

type ReloadRequest = {
  actor?: string;
  target?: string;
};

type RebootRequest = {
  actor?: string;
  startType?: string;
  startPayload?: unknown;
};

type CreateRequest = {
  actorname: string;
  base?: string | URL;
};

type ActorHealth = {
  ok?: boolean;
  actorId?: string;
  name?: string;
  details?: unknown;
  error?: unknown;
};

const state = actorState({
  name: "agentRepl",
  registry: {} as ActorRegistry,
  serverStarted: false,
  port: getAgentReplPort(),
});

let server: Deno.HttpServer<Deno.NetAddr> | null = null;

new PostMan(
  state,
  {
    __INIT__: (_payload: void) => {
      startServer();
    },
    __SHUTDOWN__: async (_payload: unknown) => {
      await stopServer();
    },
    __HEALTH__: (_payload: unknown) => {
      return getAgentReplHealth();
    },
    REGISTER_ACTORS: (payload: ActorRegistry) => {
      state.registry = { ...state.registry, ...payload };
      return getRegistrySnapshot();
    },
    GETREGISTRY: (_payload: null) => {
      return getRegistrySnapshot();
    },
  } as const,
);

function getAgentReplPort(): number {
  const raw = Deno.args.find((arg) => arg.startsWith("--agent-repl-port="));
  const parsed = raw
    ? Number(raw.split("=", 2)[1])
    : Number(Deno.env.get("PETPLAY_AGENT_REPL_PORT"));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3987;
}

function getRegistrySnapshot() {
  return {
    port: state.port,
    actors: { ...state.registry },
  };
}

function resolveActor(value: string): ActorId {
  return (state.registry[value] ?? value) as ActorId;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Response(JSON.stringify({ ok: false, error: `Missing ${name}` }), {
      status: 400,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
      },
    });
  }
  return value;
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, jsonReplacer, 2), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      ...init?.headers,
    },
  });
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

async function readJson<T>(request: Request): Promise<T> {
  const text = await request.text();
  return (text.length > 0 ? JSON.parse(text) : {}) as T;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId != null) {
      clearTimeout(timeoutId);
    }
  }
}

function startServer() {
  if (state.serverStarted) {
    return;
  }
  state.serverStarted = true;

  server = Deno.serve({ hostname: "127.0.0.1", port: state.port }, handleRequest);
  LogChannel.log("agentRepl", `agent REPL listening on http://127.0.0.1:${state.port}`);
}

globalThis.addEventListener("unload", () => {
  void stopServer();
});

async function stopServer(): Promise<void> {
  try {
    await server?.shutdown();
  } catch {
    // Worker teardown can close the listener first.
  }
  server = null;
  state.serverStarted = false;
}

function postReboot(body: RebootRequest): void {
  const payload = {
    actorId: body.actor ? resolveActor(body.actor) : undefined,
    startType: body.startType,
    startPayload: body.startPayload,
  };
  setTimeout(() => {
    PostMan.PostMessage({
      target: System,
      type: "REBOOT",
      payload,
    });
  }, 0);
}

async function queryActorHealth(actorName: string, payload: unknown = null) {
  const target = resolveActor(actorName);
  if (target === state.id) {
    return {
      target,
      health: {
        ok: true,
        actorId: state.id,
        name: state.name,
        addressBookSize: state.addressBook.size,
        details: getAgentReplHealth(),
      },
    };
  }
  const result = await withTimeout(
    PostMan.PostMessage({ target, type: "HEALTH", payload }, true),
    3000,
  ) as ActorHealth;
  const health = result && typeof result === "object"
    ? result
    : { ok: false, error: "Actor returned empty health response" };
  return { target, health };
}

function getAgentReplHealth() {
  return {
    listening: state.serverStarted,
    port: state.port,
    registeredActors: Object.keys(state.registry).length,
  };
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return json(null);
  }

  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, ...getRegistrySnapshot() });
    }

    if (request.method === "GET" && url.pathname === "/registry") {
      return json(getRegistrySnapshot());
    }

    if (request.method === "GET" && url.pathname === "/actors") {
      const actors = await PostMan.PostMessage({
        target: System,
        type: "INSPECT",
        payload: null,
      }, true);
      return json({ registry: getRegistrySnapshot().actors, actors });
    }

    if (request.method === "GET" && url.pathname === "/health/actor") {
      const actor = url.searchParams.get("actor");
      if (!actor) {
        return json({ ok: false, error: "Missing actor query parameter" }, { status: 400 });
      }
      const result = await queryActorHealth(actor);
      return json({ ok: result.health.ok !== false, ...result });
    }

    if (request.method === "GET" && url.pathname === "/health/actors") {
      const entries = Object.entries(getRegistrySnapshot().actors);
      const results = await Promise.all(entries.map(async ([name]) => {
        try {
          const result = await queryActorHealth(name);
          return { name, target: result.target, health: result.health };
        } catch (error) {
          return {
            name,
            target: resolveActor(name),
            health: {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }));
      return json({
        ok: results.every((entry) => entry.health.ok !== false),
        actors: results,
      });
    }

    if (request.method === "POST" && url.pathname === "/message") {
      const body = await readJson<MessageRequest>(request);
      const target = resolveActor(requiredString(body.target, "target"));
      const type = requiredString(body.type, "type");
      const payload = body.payload ?? null;
      if (body.reply) {
        const result = await withTimeout(
          PostMan.PostMessage({ target, type, payload }, true),
          body.timeoutMs ?? 3000,
        );
        return json({ ok: true, target, type, result });
      }
      PostMan.PostMessage({ target, type, payload });
      return json({ ok: true, target, type, sent: true });
    }

    if (request.method === "POST" && url.pathname === "/reload") {
      const body = await readJson<ReloadRequest>(request);
      const actor = requiredString(body.actor ?? body.target, "actor");
      const actorId = resolveActor(actor);
      const result = await PostMan.PostMessage({
        target: System,
        type: "RELOAD",
        payload: { actorId },
      }, true);
      return json({ ok: true, result });
    }

    if (request.method === "POST" && url.pathname === "/reboot") {
      const body = await readJson<RebootRequest>(request);
      postReboot(body);
      return json({ ok: true, scheduled: true });
    }

    if (request.method === "POST" && url.pathname === "/create") {
      const body = await readJson<CreateRequest>(request);
      const actorname = requiredString(body.actorname, "actorname");
      const actorId = await PostMan.PostMessage({
        target: System,
        type: "CREATE",
        payload: {
          actorname,
          base: body.base,
        },
      }, true) as ActorId;
      return json({ ok: true, actorId });
    }

    return json({ ok: false, error: "Not found" }, { status: 404 });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, { status: 500 });
  }
}
