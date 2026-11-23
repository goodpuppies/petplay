/**
 * inputRouter: long-lived input multiplexer actor.
 *
 * Accepts `rdp.input` (`messageport`) transports from `compositor` (or `ui`), maps per-window
 * pointer `(u,v)` through window `region` and titlebar trim, and dispatches to:
 * - local `desktopInput` via a lazily-opened `rdp.input` (`messageport`) transport, or
 * - remote `desktopInput` via `GUARDED INPUT` over iroh (`HouseholdClient`).
 *
 * Automatically releases held keys/buttons when focus switches between targets, when a UI
 * transport disconnects, or on `RELEASEALL`.
 */
import {
  type ActorId,
  actorState,
  messages,
  PostMan,
  Transport,
  type TransportMessages,
} from "../submodules/stageforge/mod.ts";
import { HouseholdClient } from "./classes/household.ts";
import type { InputEvent, InputRegion } from "./desktopInput.ts";

export type InputRouterStart = {
  household?: { secret: string; topic: string };
};

export type RoutedInput = {
  inputActor: ActorId;
  local: boolean;
  guarded?: boolean;
  region?: InputRegion;
  windowSize?: { width: number; height: number };
  feedSize?: { width: number; height: number };
  /** Optional window to focus on primary button press. */
  focus?: { source: ActorId; window: string; guarded?: boolean };
  event: InputEvent;
};

const state = actorState({
  name: "rdp-input-router",
  events: 0,
  activeTarget: null as string | null,
  lastError: null as string | null,
});

let household = new HouseholdClient(null);
const localPorts = new Map<ActorId, TransportMessages>();
const openingPorts = new Map<ActorId, Promise<TransportMessages | null>>();
let activeTarget: { actor: ActorId; local: boolean; guarded: boolean } | null = null;

const post = (msg: { target: string; type: string; payload: unknown }, wait: true) =>
  PostMan.PostMessage(msg, wait);

/** Map window-local pointer coordinates (0..1) into virtual-desktop coordinates (0..1). */
export function mapWindowPointer(frame: RoutedInput): InputEvent {
  const { event, region, windowSize, feedSize } = frame;
  if (!region || event.t !== "pointer") return event;
  let ry = region.y;
  let rh = region.height;
  // When KWin/WGC streams only the client area while window geometry includes the top titlebar,
  // trim the top of `region` by the logical height difference (anchored at the bottom edge).
  if (
    feedSize && windowSize && windowSize.width > 0 && windowSize.height > 0 &&
    feedSize.width > 0 && feedSize.height > 0
  ) {
    const scaleX = feedSize.width / windowSize.width;
    const logicalFeedH = feedSize.height / scaleX;
    const titlebarLogical = windowSize.height - logicalFeedH;
    if (titlebarLogical > 2 && titlebarLogical < 120) {
      const trimFrac = titlebarLogical / windowSize.height;
      ry += trimFrac * rh;
      rh *= 1 - trimFrac;
    }
  }
  return {
    t: "pointer",
    x: Math.min(1, Math.max(0, region.x + event.x * region.width)),
    y: Math.min(1, Math.max(0, ry + event.y * rh)),
  };
}

async function getLocalPort(actor: ActorId, guarded: boolean): Promise<TransportMessages | null> {
  const existing = localPorts.get(actor);
  if (existing && !existing.isClosed) return existing;
  const pending = openingPorts.get(actor);
  if (pending) return await pending;
  const opening = (async () => {
    try {
      const params = guarded && household.active ? { proof: await household.proof(actor) } : {};
      const opened = messages(await Transport.open(actor, { purpose: "rdp.input", params }));
      localPorts.set(actor, opened);
      opened.onclose = () => {
        if (localPorts.get(actor) === opened) localPorts.delete(actor);
      };
      return opened;
    } catch (error) {
      state.lastError = `local input ${actor}: ${error}`;
      return null;
    }
  })().finally(() => openingPorts.delete(actor));
  openingPorts.set(actor, opening);
  return await opening;
}

async function releaseTarget(target: { actor: ActorId; local: boolean; guarded: boolean }): Promise<void> {
  await household.request(post, target.actor, "RELEASEALL", null, target.guarded).catch(() => {});
}

async function releaseAll(): Promise<true> {
  const prev = activeTarget;
  activeTarget = null;
  state.activeTarget = null;
  if (prev) await releaseTarget(prev);
  return true;
}

async function route(frame: RoutedInput): Promise<void> {
  if (!frame?.inputActor || !frame?.event) return;
  const guarded = frame.guarded ?? household.active;
  if (activeTarget && activeTarget.actor !== frame.inputActor) {
    void releaseTarget(activeTarget);
  }
  activeTarget = { actor: frame.inputActor, local: frame.local, guarded };
  state.activeTarget = frame.inputActor;

  if (frame.event.t === "button" && frame.event.down && frame.focus) {
    const focusGuarded = frame.focus.guarded ?? household.active;
    void household.request(
      post,
      frame.focus.source,
      "FOCUSWINDOW",
      { window: frame.focus.window },
      focusGuarded,
    ).catch(() => {});
  }

  const mapped = mapWindowPointer(frame);
  state.events++;
  if (frame.local) {
    const port = await getLocalPort(frame.inputActor, guarded);
    if (port && !port.isClosed) port.send(mapped);
  } else {
    void household.request(post, frame.inputActor, "INPUT", mapped, guarded).catch(() => {});
  }
}

async function stop(): Promise<void> {
  await releaseAll();
  for (const port of localPorts.values()) port.close("inputRouter stopped");
  localPorts.clear();
}

new PostMan(
  state,
  {
    __INIT__: () => {
      Transport.accept("rdp.input", (transport) => {
        const channel = messages(transport);
        channel.onmessage = (raw) => {
          void route(raw as RoutedInput);
        };
        channel.onclose = () => {
          void releaseAll();
        };
      });
    },
    __HEALTH__: () => ({ ...state, localConnections: localPorts.size }),
    START: (payload: InputRouterStart = {}) => {
      household = new HouseholdClient(payload.household?.secret ?? null);
      if (payload.household) PostMan.setTopic(payload.household.topic);
      return true;
    },
    ROUTE: async (frame: RoutedInput) => {
      await route(frame);
      return true;
    },
    RELEASEALL: () => releaseAll(),
    __SHUTDOWN__: () => stop(),
  } as const,
);
