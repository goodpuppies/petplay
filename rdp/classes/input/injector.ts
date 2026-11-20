/** A platform's way into the desktop. `desktopInput` validates, tracks held input, and releases. */
import type { InputEvent } from "./inputEvent.ts";

export type InjectorStatus = { running: boolean; lastError: string | null };

export interface DesktopInjector {
  readonly status: InjectorStatus;
  /** Inject one validated event. */
  inject(event: InputEvent): void;
  /** Extra platform cleanup after the actor released what it tracked. */
  releaseAll?(): Promise<void>;
  close(): Promise<void>;
}
