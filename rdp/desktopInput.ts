/**
 * desktopInput: pointer and keyboard injection into this machine's desktop, as an actor. The one
 * injector every sender uses: the VR scene's displays and keyboard, an rdp tab, a peer.
 *
 * Events are `InputEvent`s (`classes/input/inputEvent.ts`); each platform injects through its own
 * class (`LinuxDesktopInput`: uinput helper; `WindowsDesktopInput`: `SendInput`). Needs no
 * capture session and no OpenVR. Callers send `INPUT` / `INPUTS`, or open a negotiated transport
 * (purpose `rdp.input`) for high-rate pointer motion that skips the hub.
 *
 * Pressed buttons, keys and latched modifiers are tracked and released on `RELEASEALL`, when a
 * transport closes and on shutdown, so a dropped sender cannot leave anything held.
 *
 * `PETPLAY_INPUT_X11_WHEEL=0` turns off the discrete X11 wheel (tests, so nothing scrolls the
 * real desktop).
 */
import { actorState, messages, PostMan, Transport } from "../submodules/stageforge/mod.ts";
import { type InputEvent, isInputEvent } from "./classes/input/inputEvent.ts";
import type { DesktopInjector } from "./classes/input/injector.ts";
import { LinuxDesktopInput } from "./classes/input/linuxDesktopInput.ts";
import { WindowsDesktopInput } from "./classes/input/windowsDesktopInput.ts";

export type { InputEvent } from "./classes/input/inputEvent.ts";

const state = actorState({
  name: "desktopInput",
  platform: Deno.build.os,
  helperRunning: false,
  events: 0,
  rejected: 0,
  lastError: null as string | null,
});

let injector: DesktopInjector | null = null;
const heldButtons = new Set<"left" | "right" | "middle">();
/** Held keys by identity, with the event that pressed them. */
const heldKeys = new Map<string, Extract<InputEvent, { t: "key" }>>();
const activeModifiers = new Set<Extract<InputEvent, { t: "modifier" }>["modifier"]>();

function platform(): DesktopInjector {
  if (injector) return injector;
  if (Deno.build.os === "linux") {
    injector = new LinuxDesktopInput({
      x11Wheel: Deno.env.get("PETPLAY_INPUT_X11_WHEEL") === "0" ? false : undefined,
    });
  } else if (Deno.build.os === "windows") {
    injector = new WindowsDesktopInput();
  } else {
    throw new Error(`desktopInput: no injector for ${Deno.build.os}`);
  }
  return injector;
}

const keyId = (e: Extract<InputEvent, { t: "key" }>) =>
  `${e.scan?.toLowerCase() ?? ""}|${e.key?.toUpperCase() ?? ""}|${e.char ?? ""}`;

/** Validate and inject one event. Returns false (and counts it) for a malformed event. */
export function inject(event: unknown): boolean {
  if (!isInputEvent(event)) {
    state.rejected++;
    return false;
  }
  switch (event.t) {
    case "button":
      if (event.down) heldButtons.add(event.button);
      else heldButtons.delete(event.button);
      break;
    case "key":
      if (event.down === true) heldKeys.set(keyId(event), event);
      else if (event.down === false) heldKeys.delete(keyId(event));
      break;
    case "modifier":
      if (event.modifier !== "caps") {
        if (event.active) activeModifiers.add(event.modifier);
        else activeModifiers.delete(event.modifier);
      }
      break;
  }
  try {
    const target = platform();
    target.inject(event);
    state.helperRunning = target.status.running;
    state.lastError = target.status.lastError;
  } catch (error) {
    state.lastError = String(error);
    return false;
  }
  state.events++;
  return true;
}

export async function releaseAll(): Promise<void> {
  for (const button of [...heldButtons]) inject({ t: "button", button, down: false });
  for (const key of [...heldKeys.values()]) inject({ ...key, down: false });
  for (const modifier of [...activeModifiers]) inject({ t: "modifier", modifier, active: false });
  await injector?.releaseAll?.();
}

new PostMan(
  state,
  {
    __INIT__: () => {
      Transport.accept("rdp.input", (transport) => {
        const input = messages(transport);
        input.onmessage = (event) => {
          inject(event);
        };
        input.onclose = () => void releaseAll();
      });
    },
    __HEALTH__: () => ({
      ...state,
      helperRunning: injector?.status.running ?? false,
      heldButtons: [...heldButtons],
      heldKeys: [...heldKeys.keys()],
      activeModifiers: [...activeModifiers],
    }),
    INPUT: (event: InputEvent) => inject(event),
    INPUTS: (events: InputEvent[]) =>
      Array.isArray(events) ? events.filter((event) => inject(event)).length : 0,
    RELEASEALL: async () => {
      await releaseAll();
      return true;
    },
    __SHUTDOWN__: async () => {
      await releaseAll();
      await injector?.close();
      injector = null;
      state.helperRunning = false;
    },
  } as const,
);
