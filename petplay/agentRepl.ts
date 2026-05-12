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
  actor: string;
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

const state = actorState({
  name: "agentRepl",
  registry: {} as ActorRegistry,
  serverStarted: false,
  port: getAgentReplPort(),
});

new PostMan(
  state,
  {
    __INIT__: (_payload: void) => {
      startServer();
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

  Deno.serve({ hostname: "127.0.0.1", port: state.port }, handleRequest);
  LogChannel.log("agentRepl", `agent REPL listening on http://127.0.0.1:${state.port}`);
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

    if (request.method === "POST" && url.pathname === "/message") {
      const body = await readJson<MessageRequest>(request);
      const target = resolveActor(body.target);
      const payload = body.payload ?? null;
      if (body.reply) {
        const result = await withTimeout(
          PostMan.PostMessage({ target, type: body.type, payload }, true),
          body.timeoutMs ?? 3000,
        );
        return json({ ok: true, target, type: body.type, result });
      }
      PostMan.PostMessage({ target, type: body.type, payload });
      return json({ ok: true, target, type: body.type, sent: true });
    }

    if (request.method === "POST" && url.pathname === "/reload") {
      const body = await readJson<ReloadRequest>(request);
      const actorId = resolveActor(body.actor);
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
      const actorId = await PostMan.PostMessage({
        target: System,
        type: "CREATE",
        payload: {
          actorname: body.actorname,
          base: body.base,
        },
      }, true) as ActorId;
      return json({ ok: true, actorId });
    }

    return json({ ok: false, error: "Not found" }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, { status: 500 });
  }
}
