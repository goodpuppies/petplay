/**
 * The household's other desktops, as VR display outputs.
 *
 * With a household secret on this machine (`.secret`, `rdp/classes/household.ts`), this actor
 * joins the household topic and finds the other machines' desktopSources there (the agent,
 * `rdp/agent.ts`, or another machine's rdp app). Each becomes a display output named after its
 * machine. Nothing is started until a display shows one: a feed start can ask that machine's
 * user to share the screen, so it waits for `SHOW`.
 *
 * Shown, a desktop gets a process-isolated `remoteMediaOverlay` on its feed (the pinned
 * WebTransport listener a browser would take) and an input target: the machine's desktopInput
 * plus the proof it takes, which the scene sends display input to directly. When the last display
 * lets go (`RELEASE`), the overlay stops after a grace period.
 *
 * Needs stageforge networking (`--stageforge-networking`); without it the list stays empty.
 */
import { actorState, PostMan, System } from "../submodules/stageforge/mod.ts";
import type { ActorId } from "../submodules/stageforge/src/lib/types.ts";
import { householdProof, householdSecret, householdTopic } from "../rdp/classes/household.ts";
import type { DesktopDescription, FeedInfo } from "../rdp/desktopSource.ts";
import type { WorkspaceOutput } from "../classes/environment/workspaceDisplays.ts";

const POLL_MS = 2000;
/** A desktop no display shows keeps its overlay this long, for a quick switch back. */
const RELEASE_GRACE_MS = 30_000;
const RETRY_MS = 10_000;
const REQUEST_MS = 60_000;

type Desktop = {
  source: ActorId;
  machine: string;
  input: ActorId | null;
  /** Displays (spatial node ids) showing it. */
  holders: Set<string>;
  overlay: ActorId | null;
  feed: FeedInfo | null;
  width: number;
  height: number;
  frames: number;
  starting: boolean;
  retryAt: number;
  releaseAt: number | null;
  error: string | null;
};

const state = actorState({
  name: "householdDesktops",
  enabled: false,
  topic: null as string | null,
  desktops: [] as Array<{
    machine: string;
    source: string;
    shown: boolean;
    running: boolean;
    frames: number;
    error: string | null;
  }>,
  lastError: null as string | null,
});

let secret: string | null = null;
const desktops = new Map<string, Desktop>();
let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;

