/**
 * The household's other desktops, as VR display outputs.
 *
 * With a household secret on this machine (`.secret`, `rdp/classes/household.ts`), this actor
 * joins the household topic and finds the other machines' desktops there: a PetPlay sharing its
 * displays (`displayShare.ts`), the agent (`rdp/agent.ts`), or another machine's rdp app. Each becomes a display output named after its
 * machine; a Windows machine offers each monitor as its own (`DesktopDescription.screens`), keyed
 * `machine:index` and named after the machine and Windows' monitor number (`DISPLAY2`:
 * `machine2`). Nothing is started until a display shows one: a feed start can ask that machine's
 * user to share the screen, so it waits for `SHOW`.
 *
 * Shown, a desktop gets a process-isolated `remoteMediaOverlay` on its feed (the pinned
 * WebTransport listener a browser would take) and an input target: the machine's desktopInput
 * plus the proof it takes, and for a monitor its region of the virtual desktop, which the scene
 * sends display input to directly. When the last display
 * lets go (`RELEASE`), the overlay stops after a grace period.
 *
 * A machine that offers its sound (`DesktopDescription.audio`) plays it here while any of its
 * desktops is shown: a `petplay-media receive-audio` on the default output, stopped a few
 * seconds after the last display lets go.
 *
 * Needs stageforge networking (`--stageforge-networking`); without it the list stays empty.
 */
import { actorState, PostMan, System } from "../submodules/stageforge/mod.ts";
import { petplayMediaCommand, petplayMediaPath } from "../classes/petplayMediaPath.ts";
import type { ActorId } from "../submodules/stageforge/src/lib/types.ts";
import { HouseholdClient, householdSecret, householdTopic } from "../rdp/classes/household.ts";
import type { DesktopDescription, FeedInfo, ScreenInfo } from "../rdp/desktopSource.ts";
import type { WorkspaceOutput } from "../classes/environment/workspaceDisplays.ts";
import type { SharedDisplayWorldPose } from "../classes/vrcOriginTransform.ts";

const POLL_MS = 2000;
/** A desktop no display shows keeps its overlay this long, for a quick switch back. */
const RELEASE_GRACE_MS = 30_000;
const RETRY_MS = 10_000;
const REQUEST_MS = 60_000;
/**
 * A desktopSource that does not describe itself this fast is skipped for a while: a minute,
 * doubling to half an hour. A restarted agent leaves its old ids in the address book for good.
 */
const DESCRIBE_MS = 10_000;
const QUIET_MS = 60_000;
const QUIET_MAX_MS = 30 * 60_000;
/** After starting an overlay, how often to look for its first frame, and for how long. */
const FIRST_FRAME_POLL_MS = 250;
const FIRST_FRAME_WAIT_MS = 20_000;

type Desktop = {
  /** `machine`, `machine:index` for a monitor, or `machine:win:id` for a shared window. */
  key: string;
  name: string;
  kind: "monitor" | "window";
  source: ActorId;
  machine: string;
  /** The monitor (`START {monitor}`); undefined: whole workspace or a window. */
  monitor?: number;
  /** The window (`START {window}`) when `kind === "window"`. */
  windowId?: string;
  region: ScreenInfo["region"] | null;
  crop: { x: number; y: number; width: number; height: number };
  input: ActorId | null;
  /** The sharer lets viewers drive it. */
  inputAllowed: boolean;
  /** Sharer's display pose in right-handed VRChat world space, when available. */
  worldPose: SharedDisplayWorldPose | null;
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

/** A machine's sound, played while any of its desktops is shown. */
type Sound = {
  machine: string;
  source: ActorId;
  player: Deno.ChildProcess | null;
  starting: boolean;
  retryAt: number;
  /** When the last display let go. */
  quietSince: number | null;
  error: string | null;
  log: string[];
};
/** Switching between a machine's monitors must not cut its sound. */
const AUDIO_GRACE_MS = 3000;

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
  sounds: [] as Array<
    { machine: string; playing: boolean; error: string | null; last: string | null }
  >,
  lastError: null as string | null,
});

