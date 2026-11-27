/** Remote feed discovery uses the actor control plane, independent of the debug HTTP server. */
import { PostMan, System } from "../../submodules/stageforge/mod.ts";
import type { ActorId } from "../../submodules/stageforge/src/lib/types.ts";
import type { WorkspaceOutput } from "./workspaceDisplays.ts";
import type { SharedDisplayWorldPose } from "../vrcOriginTransform.ts";
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
    local.filter((a) =>
      a.actorId.startsWith("householdDesktops@") || a.actorId.startsWith("localWindows@")
    ).map((actor) =>
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

let cachedLocalDisplayShare: ActorId | null = null;
let cachedLocalHouseholdDesktops: ActorId | null = null;

async function findLocalActor(prefix: string, cached: ActorId | null): Promise<ActorId | null> {
  if (cached) return cached;
  const actors = await request<Array<{ actorId: ActorId; ownership?: string }>>(System, "INSPECT");
  const found = actors.find((a) => a.ownership !== "external" && a.actorId.startsWith(prefix));
  return found?.actorId ?? null;
}

/**
 * Tell this machine's displayShare (`petplay/displayShare.ts`) which screens the displays share.
 * False when there is none (no share key on this machine).
 */
export async function setSharedScreens(
  screens: Array<{
    kind?: "monitor" | "window";
    windowId?: string;
    name: string;
    input: boolean;
    worldPose?: SharedDisplayWorldPose;
  }>,
): Promise<boolean> {
  const share = await findLocalActor("displayShare@", cachedLocalDisplayShare);
  if (!share) return false;
  cachedLocalDisplayShare = share;
  try {
    await request(share, "SETSHARED", { screens });
    return true;
  } catch {
    cachedLocalDisplayShare = null;
    return false;
  }
}

/** Fire-and-forget live pose push from the sharer's scene to local displayShare (20 Hz during drag). */
export async function pushLocalSharedPose(payload: {
  kind?: "monitor" | "window";
  windowId?: string;
  name: string;
  worldPose: SharedDisplayWorldPose;
}): Promise<void> {
  const share = await findLocalActor("displayShare@", cachedLocalDisplayShare);
  if (!share) return;
  cachedLocalDisplayShare = share;
  PostMan.PostMessage({ target: share, type: "SETLOCALPOSE", payload });
}

export type SharedRemotePoseEntry = {
  kind: "monitor" | "window";
  windowId?: string;
  name: string;
  worldPose: SharedDisplayWorldPose;
};

/** Latest viewer-pushed world poses recorded on this machine's displayShare. */
export async function getSharedRemotePoses(): Promise<SharedRemotePoseEntry[]> {
  const share = await findLocalActor("displayShare@", cachedLocalDisplayShare);
  if (!share) return [];
  cachedLocalDisplayShare = share;
  try {
    const res = await request<SharedRemotePoseEntry[]>(share, "GETREMOTEPOSES");
    return Array.isArray(res) ? res : [];
  } catch {
    cachedLocalDisplayShare = null;
    return [];
  }
}

export type RemoteDisplayPoseSnapshot = {
  id: string;
  worldPose: SharedDisplayWorldPose;
};

/** Lightweight real-time pose snapshot from local householdDesktops (for 20 Hz viewer sync). */
export async function getRemoteDisplayPoses(): Promise<RemoteDisplayPoseSnapshot[]> {
  const provider = await findLocalActor("householdDesktops@", cachedLocalHouseholdDesktops);
  if (!provider) return [];
  cachedLocalHouseholdDesktops = provider;
  try {
    const res = await request<RemoteDisplayPoseSnapshot[]>(provider, "GETPOSES");
    return Array.isArray(res) ? res : [];
  } catch {
    cachedLocalHouseholdDesktops = null;
    return [];
  }
}

/** Push a viewer's updated VRChat world pose back to the sharer via householdDesktops. */
export async function pushRemoteDisplayPose(
  provider: string,
  desktop: string,
  worldPose: SharedDisplayWorldPose,
): Promise<boolean> {
  return await request<boolean>(provider as ActorId, "SETPOSE", { desktop, worldPose })
    .catch(() => false);
}
