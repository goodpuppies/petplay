/** Remote feed discovery uses the actor control plane, independent of the debug HTTP server. */
import { PostMan, System } from "../../submodules/stageforge/mod.ts";
import type { ActorId } from "../../submodules/stageforge/src/lib/types.ts";
import type { WorkspaceOutput } from "./workspaceDisplays.ts";
export type RemoteFeedHealth = {
  running?: boolean;
  frames?: number;
  width?: number;
  height?: number;
  feedId?: string;
  feedName?: string;
};
export function remoteDisplayOutput(
  actor: string,
  health: RemoteFeedHealth,
): WorkspaceOutput | null {
  if (!health.running || !health.frames || !health.width || !health.height) return null;
  return {
    id: `remote:${health.feedId ?? "desktop"}`,
    name: health.feedName ?? "Remote desktop",
    priority: -1,
    logicalX: 0,
    logicalY: 0,
    logicalWidth: health.width,
    logicalHeight: health.height,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    overlayHostActor: actor,
    input: "none",
  };
}
async function request<T>(target: ActorId, type: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      PostMan.PostMessage({ target, type, payload: null }, true) as Promise<T>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("Feed provider did not reply")), 1500);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function discoverRemoteDisplayFeeds(): Promise<WorkspaceOutput[]> {
  const actors = await request<Array<{ actorId: ActorId; ownership?: string }>>(System, "INSPECT");
  const feeds = await Promise.all(
    actors.filter((a) => a.ownership !== "external" && a.actorId.startsWith("remoteMedia@")).map(
      async (actor) => {
        try {
          return remoteDisplayOutput(
            actor.actorId,
            await request<RemoteFeedHealth>(actor.actorId, "__HEALTH__"),
          );
        } catch {
          return null;
        }
      },
    ),
  );
  return feeds.filter((feed): feed is WorkspaceOutput => feed !== null);
}

/** Missing/disconnected feeds must never fall through to the local desktop provider. */
export function resolveDisplayFeedProvider(
  output: WorkspaceOutput | undefined,
  localActor: string | null | undefined,
) {
  if (!output) return { actor: null, acceptsMouse: false };
  return {
    actor: output.overlayHostActor ?? localActor ?? null,
    acceptsMouse: output.input !== "none",
  };
}