let householdClient: HouseholdClient | null = null;
const desktops = new Map<string, Desktop>();
const sounds = new Map<string, Sound>();
/** Trusted peer displayShare sources added by `vrcPeers` (`sourceActorId -> {proof, label}`). */
const peerSources = new Map<string, { proof: string; label?: string }>();
let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;
let discovering = false;
/** desktopSources that did not answer DESCRIBE (an agent since restarted): until when, and the
 * next wait. */
const quiet = new Map<string, { until: number; wait: number }>();

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

async function proofFor(target: ActorId): Promise<string> {
  const peer = peerSources.get(String(target));
  if (peer) return peer.proof;
  if (!householdClient?.active) throw new Error(`no proof for ${target}`);
  return await householdClient.proof(String(target));
}

async function request<T>(
  target: ActorId,
  type: string,
  payload: unknown = null,
  ms = REQUEST_MS,
): Promise<T> {
  const peer = peerSources.get(String(target));
  if (peer) {
    return await withTimeout(
      PostMan.PostMessage({
        target,
        type: "GUARDED",
        payload: { proof: peer.proof, type, payload },
      }, true) as Promise<T>,
      ms,
      `${type} on ${target}`,
    );
  }
  if (!householdClient?.active) throw new Error(`no proof for ${target}`);
  return await withTimeout(
    householdClient.request<T>(
      (msg, wait) => PostMan.PostMessage(msg as Parameters<typeof PostMan.PostMessage>[0], wait),
      String(target),
      type,
      payload,
      true,
    ),
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
  state.sounds = [...sounds.values()].map((s) => ({
    machine: s.machine,
    playing: s.player !== null,
    error: s.error,
    last: s.log.at(-1) ?? null,
  }));
}

function mediaBinary(): string {
  return petplayMediaPath();
}

function stopSound(sound: Sound): void {
  const player = sound.player;
  sound.player = null;
  try {
    player?.kill();
  } catch { /* already gone */ }
}

async function keepSound(sound: Sound): Promise<void> {
  const shown = [...desktops.values()].some((d) =>
    d.machine === sound.machine && d.holders.size > 0
  );
  if (!shown) {
    sound.quietSince ??= Date.now();
    if (sound.player && Date.now() - sound.quietSince >= AUDIO_GRACE_MS) stopSound(sound);
    return;
  }
  sound.quietSince = null;
  if (sound.player || sound.starting || Date.now() < sound.retryAt) return;
  sound.starting = true;
  try {
    const feed = await request<FeedInfo | null>(sound.source, "AUDIO");
    if (!feed) return;
    const args = feed.code
      ? ["receive-audio", feed.code]
      : ["receive-audio", `https://${feed.host}:${feed.port}/`, feed.fingerprint];
    const player = petplayMediaCommand(args, {
      binary: mediaBinary(),
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    sound.player = player;
    sound.error = null;
    const keepLine = (line: string) => {
      sound.log.push(line);
      if (sound.log.length > 50) sound.log.shift();
    };
    void lines(player.stdout, keepLine);
    void lines(player.stderr, keepLine);
    void player.status.then((status) => {
      if (sound.player !== player) return;
      sound.player = null;
      sound.error = `receive-audio exited (${status.code}): ${sound.log.at(-1) ?? ""}`;
      sound.retryAt = Date.now() + RETRY_MS;
      report(`${sound.machine} audio: ${sound.error}`);
    });
  } catch (error) {
    sound.error = String(error instanceof Error ? error.message : error);
    sound.retryAt = Date.now() + RETRY_MS;
    report(`${sound.machine} audio: ${sound.error}`);
  } finally {
    sound.starting = false;
  }
}

async function lines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  let buffered = "";
  try {
    const text = stream.pipeThrough(
      new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>,
    );
    for await (const chunk of text) {
      buffered += chunk;
      const parts = buffered.split(/\r?\n/);
      buffered = parts.pop() ?? "";
      for (const line of parts) if (line) onLine(line);
    }
  } catch { /* the process ended */ }
}

async function stopOverlay(desktop: Desktop): Promise<void> {
  const overlay = desktop.overlay;
  desktop.overlay = null;
  desktop.frames = 0;
  if (!overlay) return;
  await withTimeout(
    PostMan.PostMessage({ target: overlay, type: "STOPMEDIA", payload: null }, true),
    10_000,
    "STOPMEDIA",
  )
    .catch(() => {});
  await PostMan.shutdown(overlay).catch((error) =>
    console.error(`[householdDesktops] overlay shutdown: ${error}`)
  );
}

function forget(key: string): void {
  const desktop = desktops.get(key);
  if (!desktop) return;
  desktops.delete(key);
  void stopOverlay(desktop);
}

/** When each source was last described; a sharer is asked again every `RESCAN_MS`. */
const described = new Map<string, number>();
/** A sharer's shared screens change as its displays are toggled. */
const RESCAN_MS = 5000;
/** Rescan shown sharers faster so shared VRChat world-space display poses stay fresh. */
const SHOWN_RESCAN_MS = 1000;

/** Other machines' desktops on the topic (and trusted VRChat peer sources). */
async function discover(): Promise<void> {
  const known = new Set([...state.addressBook].map(String));
  for (const id of peerSources.keys()) known.add(id);
  for (const [key, desktop] of desktops) if (!known.has(desktop.source)) forget(key);
  for (const [machine, sound] of sounds) {
    if (known.has(sound.source)) continue;
    stopSound(sound);
    sounds.delete(machine);
  }
  for (const id of described.keys()) if (!known.has(id)) described.delete(id);
  const now = Date.now();
  const due = [...known].filter((id) => {
    const isPeer = peerSources.has(id);
    if (!isPeer && !id.startsWith("desktopSource@") && !id.startsWith("displayShare@")) {
      return false;
    }
    if ((quiet.get(id)?.until ?? 0) > now) return false;
    const at = described.get(id);
    const hasShown = [...desktops.values()].some((d) => d.source === id && d.holders.size > 0);
    const interval = hasShown ? SHOWN_RESCAN_MS : RESCAN_MS;
    return at === undefined ||
      ((isPeer || id.startsWith("displayShare@")) && now - at >= interval);
  });
  // At once: a source gone without leaving the address book must not hold up the others.
  await Promise.all(due.map(async (id) => {
    try {
      const description = await request<DesktopDescription>(
        id as ActorId,
        "DESCRIBE",
        { viewer: state.id },
        DESCRIBE_MS,
      );
      described.set(id, Date.now());
      apply(id as ActorId, description);
    } catch (error) {
      const wait = quiet.get(id)?.wait ?? QUIET_MS;
      quiet.set(id, { until: Date.now() + wait, wait: Math.min(QUIET_MAX_MS, wait * 2) });
      report(`DESCRIBE ${id}: ${error}`);
    }
  }));
}

/** Bring the desktops (and sound) offered by `id` in line with its description. */
function apply(id: ActorId, description: DesktopDescription): void {
  const peer = peerSources.get(String(id));
  const machine = peer?.label ?? description.machine;
  // This machine's own desktop (an rdp app here) is the local one, not a remote output.
  if (!peer && machine === Deno.hostname()) {
    quiet.set(id, { until: Infinity, wait: Infinity });
    return;
  }
  // The same machine under a new id (restarted, or the agent replaced by PetPlay): its displays
  // keep showing it.
  const holders = new Map<string, Set<string>>();
  for (const [key, d] of desktops) {
    if (d.machine !== machine || d.source === id) continue;
    holders.set(key, d.holders);
    forget(key);
  }
  const previousSound = sounds.get(machine);
  if (previousSound && previousSound.source !== id) {
    stopSound(previousSound);
    sounds.delete(machine);
  }
  // No `screens`: one desktop, the whole workspace. Empty: no monitors shared (may still share windows).
  const screens: Array<ScreenInfo | null> = description.screens ?? [null];
  const windows = description.windows ?? [];
  const keys = new Set([
    ...screens.map((screen) => screen ? `${machine}:${screen.index}` : machine),
    ...windows.map((win) => `${machine}:win:${win.id}`),
  ]);
  for (const [key, d] of desktops) if (d.source === id && !keys.has(key)) forget(key);
  for (const screen of screens) {
    const key = screen ? `${machine}:${screen.index}` : machine;
    const inputAllowed = screen ? screen.input !== false : description.wholeInput !== false;
    const worldPose = screen ? (screen.worldPose ?? null) : (description.wholeWorldPose ?? null);
    const existing = desktops.get(key);
    if (existing) {
      existing.inputAllowed = inputAllowed;
      existing.worldPose = worldPose;
      if (screen?.region) existing.region = screen.region;
      continue;
    }
    desktops.set(key, {
      key,
      // `DISPLAY2` is Windows' own number for the monitor, as its settings show it.
      name: screen ? `${machine}${screen.name.match(/(\d+)$/)?.[1] ?? screen.index + 1}` : machine,
      kind: "monitor",
      source: id,
      machine,
      ...(screen ? { monitor: screen.index } : {}),
      region: screen?.region ?? null,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      input: description.input as ActorId | null,
      inputAllowed,
      worldPose,
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
  for (const win of windows) {
    const key = `${machine}:win:${win.id}`;
    const inputAllowed = win.input !== false;
    const worldPose = win.worldPose ?? null;
    const rawTitle = (win.title || win.app || win.id).trim();
    const shortTitle = rawTitle.length > 20 ? `${rawTitle.slice(0, 19)}…` : rawTitle;
    const existing = desktops.get(key);
    if (existing) {
      existing.name = `${machine} · ${shortTitle}`;
      existing.inputAllowed = inputAllowed;
      existing.worldPose = worldPose;
      existing.region = win.region ?? existing.region;
      if (win.width > 0 && existing.frames === 0) existing.width = win.width;
      if (win.height > 0 && existing.frames === 0) existing.height = win.height;
      continue;
    }
    desktops.set(key, {
      key,
      name: `${machine} · ${shortTitle}`,
      kind: "window",
      source: id,
      machine,
      windowId: win.id,
      region: win.region ?? null,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      input: description.input as ActorId | null,
      inputAllowed,
      worldPose,
      holders: holders.get(key) ?? new Set<string>(),
      overlay: null,
      feed: null,
      width: win.width ?? 0,
      height: win.height ?? 0,
      frames: 0,
      starting: false,
      retryAt: 0,
      releaseAt: null,
      error: null,
    });
  }
  const sound = sounds.get(machine);
  if (description.audio && (screens.length > 0 || windows.length > 0)) {
    if (!sound) {
      sounds.set(machine, {
        machine,
        source: id,
        player: null,
        starting: false,
        retryAt: 0,
        quietSince: null,
        error: null,
        log: [],
      });
    }
  } else if (sound) {
    stopSound(sound);
    sounds.delete(machine);
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
    const which = desktop.windowId
      ? { window: desktop.windowId }
      : desktop.monitor === undefined
      ? null
      : { monitor: desktop.monitor };
    let feed = await request<FeedInfo | null>(desktop.source, "FEED", which);
    // Starting may wait for that machine's user to share the screen.
    feed ??= await request<FeedInfo>(desktop.source, "START", which);
    desktop.crop = feed.crop ?? { x: 0, y: 0, width: 1, height: 1 };
    if (desktop.overlay) {
      const health = await withTimeout(
        PostMan.PostMessage(
          { target: desktop.overlay, type: "__HEALTH__", payload: null },
          true,
        ) as Promise<
          {
            running: boolean;
            starting: boolean;
            frames: number;
            width: number;
            height: number;
            lastError: string | null;
          }
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
        forDisplay: true,
      },
    }, true);
    void watchFirstFrame(desktop, desktop.overlay);
  } catch (error) {
    desktop.error = String(error instanceof Error ? error.message : error);
    desktop.retryAt = Date.now() + RETRY_MS;
    report(`${desktop.key}: ${desktop.error}`);
  } finally {
    desktop.starting = false;
  }
}

/** Discovery on its own: a source that does not answer must not hold up the shown desktops. */
async function rediscover(): Promise<void> {
  if (discovering) return;
  discovering = true;
  try {
    await discover();
  } finally {
    discovering = false;
  }
  summarize();
}

/** List a new overlay as soon as it has a picture, rather than at the next poll. */
async function watchFirstFrame(desktop: Desktop, overlay: ActorId): Promise<void> {
  const deadline = Date.now() + FIRST_FRAME_WAIT_MS;
  while (desktop.overlay === overlay && Date.now() < deadline) {
    const health = await withTimeout(
      PostMan.PostMessage({ target: overlay, type: "__HEALTH__", payload: null }, true) as Promise<
        { frames: number; width: number; height: number }
      >,
      2000,
      "overlay health",
    ).catch(() => null);
    if (desktop.overlay !== overlay) return;
    if (health && health.frames > 0) {
      desktop.frames = health.frames;
      desktop.width = health.width;
      desktop.height = health.height;
      desktop.error = null;
      summarize();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, FIRST_FRAME_POLL_MS));
  }
}

async function poll(): Promise<void> {
  void rediscover();
  if (polling) return;
  polling = true;
  try {
    await Promise.all([
      ...[...desktops.values()].map((desktop) => keep(desktop)),
      ...[...sounds.values()].map((sound) => keepSound(sound)),
    ]);
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
      kind: d.kind,
      ...(d.windowId ? { windowId: d.windowId } : {}),
      priority: -1,
      logicalX: 0,
      logicalY: 0,
      logicalWidth: sized ? d.width : 1920,
      logicalHeight: sized ? d.height : 1080,
      crop: d.crop,
      household: { desktop: d.key, provider: state.id },
      ...(d.worldPose ? { worldPose: d.worldPose } : {}),
      ...(running ? { overlayHostActor: d.overlay! } : {}),
      ...(running && d.input && d.inputAllowed
        ? { inputActor: d.input }
        : { input: "none" as const }),
      ...(d.error ? { error: d.error } : {}),
    };
  });
}

function ensurePolling(): void {
  if (timer) return;
  state.enabled = true;
  timer = setInterval(() => void poll(), POLL_MS);
}

new PostMan(
  state,
  {
    __INIT__: async () => {
      const secret = householdSecret();
      if (!secret) return;
      householdClient = new HouseholdClient(secret);
      state.topic = await householdTopic(secret);
      PostMan.setTopic(state.topic);
      ensurePolling();
      void poll();
    },
    __HEALTH__: () => ({ ...state, peerSources: peerSources.size }),
    /** Register a trusted VRChat peer's displayShare actor + capability token. */
    ADDPEERSOURCE: (payload: { source: ActorId; proof: string; label?: string }) => {
      if (!payload?.source || !payload?.proof) return false;
      const key = String(payload.source);
      peerSources.set(key, { proof: payload.proof, label: payload.label });
      quiet.delete(key);
      described.delete(key);
      ensurePolling();
      void rediscover();
      return true;
    },
    /** Remove a VRChat peer's displayShare actor (peer left or was untrusted). */
    REMOVEPEERSOURCE: (payload: { source: ActorId }) => {
      if (!payload?.source) return false;
      const key = String(payload.source);
      const existed = peerSources.delete(key);
      described.delete(key);
      quiet.delete(key);
      for (const [dKey, desktop] of desktops) {
        if (desktop.source === payload.source) forget(dKey);
      }
      for (const [machine, sound] of sounds) {
        if (sound.source === payload.source) {
          stopSound(sound);
          sounds.delete(machine);
        }
      }
      summarize();
      return existed;
    },
    LIST: () => outputs(),
    /** Each shown desktop with its sharer and pose, for peer probes (classes/peerProbe.ts). */
    DESCRIBEPOSES: () =>
      [...desktops.values()].map((d) => ({
        key: d.key,
        name: d.name,
        kind: d.kind,
        source: String(d.source),
        ...(d.monitor != null ? { monitor: d.monitor } : {}),
        ...(d.windowId ? { windowId: d.windowId } : {}),
        worldPose: d.worldPose,
      })),
    /** Lightweight real-time pose snapshot for the scene's 20 Hz pose loop. */
    GETPOSES: () =>
      [...desktops.values()]
        .filter((d) => d.worldPose != null)
        .map((d) => ({ id: `household:${d.key}`, worldPose: d.worldPose! })),
    /** Real-time pose push from a sharer's displayShare over Iroh (works over relay). */
    POSEUPDATE: (payload: {
      source?: string;
      kind?: "monitor" | "window";
      windowId?: string;
      name?: string;
      monitor?: number;
      worldPose?: SharedDisplayWorldPose;
    }) => {
      const pose = payload?.worldPose;
      if (!payload?.source || !pose) return false;
      for (const desktop of desktops.values()) {
        if (String(desktop.source) !== payload.source) continue;
        const match = payload.kind === "window"
          ? desktop.kind === "window" && desktop.windowId === payload.windowId
          : desktop.kind === "monitor" && (
            (payload.monitor != null && desktop.monitor === payload.monitor) ||
            (payload.monitor == null && desktop.monitor == null) ||
            desktops.size === 1
          );
        if (!match) continue;
        desktop.worldPose = {
          position: [...pose.position],
          rotation: [...pose.rotation],
          scale: [...pose.scale],
          updatedAt: Date.now(),
        };
        return true;
      }
      return false;
    },
    /** A display (spatial node id) shows this desktop. */
    SHOW: (payload: { desktop: string; display: string }) => {
      const desktop = desktops.get(payload?.desktop);
      if (!desktop) return false;
      desktop.holders.add(String(payload.display));
      desktop.releaseAt = null;
      // Now, not at the next poll.
      void keep(desktop).then(summarize);
      const sound = sounds.get(desktop.machine);
      if (sound) void keepSound(sound).then(summarize);
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
    /** Push a viewer's updated VRChat world pose back to the sharer (two-way pose sync). */
    SETPOSE: async (payload: { desktop: string; worldPose: SharedDisplayWorldPose }) => {
      const desktop = desktops.get(payload?.desktop);
      if (!desktop || !payload?.worldPose) return false;
      desktop.worldPose = payload.worldPose;
      try {
        return await request<boolean>(
          desktop.source,
          "SETPOSE",
          {
            kind: desktop.kind,
            ...(desktop.windowId ? { windowId: desktop.windowId } : {}),
            ...(desktop.monitor != null ? { monitor: desktop.monitor } : {}),
            viewer: state.id,
            worldPose: payload.worldPose,
          },
          3_000,
        );
      } catch {
        return false;
      }
    },
    /**
     * The input target for a shown desktop: its desktopInput, the proof it takes, and for a
     * monitor the region of the virtual desktop its positions map into.
     */
    INPUTTARGET: async (payload: { desktop: string }) => {
      const desktop = desktops.get(payload?.desktop);
      if (!desktop?.input || !desktop.inputAllowed) return null;
      const peer = peerSources.get(String(desktop.source));
      if (!peer && !householdClient?.active) return null;
      const proof = peer ? peer.proof : await householdClient!.proof(String(desktop.input));
      const focusProof = desktop.windowId
        ? (peer ? peer.proof : await householdClient!.proof(String(desktop.source)))
        : undefined;
      return {
        actor: desktop.input,
        proof,
        ...(desktop.region ? { region: desktop.region } : {}),
        ...(desktop.windowId
          ? { focusSource: desktop.source, focusWindow: desktop.windowId, focusProof }
          : {}),
      };
    },
    __SHUTDOWN__: async () => {
      if (timer) clearInterval(timer);
      timer = null;
      for (const sound of sounds.values()) stopSound(sound);
      sounds.clear();
      await Promise.all([...desktops.values()].map((desktop) => stopOverlay(desktop)));
      desktops.clear();
    },
  } as const,
);
