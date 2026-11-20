/**
 * desktopInput: pointer and keyboard injection into this machine's desktop, as an actor.
 *
 * Runs `screen-streamer --input-only` (uinput on Linux) and feeds it the helper's stdin verbs,
 * so injection needs no capture session and no OpenVR. Callers send typed messages, or open a
 * negotiated channel (purpose `rdp.input`) for high-rate pointer motion that skips the hub.
 *
 * Coordinates are normalized 0..1 over the whole workspace (the helper's absolute pointer
 * device), which is what a client gets from a pointer position over a full-desktop capture.
 * Pressed buttons and keys are tracked and released on `RELEASEALL`, when a channel closes and on
 * shutdown, so a dropped client cannot leave a key held.
 *
 * Linux only for now; Windows injection exists in the scene (`SendInput` sinks) and would move
 * behind this same API.
 */
import { actorState, PostMan, Transport } from "../submodules/stageforge/mod.ts";
import { screenStreamerPath } from "./classes/helperPaths.ts";

export type InputEvent =
  | { t: "pointer"; x: number; y: number }
  | { t: "button"; button: "left" | "right" | "middle"; down: boolean }
  | { t: "wheel"; delta: number }
  | { t: "key"; scan: string; down: boolean };

const state = actorState({
  name: "desktopInput",
  helperRunning: false,
  events: 0,
  rejected: 0,
  lastError: null as string | null,
});

let helper: Deno.ChildProcess | null = null;
let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
const encoder = new TextEncoder();
const heldButtons = new Set<string>();
const heldKeys = new Set<string>();

function ensureHelper(): WritableStreamDefaultWriter<Uint8Array> {
  if (writer) return writer;
  if (Deno.build.os !== "linux") {
    throw new Error("desktopInput injects through uinput on Linux only");
  }
  const child = new Deno.Command(screenStreamerPath(), {
    args: ["--input-only"],
    stdin: "piped",
    stdout: "null",
    stderr: "piped",
  }).spawn();
  helper = child;
  writer = child.stdin.getWriter();
  state.helperRunning = true;
  void (async () => {
    for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream())) {
      const line = chunk.trim().split("\n").at(-1);
      if (line) state.lastError = line;
    }
  })().catch(() => {});
  void child.status.then(() => {
    if (helper !== child) return;
    helper = null;
    writer = null;
    state.helperRunning = false;
  });
  return writer;
}

function write(line: string): void {
  void ensureHelper().write(encoder.encode(`${line}\n`)).catch((error) => {
    state.lastError = String(error);
  });
}

const BUTTONS = new Set(["left", "right", "middle"]);
const SCAN = /^(?:e0)?[0-9a-f]{1,4}$/i;

/** Validate and inject one event. Returns false (and counts it) for a malformed event. */
export function inject(event: InputEvent): boolean {
  switch (event?.t) {
    case "pointer": {
      const { x, y } = event;
      if (!Number.isFinite(x) || !Number.isFinite(y)) break;
      write(`M,${Math.min(1, Math.max(0, x))},${Math.min(1, Math.max(0, y))}`);
      state.events++;
      return true;
    }
    case "button": {
      if (!BUTTONS.has(event.button) || typeof event.down !== "boolean") break;
      if (event.down) heldButtons.add(event.button);
      else heldButtons.delete(event.button);
      write(`B,${event.button},${event.down ? 1 : 0}`);
      state.events++;
      return true;
    }
    case "wheel": {
      const delta = Math.trunc(event.delta);
      if (!Number.isFinite(delta) || Math.abs(delta) > 100) break;
      write(`W,${delta}`);
      state.events++;
      return true;
    }
    case "key": {
      if (
        typeof event.scan !== "string" || !SCAN.test(event.scan) || typeof event.down !== "boolean"
      ) {
        break;
      }
      const scan = event.scan.toLowerCase();
      if (event.down) heldKeys.add(scan);
      else heldKeys.delete(scan);
      write(`K,${scan},${event.down ? 1 : 0}`);
      state.events++;
      return true;
    }
  }
  state.rejected++;
  return false;
}

export function releaseAll(): void {
  if (!writer && heldButtons.size === 0 && heldKeys.size === 0) return;
  for (const button of [...heldButtons]) {
    inject({ t: "button", button: button as "left", down: false });
  }
  for (const scan of [...heldKeys]) inject({ t: "key", scan, down: false });
}

new PostMan(
  state,
  {
    __INIT__: () => {
      Transport.accept("rdp.input", (channel) => {
        channel.onmessage = (event) => {
          inject(event as InputEvent);
        };
        channel.onclose = () => releaseAll();
      });
    },
    __HEALTH__: () => ({ ...state, heldButtons: [...heldButtons], heldKeys: [...heldKeys] }),
    INPUT: (event: InputEvent) => inject(event),
    INPUTS: (events: InputEvent[]) => events.filter((event) => inject(event)).length,
    RELEASEALL: () => {
      releaseAll();
      return true;
    },
    __SHUTDOWN__: async () => {
      releaseAll();
      const child = helper;
      const open = writer;
      helper = null;
      writer = null;
      await open?.close().catch(() => {});
      await child?.status;
      state.helperRunning = false;
    },
  } as const,
);
