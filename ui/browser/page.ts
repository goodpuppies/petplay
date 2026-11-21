/// <reference lib="dom" />
/**
 * Main-thread page for the PetPlay UI preview: transfers the canvas to the client worker
 * (`client.ts`) and forwards viewport and DOM events over a MessageChannel, mirroring
 * `rdp/browser/page.ts`.
 */
import type { TabDomEvent, TabViewport } from "../../rdp/classes/tabProtocol.ts";
import type { ToPage } from "./client.ts";

const statusLine = document.getElementById("status")!;
const show = (text: string) => statusLine.textContent = text;

function viewport(): TabViewport {
  return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
}

const mods = (e: KeyboardEvent | MouseEvent) => ({
  shiftKey: e.shiftKey,
  ctrlKey: e.ctrlKey,
  altKey: e.altKey,
  metaKey: e.metaKey,
});

function main(): void {
  show("connecting…");
  const worker = new Worker("./client.js", { type: "module" });
  const canvas = document.getElementById("tab") as HTMLCanvasElement;
  const offscreen = canvas.transferControlToOffscreen();
  const { port1, port2 } = new MessageChannel();

  port1.onmessage = (event) => {
    const message = event.data as ToPage;
    if (message.status !== undefined) show(message.status === "connected" ? "" : message.status);
  };
  worker.onerror = (event) => {
    console.error("ui preview worker:", event);
    show(`worker error: ${event.message}`);
  };

  const send = (dom: TabDomEvent) => port1.postMessage({ dom });

  const pointer = (event: PointerEvent | MouseEvent) => {
    const p = event as PointerEvent;
    send({
      type: event.type as "pointermove",
      offsetX: event.offsetX,
      offsetY: event.offsetY,
      pointerId: p.pointerId ?? 1,
      pointerType: p.pointerType || "mouse",
      button: event.button,
      buttons: event.buttons,
      ...mods(event),
    });
  };
  for (
    const type of ["pointermove", "pointerup", "pointercancel", "pointerleave", "click", "dblclick"]
  ) {
    canvas.addEventListener(type, pointer as EventListener);
  }
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    canvas.focus();
    pointer(event);
  });
  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    pointer(event);
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    send({
      type: "wheel",
      offsetX: event.offsetX,
      offsetY: event.offsetY,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      ...mods(event),
    });
  }, { passive: false });
  for (const type of ["keydown", "keyup"] as const) {
    addEventListener(type, (raw) => {
      const event = raw as KeyboardEvent;
      if (!event.metaKey && !event.ctrlKey) event.preventDefault();
      send({ type, code: event.code, key: event.key, repeat: event.repeat, ...mods(event) });
    });
  }
  addEventListener("resize", () => port1.postMessage({ viewport: viewport() }));

  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${wsProto}//${location.host}/tab${location.search}`;

  worker.postMessage(
    { type: "ATTACH", canvas: offscreen, port: port2, viewport: viewport(), wsUrl },
    [offscreen, port2],
  );
}

try {
  main();
} catch (error) {
  console.error(error);
  show(`failed: ${error}`);
}
