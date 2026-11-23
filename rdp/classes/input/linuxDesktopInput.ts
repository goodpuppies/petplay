/**
 * Linux injection: `screen-streamer --input-only` (uinput: the "PetPlay Mouse" absolute workspace
 * pointer and "PetPlay Keyboard"), fed its stdin verbs. Keys and modifiers go through the VR
 * keyboard's Linux mapping (`createLinuxKeyboardSink`). A wheel at a position first tries a
 * discrete X11 wheel, for X11/Xwayland apps that ignore uinput's high-resolution wheel.
 */
import { type ActorId, PostMan } from "../../../submodules/stageforge/mod.ts";
import { createLinuxKeyboardSink } from "../../../classes/environment/keyboard/linuxSystemKeyboard.ts";
import { tryLinuxX11Scroll } from "../../../classes/environment/displayInstance/linuxX11Scroll.ts";
import type { KeyboardSink } from "../../../classes/environment/keyboard/types.ts";
import { screenStreamerPath } from "../helperPaths.ts";
import { ensureScreenStreamer } from "../screenStreamerActor.ts";
import { type InputEvent, toKeyboardLogicEvent } from "./inputEvent.ts";
import type { DesktopInjector, InjectorStatus } from "./injector.ts";

export type LinuxDesktopInputOptions = {
  /** Try the discrete X11 wheel first. Default: on when DISPLAY is set. */
  x11Wheel?: boolean;
};

export class LinuxDesktopInput implements DesktopInjector {
  readonly status: InjectorStatus = { running: false, lastError: null };
  #helper: Deno.ChildProcess | null = null;
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #streamer: Promise<ActorId> | null = null;
  #encoder = new TextEncoder();
  #keyboard: KeyboardSink = createLinuxKeyboardSink((command) => this.#write(command));
  #x11Wheel: boolean;

  constructor(options: LinuxDesktopInputOptions = {}) {
    this.#x11Wheel = options.x11Wheel ?? !!Deno.env.get("DISPLAY");
  }

  inject(event: InputEvent): void {
    switch (event.t) {
      case "pointer":
        this.#move(event.x, event.y);
        return;
      case "button":
        if (event.x !== undefined && event.y !== undefined) this.#move(event.x, event.y);
        this.#write(`B,${event.button},${event.down ? 1 : 0}`);
        return;
      case "wheel":
        if (event.x !== undefined && event.y !== undefined) {
          if (this.#x11Wheel && tryLinuxX11Scroll(event.delta, event.x, event.y)) return;
          this.#move(event.x, event.y);
        }
        this.#write(`W,${event.delta}`);
        return;
      case "key":
      case "modifier":
        this.#keyboard(toKeyboardLogicEvent(event));
        return;
    }
  }

  async close(): Promise<void> {
    const child = this.#helper;
    const writer = this.#writer;
    this.#helper = null;
    this.#writer = null;
    this.#streamer = null;
    await writer?.close().catch(() => {});
    await child?.status;
    this.status.running = false;
  }

  #move(x: number, y: number): void {
    this.#write(`M,${Math.min(1, Math.max(0, x))},${Math.min(1, Math.max(0, y))}`);
  }

  #write(lines: string): void {
    // Test helpers (e.g. `.sh` scripts in `browser.test.ts`) read raw stdin verbs directly.
    const override = Deno.env.get("PETPLAY_SCREEN_STREAMER");
    if (override && !override.endsWith("screen-streamer")) {
      void this.#ensureLegacyTestHelper().write(this.#encoder.encode(`${lines}\n`)).catch((error) => {
        this.status.lastError = String(error);
      });
      return;
    }
    this.#streamer ??= ensureScreenStreamer().then((id) => {
      this.status.running = true;
      return id;
    }).catch((err) => {
      this.status.lastError = String(err);
      this.#streamer = null;
      throw err;
    });
    void this.#streamer.then((id) => {
      for (const line of lines.split("\n")) {
        if (!line) continue;
        PostMan.PostMessage({ target: id, type: "INPUT", payload: { line } });
      }
    }).catch(() => {});
  }

  #ensureLegacyTestHelper(): WritableStreamDefaultWriter<Uint8Array> {
    if (this.#writer) return this.#writer;
    const child = new Deno.Command(screenStreamerPath(), {
      args: ["--input-only"],
      stdin: "piped",
      stdout: "null",
      stderr: "piped",
    }).spawn();
    this.#helper = child;
    this.#writer = child.stdin.getWriter();
    this.status.running = true;
    void (async () => {
      for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream())) {
        const line = chunk.trim().split("\n").at(-1);
        if (line) this.status.lastError = line;
      }
    })().catch(() => {});
    void child.status.then(() => {
      if (this.#helper !== child) return;
      this.#helper = null;
      this.#writer = null;
      this.status.running = false;
    });
    return this.#writer;
  }
}
