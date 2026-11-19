import type { SyntheticCanvas, SyntheticEventInit } from "./desktopPointerSurface.ts";

/** Raw viewport input. Coordinates are fractions of the displayed content, not page pixels. */
export type DesktopPointerMessage = {
  version: 1;
  viewport: string;
  sequence: number;
  type: "pointermove" | "pointerdown" | "pointerup" | "pointercancel" | "pointerleave" | "wheel";
  pointerId: number;
  pointerType: "mouse" | "touch" | "pen";
  x: number;
  y: number;
  button: number;
  buttons: number;
  deltaY?: number;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
};
let nextPointerId = 1000; // Local Raylib mouse is 1; each remote session gets independent identities.
const types = new Set([
  "pointermove",
  "pointerdown",
  "pointerup",
  "pointercancel",
  "pointerleave",
  "wheel",
]);
export class DesktopRemotePointer {
  private pointers = new Map<number, SyntheticEventInit>();
  /** Pointer ids this input has issued to its surface, for views sharing a scene (`desktopNavigation.ts`). */
  readonly issued = new Set<number>();
  private sequence = -1;
  constructor(private surface: SyntheticCanvas, readonly viewport = "desktop-control") {}
  receive(value: unknown): void {
    if (!value || typeof value !== "object") throw Error("Invalid pointer message");
    const m = value as DesktopPointerMessage;
    if (
      m.version !== 1 || m.viewport !== this.viewport || !Number.isSafeInteger(m.sequence) ||
      m.sequence <= this.sequence || !types.has(m.type) || !Number.isSafeInteger(m.pointerId) ||
      m.pointerId < 0 || !["mouse", "touch", "pen"].includes(m.pointerType) ||
      !Number.isFinite(m.x) || !Number.isFinite(m.y) || Math.abs(m.x) > 16 || Math.abs(m.y) > 16 ||
      !Number.isInteger(m.button) || m.button < -1 || m.button > 4 ||
      !Number.isInteger(m.buttons) || m.buttons < 0 || m.buttons > 31 ||
      (m.deltaY !== undefined && (!Number.isFinite(m.deltaY) || Math.abs(m.deltaY) > 100000))
    ) throw Error("Invalid pointer message or viewport");
    for (const key of ["ctrlKey", "shiftKey", "altKey", "metaKey"] as const) {
      if (m[key] !== undefined && typeof m[key] !== "boolean") throw Error("Invalid modifiers");
    }
    this.sequence = m.sequence;
    let previous = this.pointers.get(m.pointerId);
    if (!previous) {
      if (this.pointers.size >= 16) throw Error("Too many pointers");
      previous = { type: "pointerover", pointerId: nextPointerId++, pointerType: m.pointerType };
      this.issued.add(previous.pointerId!);
    }
    const rect = this.surface.getBoundingClientRect();
    const event: SyntheticEventInit = {
      type: m.type,
      pointerId: previous.pointerId,
      pointerType: m.pointerType,
      clientX: m.x * rect.width,
      clientY: m.y * rect.height,
      button: m.button,
      buttons: m.buttons,
      deltaY: m.deltaY ?? 0,
      ctrlKey: m.ctrlKey,
      shiftKey: m.shiftKey,
      altKey: m.altKey,
      metaKey: m.metaKey,
    };
    event.movementX = event.clientX! - (previous.clientX ?? event.clientX!);
    event.movementY = event.clientY! - (previous.clientY ?? event.clientY!);
    if (!this.pointers.has(m.pointerId)) {
      this.surface.dispatchSyntheticEvent({ ...event, type: "pointerover" });
    }
    this.pointers.set(m.pointerId, event);
    this.surface.dispatchSyntheticEvent(event);
    if (m.type === "pointercancel" || m.type === "pointerleave" && m.buttons === 0) {
      this.surface.releasePointerCapture(event.pointerId!);
      this.pointers.delete(m.pointerId);
    }
  }
  cancelPointer(id: number): void {
    const event = this.pointers.get(id);
    if (!event) return;
    this.surface.dispatchSyntheticEvent({ ...event, type: "pointercancel", buttons: 0 });
    this.surface.dispatchSyntheticEvent({ ...event, type: "pointerleave", buttons: 0 });
    this.surface.releasePointerCapture(event.pointerId!);
    this.pointers.delete(id);
  }
  /** Close, blur, lost connection, and viewport changes all cancel outstanding drags. */
  cancel(): void {
    for (const id of this.pointers.keys()) this.cancelPointer(id);
    this.pointers.clear();
  }
}
