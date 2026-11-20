/**
 * What a browser tab and the UI actor that renders for it say to each other over their
 * `rdp.ui` transport (stageforge's message layer on a WebSocket).
 *
 * Browser → UI actor: the tab's viewport, its DOM events as plain data, acks for scene deltas,
 * and what it learns about media feeds. UI actor → browser: scene store deltas (bytes), the
 * camera to draw them with, and the media feeds to receive.
 */

export const UI_PURPOSE = "rdp.ui";
/** Actor name of the UI actor; a tab picks its contact by this prefix. */
export const UI_ACTOR_NAME = "rdp-ui";

export type TabViewport = { width: number; height: number; dpr: number };

type Modifiers = { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean };

export type TabPointerEvent = Modifiers & {
  type:
    | "pointermove"
    | "pointerdown"
    | "pointerup"
    | "pointercancel"
    | "pointerleave"
    | "click"
    | "dblclick"
    | "contextmenu";
  offsetX: number;
  offsetY: number;
  pointerId: number;
  pointerType: string;
  button: number;
  buttons: number;
};

export type TabWheelEvent = Modifiers & {
  type: "wheel";
  offsetX: number;
  offsetY: number;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
};

export type TabKeyEvent = Modifiers & {
  type: "keydown" | "keyup";
  code: string;
  key: string;
  repeat: boolean;
};

export type TabDomEvent = TabPointerEvent | TabWheelEvent | TabKeyEvent;

export type FeedInfo = { host: string; port: number; fingerprint: string };

export type ToUi =
  | { viewport: TabViewport }
  | { dom: TabDomEvent }
  | { ack: number }
  | { resync: true }
  /** The intrinsic size of a feed, once the tab decodes it (like a video's loadedmetadata). */
  | { feedSize: { feed: string; width: number; height: number } };

export type ToTab =
  /** A scene store delta or snapshot (`encodeDelta`), as the message itself. */
  | Uint8Array
  | { camera: { projection: number[]; world: number[] } }
  | { media: { feeds: Record<string, FeedInfo> } };

const POINTER_TYPES = new Set([
  "pointermove",
  "pointerdown",
  "pointerup",
  "pointercancel",
  "pointerleave",
  "click",
  "dblclick",
  "contextmenu",
]);

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Accepts only well-formed events, so nothing else reaches the headless tab. */
export function isTabDomEvent(value: unknown): value is TabDomEvent {
  const event = value as Record<string, unknown> | null;
  if (!event || typeof event.type !== "string") return false;
  if (POINTER_TYPES.has(event.type)) {
    return finite(event.offsetX) && finite(event.offsetY) && finite(event.pointerId) &&
      finite(event.button) && finite(event.buttons) && typeof event.pointerType === "string";
  }
  if (event.type === "wheel") {
    return finite(event.offsetX) && finite(event.offsetY) && finite(event.deltaX) &&
      finite(event.deltaY) && finite(event.deltaMode);
  }
  if (event.type === "keydown" || event.type === "keyup") {
    return typeof event.code === "string" && typeof event.key === "string" &&
      event.code.length < 64 && event.key.length < 64;
  }
  return false;
}

export function isViewport(value: unknown): value is TabViewport {
  const v = value as Record<string, unknown> | null;
  return !!v && finite(v.width) && finite(v.height) && finite(v.dpr) && v.width >= 1 &&
    v.height >= 1 && v.width <= 16384 && v.height <= 16384 && v.dpr > 0 && v.dpr <= 8;
}
