/** HTML pointers forwarded by pmndrs are prefixed (normally `screen-mouse`). */
export function isDesktopMousePointerType(pointerType: string): boolean {
  return pointerType === "mouse" || pointerType.endsWith("-mouse");
}
