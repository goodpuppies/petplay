/**
 * X11 window lookup for the lab: OBS's Xcomposite source pointing at VRChat and PetPlay's GLFW
 * windows. The lookup itself lives in `classes/x11Windows.ts`.
 */
import type { X11Window } from "../../classes/x11Windows.ts";
export { findX11Window, listX11Windows, type X11Window } from "../../classes/x11Windows.ts";

/** OBS `xcomposite_input` `capture_window` value: id, name and class separated by CRLF. */
export function obsXcompositeWindow(window: X11Window): string {
  return `${window.id}\r\n${window.name}\r\n${window.cls}`;
}