function report(error: string): void {
  if (state.lastError === error) return;
  state.lastError = error;
  console.error(`[householdDesktops] ${error}`);
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      handle = setTimeout(() => reject(Error(`${what}: no reply in ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(handle));
}

async function request<T>(target: ActorId, type: string, payload: unknown = null): Promise<T> {
  return await withTimeout(
    PostMan.PostMessage({
      target,
      type: "GUARDED",
      payload: { proof: await householdProof(secret!, target), type, payload },
    }, true) as Promise<T>,
    REQUEST_MS,
    `${type} on ${target}`,
  );
}

function summarize(): void {
  state.desktops = [...desktops.values()].map((d) => ({
    machine: d.machine,
    source: d.source,
    shown: d.holders.size > 0,
    running: d.overlay !== null && d.frames > 0,
    frames: d.frames,
    error: d.error,
  }));
}

async function stopOverlay(desktop: Desktop): Promise<void> {
  const overlay = desktop.overlay;
  desktop.overlay = null;
  desktop.frames = 0;
  if (!overlay) return;
  await withTimeout(PostMan.PostMessage({ target: overlay, type: "STOPMEDIA", payload: null }, true), 10_000, "STOPMEDIA")
    .catch(() => {});
  PostMan.PostMessage({ target: System, type: "MURDER", payload: overlay });
}

function forget(machine: string): void {
  const desktop = desktops.get(machine);
  if (!desktop) return;
  desktops.delete(machine);
  void stopOverlay(desktop);
}

/** Other machines' desktopSources on the household topic. */
async function discover(): Promise<void> {
  const known = new Set([...state.addressBook].map(String));
  for (const [machine, desktop] of desktops) if (!known.has(desktop.source)) forget(machine);
  for (const id of known) {
    if (!id.startsWith("desktopSource@")) continue;
    if ([...desktops.values()].some((d) => d.source === id)) continue;
    try {
      const described = await request<DesktopDescription>(id as ActorId, "DESCRIBE");
      // This machine's own desktop (an rdp app here) is the local one, not a remote output.
      if (described.machine === Deno.hostname()) continue;
      // The same machine under a new id is its agent restarted.
      const previous = desktops.get(described.machine);
      const holders = previous?.holders ?? new Set<string>();
      if (previous) forget(described.machine);
      desktops.set(described.machine, {
        source: id as ActorId,
        machine: described.machine,
        input: described.input as ActorId | null,
        holders,
        overlay: null,
        feed: null,
        width: 0,
        height: 0,
        frames: 0,
        starting: false,
        retryAt: 0,
        releaseAt: null,
        error: null,
      });
    } catch (error) {
      report(`DESCRIBE ${id}: ${error}`);
    }
  }
}

/** Bring a shown desktop's feed and overlay up, and keep them current. */
async function keep(desktop: Desktop): Promise<void> {
  if (desktop.holders.size === 0) {
    if (desktop.overlay && desktop.releaseAt !== null && Date.now() >= desktop.releaseAt) {
      desktop.releaseAt = null;
      await stopOverlay(desktop);
    }
    return;
  }
  desktop.releaseAt = null;
  if (desktop.starting || Date.now() < desktop.retryAt) return;
  desktop.starting = true;
  try {
    let feed = await request<FeedInfo | null>(desktop.source, "FEED");
    // Starting may wait for that machine's user to share the screen.
    feed ??= await request<FeedInfo>(desktop.source, "START");
    if (desktop.overlay) {
      const health = await withTimeout(
        PostMan.PostMessage({ target: desktop.overlay, type: "__HEALTH__", payload: null }, true) as Promise<
          { running: boolean; starting: boolean; frames: number; width: number; height: number; lastError: string | null }
        >,
        5000,
        "overlay health",
      ).catch(() => null);
      const sameFeed = JSON.stringify(feed) === JSON.stringify(desktop.feed);
      if (health && (health.running || health.starting) && sameFeed) {
        desktop.frames = health.frames;
        desktop.width = health.width;
        desktop.height = health.height;
        desktop.error = null;
        return;
      }
      desktop.error = health?.lastError ?? (sameFeed ? "the overlay stopped" : null);
      await stopOverlay(desktop);
    }
    desktop.feed = feed;
    const overlay = (await PostMan.create("./remoteMediaOverlay.ts", import.meta.url, {
      worker: "process",
    })) as unknown as ActorId;
    desktop.overlay = String(overlay) as ActorId;
    await PostMan.PostMessage({
      target: desktop.overlay,
      type: "STARTMEDIA",
      payload: {
        // A share code passes the other machine's firewall; the pinned listener may not.
        ...(feed.code ? { code: feed.code } : { feed }),
        feedId: `household:${desktop.machine}`,
        name: desktop.machine,
      },
    }, true);
  } catch (error) {
    desktop.error = String(error instanceof Error ? error.message : error);
    desktop.retryAt = Date.now() + RETRY_MS;
    report(`${desktop.machine}: ${desktop.error}`);
  } finally {
    desktop.starting = false;
  }
}

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    await discover();
    await Promise.all([...desktops.values()].map((desktop) => keep(desktop)));
    summarize();
  } finally {
    polling = false;
  }
}

/** The display outputs: every household desktop, with its overlay once one is running. */
function outputs(): WorkspaceOutput[] {
  return [...desktops.values()].map((d) => {
    const running = d.overlay !== null && d.frames > 0 && d.width > 0 && d.height > 0;
    return {
      id: `household:${d.machine}`,
      name: d.machine,
      priority: -1,
      logicalX: 0,
      logicalY: 0,
      logicalWidth: running ? d.width : 1920,
      logicalHeight: running ? d.height : 1080,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      household: { machine: d.machine, provider: state.id },
      ...(running ? { overlayHostActor: d.overlay! } : {}),
      ...(running && d.input
        ? { inputActor: d.input }
        : { input: "none" as const }),
    };
  });
}

new PostMan(
  state,
  {
    __INIT__: async () => {
      secret = householdSecret();
      if (!secret) return;
      state.enabled = true;
      state.topic = await householdTopic(secret);
      PostMan.setTopic(state.topic);
      timer = setInterval(() => void poll(), POLL_MS);
      void poll();
    },
    __HEALTH__: () => ({ ...state }),
    LIST: () => outputs(),
    /** A display (spatial node id) shows this machine's desktop. */
    SHOW: (payload: { machine: string; display: string }) => {
      const desktop = desktops.get(payload?.machine);
      if (!desktop) return false;
      desktop.holders.add(String(payload.display));
      desktop.releaseAt = null;
      void poll();
      return true;
    },
    /** A display stopped showing it. */
    RELEASE: (payload: { machine: string; display: string }) => {
      const desktop = desktops.get(payload?.machine);
      if (!desktop) return false;
      desktop.holders.delete(String(payload.display));
      if (desktop.holders.size === 0) desktop.releaseAt = Date.now() + RELEASE_GRACE_MS;
      return true;
    },
    /** The input target for a shown desktop: its desktopInput and the proof it takes. */
    INPUTTARGET: async (payload: { machine: string }) => {
      const desktop = desktops.get(payload?.machine);
      if (!desktop?.input || !secret) return null;
      return { actor: desktop.input, proof: await householdProof(secret, desktop.input) };
    },
    __SHUTDOWN__: async () => {
      if (timer) clearInterval(timer);
      timer = null;
      await Promise.all([...desktops.values()].map((desktop) => stopOverlay(desktop)));
      desktops.clear();
    },
  } as const,
);
