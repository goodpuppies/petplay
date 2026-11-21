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
async function request<T>(target: ActorId, type: string, payload: unknown = null): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      PostMan.PostMessage({ target, type, payload }, true) as Promise<T>,
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
  const local = actors.filter((a) => a.ownership !== "external");
  const feeds = await Promise.all(
    local.filter((a) => a.actorId.startsWith("remoteMedia@")).map(
      async (actor) => {
        try {
          const health = await request<RemoteFeedHealth>(actor.actorId, "__HEALTH__");
          // Household desktops' overlays are listed by their provider, below.
          if (health.feedId?.startsWith("household:")) return null;
          return remoteDisplayOutput(actor.actorId, health);
        } catch {
          return null;
        }
      },
    ),
  );
  const household = await Promise.all(
    local.filter((a) => a.actorId.startsWith("householdDesktops@")).map((actor) =>
      request<WorkspaceOutput[]>(actor.actorId, "LIST").catch(() => [])
    ),
  );
  return [...feeds.filter((feed): feed is WorkspaceOutput => feed !== null), ...household.flat()];
}

/** Missing/disconnected feeds must never fall through to the local desktop provider. */
export function resolveDisplayFeedProvider(
  output: WorkspaceOutput | undefined,
  localActor: string | null | undefined,
) {
  if (!output) return { actor: null, acceptsMouse: false };
  // A household desktop that is not running yet shows nothing.
  if (output.household && !output.overlayHostActor) return { actor: null, acceptsMouse: false };
  return {
    actor: output.overlayHostActor ?? localActor ?? null,
    acceptsMouse: output.input !== "none",
  };
}

/**
 * Tell this machine's displayShare (`petplay/displayShare.ts`) which screens the displays share.
 * False when there is none (no share key on this machine).
 */
export async function setSharedScreens(
  screens: Array<{ name: string; input: boolean }>,
): Promise<boolean> {
  const actors = await request<Array<{ actorId: ActorId; ownership?: string }>>(System, "INSPECT");
  const share = actors.find((a) => a.ownership !== "external" && a.actorId.startsWith("displayShare@"));
  if (!share) return false;
  await request(share.actorId, "SETSHARED", { screens });
  return true;
}
