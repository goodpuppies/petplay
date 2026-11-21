/**
 * Which desktop the VR keyboard types into. The scene's keyboard goes to this machine's desktop
 * unless a display showing another machine's desktop was clicked last; clicking a display of this
 * machine's desktop takes it back. One scene per worker, so module state is enough.
 */
import type { KeyboardSink } from "./types.ts";

let focused: { owner: string; sink: KeyboardSink } | null = null;

/** `owner` (a display id) now takes the keyboard, or gives it back to the local desktop. */
export function focusKeyboard(owner: string, sink: KeyboardSink | null): void {
  focused = sink ? { owner, sink } : null;
}

/** Give the keyboard back if `owner` has it (its display closed or changed feed). */
export function releaseKeyboard(owner: string): void {
  if (focused?.owner === owner) focused = null;
}

/** Routes to the focused desktop's sink, else `local`. */
export function focusedKeyboard(local: KeyboardSink): KeyboardSink {
  return (event) => (focused?.sink ?? local)(event);
}
