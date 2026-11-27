/**
 * Dev tools' path to trusted coop peers: this machine's running PetPlay, through its agent REPL
 * (`--repl-port`, default 3987), whose `vrcPeers` relays a call to one trusted peer (`PEERCALL`)
 * so the peer's trust and Peer Code Patches checks see a trusted sender.
 */
export const DEFAULT_REPL_PORT = 3987;

export async function replPost<T>(
  port: number,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    });
  } catch (error) {
    throw new Error(
      `no PetPlay agent REPL on port ${port} (${error instanceof Error ? error.message : error})`,
    );
  }
  const reply = await response.json() as { ok: boolean; error?: string; result?: T };
  if (!reply.ok) throw new Error(reply.error ?? `agent REPL answered ${response.status}`);
  return reply.result as T;
}

/** Sends `type` to the one trusted peer matching `peer` (part of a display name, or an actor id). */
export async function peerCall<T>(
  port: number,
  peer: string,
  type: string,
  payload: unknown = null,
  timeoutMs = 60_000,
): Promise<{ peer: string; actorId: string; reply: T }> {
  return await replPost(port, "/message", {
    target: "vrcPeers",
    type: "PEERCALL",
    payload: { peer, type, payload, timeoutMs },
    reply: true,
    timeoutMs: timeoutMs + 2_000,
  }, timeoutMs + 2_000);
}

/** A peer handler's own `{ok:false,error}` becomes an exception. */
export function unwrap<T extends { ok: boolean; error?: string }>(
  peer: string,
  reply: T,
): T & { ok: true } {
  if (!reply.ok) throw new Error(`${peer}: ${reply.error}`);
  return reply as T & { ok: true };
}
