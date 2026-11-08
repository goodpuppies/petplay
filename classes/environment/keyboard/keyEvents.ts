/**
 * Key activations and modifiers from the in-VR keyboard, for whoever wants to watch. Key-up
 * events go only to the sink; playtests can check that a press
 * landed, without reading the desktop it was typed into. The sink still does the typing.
 */
import type { KeyboardLogicEvent } from "./types.ts";

const listeners = new Set<(event: KeyboardLogicEvent) => void>();

export function onKeyboardEvent(listener: (event: KeyboardLogicEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitKeyboardEvent(event: KeyboardLogicEvent): void {
  for (const listener of listeners) listener(event);
}
