/**
 * The household's other desktops, as VR display outputs.
 *
 * With a household secret on this machine (`.secret`, `rdp/classes/household.ts`), this actor
 * joins the household topic and finds the other machines' desktopSources there (the agent,
 * `rdp/agent.ts`, or another machine's rdp app). Each becomes a display output named after its
 * machine; a Windows machine offers each monitor as its own (`DesktopDescription.screens`), keyed
 * `machine:index` and named `machine · DISPLAY2`. Nothing is started until a display shows one: a feed start can ask that machine's
 * user to share the screen, so it waits for `SHOW`.
 *
 * Shown, a desktop gets a process-isolated `remoteMediaOverlay` on its feed (the pinned
 * WebTransport listener a browser would take) and an input target: the machine's desktopInput
 * plus the proof it takes, and for a monitor its region of the virtual desktop, which the scene
 * sends display input to directly. When the last display
 * lets go (`RELEASE`), the overlay stops after a grace period.
 *
 * Needs stageforge networking (`--stageforge-networking`); without it the list stays empty.
 */
import { actorState, PostMan, System } from "../submodules/stageforge/mod.ts";
import type { ActorId } from "../submodules/stageforge/src/lib/types.ts";
import { householdProof, householdSecret, householdTopic } from "../rdp/classes/household.ts";
import type { DesktopDescription, FeedInfo, ScreenInfo } from "../rdp/desktopSource.ts";
import type { WorkspaceOutput } from "../classes/environment/workspaceDisplays.ts";

const POLL_MS = 2000;
/** A desktop no display shows keeps its overlay this long, for a quick switch back. */
const RELEASE_GRACE_MS = 30_000;
const RETRY_MS = 10_000;
const REQUEST_MS = 60_000;
/** A desktopSource that does not describe itself this fast is skipped for `QUIET_MS`. */
const DESCRIBE_MS = 10_000;
const QUIET_MS = 60_000;

type Desktop = {
  /** `machine`, or `machine:index` for one of a Windows machine's monitors. */
  key: string;
  name: string;
  source: ActorId;
  machine: string;
  /** The monitor (`START {monitor}`); undefined: the machine's one feed. */
  monitor?: number;
  region: ScreenInfo["region"] | null;
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
    key: string;
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
/** desktopSources that did not answer DESCRIBE (an agent since restarted), until when. */
const quiet = new Map<string, number>();

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

async function request<T>(
  target: ActorId,
  type: string,
  payload: unknown = null,
  ms = REQUEST_MS,
): Promise<T> {
  return await withTimeout(
    PostMan.PostMessage({
      target,
      type: "GUARDED",
      payload: { proof: await householdProof(secret!, target), type, payload },
    }, true) as Promise<T>,
    ms,
    `${type} on ${target}`,
  );
}

function summarize(): void {
  state.desktops = [...desktops.values()].map((d) => ({
    key: d.key,
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

function forget(key: string): void {
  const desktop = desktops.get(key);
  if (!desktop) return;
  desktops.delete(key);
  void stopOverlay(desktop);
}

/** Other machines' desktopSources on the household topic. */
async function discover(): Promise<void> {
  const known = new Set([...state.addressBook].map(String));
  for (const [key, desktop] of desktops) if (!known.has(desktop.source)) forget(key);
  const now = Date.now();
  const fresh = [...known].filter((id) =>
    id.startsWith("desktopSource@") && (quiet.get(id) ?? 0) <= now &&
    ![...desktops.values()].some((d) => d.source === id)
  );
  // At once: a source gone without leaving the address book must not hold up the others.
  await Promise.all(fresh.map(async (id) => {
    try {
      const described = await request<DesktopDescription>(id as ActorId, "DESCRIBE", null, DESCRIBE_MS);
      // This machine's own desktop (an rdp app here) is the local one, not a remote output.
      if (described.machine === Deno.hostname()) {
        quiet.set(id, Infinity);
        return;
      }
      // The same machine under a new id is its agent restarted: its displays keep showing it.
      const holders = new Map<string, Set<string>>();
      for (const [key, d] of desktops) {
        if (d.machine !== described.machine) continue;
        holders.set(key, d.holders);
        forget(key);
      }
      const screens: Array<ScreenInfo | null> = described.screens?.length ? described.screens : [null];
      for (const screen of screens) {
        const key = screen ? `${described.machine}:${screen.index}` : described.machine;
        desktops.set(key, {
          key,
          name: screen ? `${described.machine} · ${screen.name}` : described.machine,
          source: id as ActorId,
          machine: described.machine,
          ...(screen ? { monitor: screen.index } : {}),
          region: screen?.region ?? null,
          input: described.input as ActorId | null,
          holders: holders.get(key) ?? new Set<string>(),
          overlay: null,
          feed: null,
          width: screen?.width ?? 0,
          height: screen?.height ?? 0,
          frames: 0,
          starting: false,
          retryAt: 0,
          releaseAt: null,
          error: null,
        });
      }
    } catch (error) {
      quiet.set(id, Date.now() + QUIET_MS);
      report(`DESCRIBE ${id}: ${error}`);
    }
  }));
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
    const which = desktop.monitor === undefined ? null : { monitor: desktop.monitor };
    let feed = await request<FeedInfo | null>(desktop.source, "FEED", which);
    // Starting may wait for that machine's user to share the screen.
    feed ??= await request<FeedInfo>(desktop.source, "START", which);
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
        feedId: `household:${desktop.key}`,
        name: desktop.name,
      },
    }, true);
  } catch (error) {
    desktop.error = String(error instanceof Error ? error.message : error);
    desktop.retryAt = Date.now() + RETRY_MS;
    report(`${desktop.key}: ${desktop.error}`);
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
    const running = d.overlay !== null && d.frames > 0;
    // A monitor's size is known before it runs, so its display takes its shape right away.
    const sized = d.width > 0 && d.height > 0;
    return {
      id: `household:${d.key}`,
      name: d.name,
      priority: -1,
      logicalX: 0,
      logicalY: 0,
      logicalWidth: sized ? d.width : 1920,
      logicalHeight: sized ? d.height : 1080,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      household: { desktop: d.key, provider: state.id },
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
    /** A display (spatial node id) shows this desktop. */
    SHOW: (payload: { desktop: string; display: string }) => {
      const desktop = desktops.get(payload?.desktop);
      if (!desktop) return false;
      desktop.holders.add(String(payload.display));
      desktop.releaseAt = null;
      void poll();
      return true;
    },
    /** A display stopped showing it. */
    RELEASE: (payload: { desktop: string; display: string }) => {
      const desktop = desktops.get(payload?.desktop);
      if (!desktop) return false;
      desktop.holders.delete(String(payload.display));
      if (desktop.holders.size === 0) desktop.releaseAt = Date.now() + RELEASE_GRACE_MS;
      return true;
    },
    /**
     * The input target for a shown desktop: its desktopInput, the proof it takes, and for a
     * monitor the region of the virtual desktop its positions map into.
     */
    INPUTTARGET: async (payload: { desktop: string }) => {
      const desktop = desktops.get(payload?.desktop);
      if (!desktop?.input || !secret) return null;
      return {
        actor: desktop.input,
        proof: await householdProof(secret, desktop.input),
        ...(desktop.region ? { region: desktop.region } : {}),
      };
    },
    __SHUTDOWN__: async () => {
      if (timer) clearInterval(timer);
      timer = null;
      await Promise.all([...desktops.values()].map((desktop) => stopOverlay(desktop)));
      desktops.clear();
    },
  } as const,
);
