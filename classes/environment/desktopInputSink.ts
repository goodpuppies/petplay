/**
 * The VR scene's desktop input: display mouse and keyboard events, as `InputEvent`s for a
 * `desktopInput` actor (`rdp/desktopInput.ts`), which injects them on its platform. The cursor
 * position the overlay host composites (`C,x,y`) still goes to that host, unsmoothed.
 */
import { PostMan } from "../../submodules/stageforge/mod.ts";
import { createSmoothedDisplayMouseSink, type DisplayMouseSink } from "./displayInstance/mouse.ts";
import type { KeyboardSink } from "./keyboard/types.ts";
import { fromKeyboardLogicEvent, type InputEvent } from "../../rdp/classes/input/inputEvent.ts";

function post(target: string, type: string, payload: unknown): void {
  try {
    PostMan.PostMessage({ target, type, payload });
  } catch {
    // The actor may be shutting down.
  }
}

export function createDesktopInputSinks(
  inputActor: string,
  /** The overlay host compositing the cursor (Linux), if any. */
  cursorActor: string | null,
  /** A household machine's desktopInput takes input only with its proof, in `GUARDED`. */
  proof?: string,
  /**
   * The shown monitor's rectangle on that machine's virtual desktop, as fractions: display
   * positions map into it (`ScreenInfo.region`, `rdp/desktopSource.ts`).
   */
  region?: { x: number; y: number; width: number; height: number },
): { mouse: DisplayMouseSink; keyboard: KeyboardSink } {
  const send = proof
    ? (event: InputEvent) => post(inputActor, "GUARDED", { proof, type: "INPUT", payload: event })
    : (event: InputEvent) => post(inputActor, "INPUT", event);
  const inject: DisplayMouseSink = (event) => {
    const x = region ? region.x + event.x * region.width : event.x;
    const y = region ? region.y + event.y * region.height : event.y;
    if (event.kind === "move") send({ t: "pointer", x, y });
    else if (event.kind === "button") {
      send({ t: "button", button: event.button, down: event.pressed, x, y });
    } else send({ t: "wheel", delta: event.deltaY, x, y });
  };
  // KDE's uinput pointer gets the smoothed path, as before; Windows always got raw motion.
  const smoothed = Deno.build.os === "linux" ? createSmoothedDisplayMouseSink(inject) : inject;
  const mouse: DisplayMouseSink = (event) => {
    // Keep the composited cursor pixel-exact with the VR ray.
    if (cursorActor) post(cursorActor, "INPUTCONTROL", `C,${event.x},${event.y}`);
    smoothed(event);
  };
  const keyboard: KeyboardSink = (event) => {
    const input = fromKeyboardLogicEvent(event);
    if (input) send(input);
  };
  return { mouse, keyboard };
}
