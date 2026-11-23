/// <reference lib="dom" />
/**
 * The RDP page: this tab's stageforge process. Like PetPlay's main thread it only does what must
 * happen here: start the PostalService (with the browser's iroh carrier and the topic server),
 * spawn the client actor (`client.ts`), and hand it the canvas and the DOM.
 *
 * URL: `index.html#<session secret>`. The fragment is never sent to the server hosting this page;
 * the client actor derives the session's topic from it (rdp/classes/session.ts). Query options: `topics=` (topic server, default
 * wss://topic.petplay.fi), `relay=` (an iroh relay instead of n0's), and the media receiver's
 * (`buffer=`, `software`).
 */
import { PostalService } from "../../submodules/stageforge/mod.ts";
import { irohWebCarrier, type IrohWebModule } from "../../classes/irohWebCarrier.ts";
import { parseSessionFragment, sessionTopic } from "../classes/session.ts";
import type { TabDomEvent, TabViewport } from "../classes/tabProtocol.ts";
import type { PageWebRtcCommand, PageWebRtcEvent } from "../classes/webRtcVideoTransport.ts";
import type { ToPage } from "./client.ts";

const params = new URLSearchParams(location.search);
const parsed = parseSessionFragment(location.hash.slice(1));
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

async function main(): Promise<void> {
  if (!parsed) {
    show("Open this page with the session link (…/#<id>.<secret>).");
    return;
  }
  const { id, secret } = parsed;
  const topic = sessionTopic(id);
  show("starting…");
  // Loaded at runtime, not bundled: wasm-bindgen's module fetches its .wasm next to itself.
  const wasmUrl = new URL("./link/petplay_link_web.js", location.href).href;
  const wasm = await import(wasmUrl) as IrohWebModule & { default(): Promise<unknown> };
  await wasm.default();

  const postal = new PostalService();
  postal.registerRemoteCarrier(irohWebCarrier(wasm, { relay: params.get("relay") ?? undefined }));
  postal.initSignalingClient(params.get("topics") ?? "wss://topic.petplay.fi");
  const client = await postal.add("./client.js");

  const canvas = document.getElementById("tab") as HTMLCanvasElement;
  const offscreen = canvas.transferControlToOffscreen();
  const { port1, port2 } = new MessageChannel();
  const webrtcPeers = new Map<string, { pc: RTCPeerConnection; stop(): void }>();
  const postWebRtc = (event: PageWebRtcEvent, transfer: Transferable[] = []) =>
    port1.postMessage(event, transfer);

  function closeWebRtc(id: string): void {
    const peer = webrtcPeers.get(id);
    if (!peer) return;
    webrtcPeers.delete(id);
    peer.stop();
  }

  async function handleWebRtc(cmd: PageWebRtcCommand): Promise<void> {
    if (cmd.webrtc === "close") {
      closeWebRtc(cmd.id);
      return;
    }
    if (cmd.webrtc === "answer") {
      const peer = webrtcPeers.get(cmd.id);
      if (!peer) return;
      try {
        await peer.pc.setRemoteDescription({ type: "answer", sdp: cmd.sdp });
      } catch (error) {
        closeWebRtc(cmd.id);
        postWebRtc({ webrtc: "error", id: cmd.id, error: String(error) });
      }
      return;
    }
    // cmd.webrtc === "offer": create RTCPeerConnection + hidden <video> on the main thread.
    closeWebRtc(cmd.id);
    const { id, feed } = cmd;
    const pc = new RTCPeerConnection();
    const video = document.createElement("video");
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    let stopped = false;
    let pumping = false;
    let lastWidth = 0;
    let lastHeight = 0;

    const pump = () => {
      if (stopped) return;
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (w > 0 && h > 0) {
        if (w !== lastWidth || h !== lastHeight) {
          lastWidth = w;
          lastHeight = h;
          postWebRtc({ webrtc: "size", id, feed, width: w, height: h });
        }
        if (!pumping) {
          pumping = true;
          createImageBitmap(video).then(
            (bitmap) => {
              pumping = false;
              if (stopped) bitmap.close();
              else postWebRtc({ webrtc: "frame", id, feed, bitmap }, [bitmap]);
            },
            () => {
              pumping = false;
            },
          );
        }
      }
      const rvfc = (video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
      }).requestVideoFrameCallback;
      if (rvfc) rvfc.call(video, pump);
      else requestAnimationFrame(pump);
    };

    const stop = () => {
      if (stopped) return;
      stopped = true;
      video.pause();
      video.srcObject = null;
      pc.close();
    };
    webrtcPeers.set(id, { pc, stop });

    pc.ontrack = (event) => {
      if (stopped) return;
      video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void video.play().catch(() => {});
      pump();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        closeWebRtc(id);
        postWebRtc({ webrtc: "closed", id, reason: `webrtc ${pc.connectionState}` });
      }
    };

    try {
      pc.addTransceiver("video", { direction: "recvonly" });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (pc.iceGatheringState !== "complete") {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 250);
          const onChange = () => {
            if (pc.iceGatheringState === "complete") {
              clearTimeout(timer);
              pc.removeEventListener("icegatheringstatechange", onChange);
              resolve();
            }
          };
          pc.addEventListener("icegatheringstatechange", onChange);
        });
      }
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error("RTCPeerConnection produced no local SDP");
      postWebRtc({ webrtc: "offer", id, sdp });
    } catch (error) {
      closeWebRtc(id);
      postWebRtc({ webrtc: "error", id, error: String(error) });
    }
  }

  port1.onmessage = (event) => {
    const message = event.data as ToPage | PageWebRtcCommand;
    if ("webrtc" in message) {
      void handleWebRtc(message);
      return;
    }
    if (message.status) show(message.status === "connected" ? "" : message.status);
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
  for (const type of ["pointermove", "pointerup", "pointercancel", "pointerleave", "click", "dblclick"]) {
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
      // Keys belong to the remote desktop while the page has focus, not to the page.
      if (!event.metaKey) event.preventDefault();
      send({ type, code: event.code, key: event.key, repeat: event.repeat, ...mods(event) });
    });
  }
  addEventListener("resize", () => port1.postMessage({ viewport: viewport() }));

  await postal.PostMessage({
    target: client,
    type: "ATTACH",
    payload: {
      canvas: offscreen,
      port: port2,
      viewport: viewport(),
      topic,
      secret,
      search: location.search,
    },
    transfer: [offscreen, port2],
  } as never, true);
}

main().catch((error) => {
  console.error(error);
  show(`failed: ${error}`);
});
