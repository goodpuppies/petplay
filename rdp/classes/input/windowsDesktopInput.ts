/**
 * Windows injection: `SendInput`, through the same functions the VR scene used directly
 * (`displayInstance/mouse.ts`, `keyboard/win32SystemKeyboard.ts`). Positions are absolute over
 * the virtual desktop, as on Linux.
 */
import {
  createWindowsSystemDisplayMouseSink,
  type DisplayMouseSink,
  releaseWindowsSyntheticDisplayMouseState,
} from "../../../classes/environment/displayInstance/mouse.ts";
import {
  createWindowsSystemKeyboardSink,
  releaseWindowsSyntheticKeyboardState,
} from "../../../classes/environment/keyboard/win32SystemKeyboard.ts";
import type { KeyboardSink } from "../../../classes/environment/keyboard/types.ts";
import { type InputEvent, toKeyboardLogicEvent } from "./inputEvent.ts";
import type { DesktopInjector, InjectorStatus } from "./injector.ts";

export class WindowsDesktopInput implements DesktopInjector {
  readonly status: InjectorStatus = { running: true, lastError: null };
  #mouse: DisplayMouseSink = createWindowsSystemDisplayMouseSink();
  #keyboard: KeyboardSink = createWindowsSystemKeyboardSink();
  #at = { x: 0.5, y: 0.5 };

  inject(event: InputEvent): void {
    switch (event.t) {
      case "pointer":
        this.#at = { x: event.x, y: event.y };
        this.#mouse({ kind: "move", ...this.#at });
        return;
      case "button":
        if (event.x !== undefined && event.y !== undefined) this.#at = { x: event.x, y: event.y };
        this.#mouse({ kind: "button", button: event.button, pressed: event.down, ...this.#at });
        return;
      case "wheel":
        if (event.x !== undefined && event.y !== undefined) this.#at = { x: event.x, y: event.y };
        this.#mouse({ kind: "wheel", deltaY: event.delta, ...this.#at });
        return;
      case "key":
      case "modifier":
        this.#keyboard(toKeyboardLogicEvent(event));
        return;
    }
  }

  /** Release what the OS still reports held, beyond what the actor tracked. */
  async releaseAll(): Promise<void> {
    await releaseWindowsSyntheticDisplayMouseState();
    await releaseWindowsSyntheticKeyboardState();
  }

  close(): Promise<void> {
    return this.releaseAll();
  }
}
