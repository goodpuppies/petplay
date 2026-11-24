/**
 * Shared handle to this process's single `petplay-media actor` StageForge native actor.
 *
 * Speaks StageForge `protocol: 1` NDJSON over stdio (`CREATE_NATIVE` / `NativeStdioProxy`),
 * hosting DMA-BUF socket feeds (`START_SOCKET_FEED`, `STOP_FEED`, `WEBRTC_OFFER`, `LIST_FEEDS`)
 * without stdout regex scraping or loopback HTTP SDP servers.
 */
import { type ActorId, PostMan, System } from "../../submodules/stageforge/mod.ts";
import { petplayMediaPath } from "../../classes/petplayMediaPath.ts";

let cached: Promise<ActorId> | null = null;

/** Find or spawn this process's single `petplayMedia@*` native actor via `System`. */
export function ensurePetplayMedia(): Promise<ActorId> {
  if (cached) return cached;
  cached = (async () => {
    const actors = await PostMan.PostMessage({
      target: System,
      type: "INSPECT",
      payload: null,
    }, true) as Array<{ actorId: ActorId }>;
    const existing = actors.find((a) => String(a.actorId).startsWith("petplayMedia@"));
    if (existing) return existing.actorId;
    return await PostMan.PostMessage({
      target: System,
      type: "CREATE_NATIVE",
      payload: {
        cmd: petplayMediaPath(),
        args: ["actor"],
      },
    }, true) as ActorId;
  })().catch((err) => {
    cached = null;
    throw err;
  });
  return cached;
}

export function resetPetplayMediaCache(): void {
  cached = null;
}
