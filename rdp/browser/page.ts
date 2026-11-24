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
import { PostalService, Transport } from "../../submodules/stageforge/mod.ts";
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

async function fetchSessionFromSite(): Promise<{ id: string; secret: string } | null> {
  const sessionUrl = new URL("./session", location.href).href;
  const tryPost = async (password: string) => {
    const res = await fetch(sessionUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json() as { id?: unknown; secret?: unknown };
      if (typeof data.id === "string" && typeof data.secret === "string") {
        return { id: data.id, secret: data.secret };
      }
    }
    return null;
  };

  let res: Response;
  try {
    res = await fetch(sessionUrl, { cache: "no-store" });
  } catch {
    return null;
  }
  if (res.ok) {
    const data = await res.json() as { id?: unknown; secret?: unknown };
    if (typeof data.id === "string" && typeof data.secret === "string") {
      return { id: data.id, secret: data.secret };
    }
    return null;
  }
  if (res.status !== 401) return null;

  // Password-protected site: try saved password for this tab first, otherwise show prompt.
  const saved = sessionStorage.getItem("petplay_rdp_password");
  if (saved) {
    const creds = await tryPost(saved);
    if (creds) return creds;
    sessionStorage.removeItem("petplay_rdp_password");
  }

  return await new Promise<{ id: string; secret: string }>((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;" +
      "background:#0f1218;z-index:9999;font-family:system-ui,sans-serif;color:#f1f5f9;";
    const form = document.createElement("form");
    form.style.cssText =
      "display:flex;flex-direction:column;gap:12px;padding:24px;border-radius:12px;" +
      "background:#181c24;border:1px solid #2f3747;min-width:280px;";
    const title = document.createElement("div");
    title.textContent = "PetPlay RDP";
    title.style.cssText = "font-size:16px;font-weight:600;";
    const input = document.createElement("input");
    input.type = "password";
    input.placeholder = "Password";
    input.autocomplete = "current-password";
    input.style.cssText =
      "padding:8px 10px;border-radius:6px;border:1px solid #334155;" +
      "background:#0f172a;color:#f8fafc;font-size:14px;outline:none;";
    const err = document.createElement("div");
    err.style.cssText = "color:#f87171;font-size:12px;min-height:16px;";
    const btn = document.createElement("button");
    btn.type = "submit";
    btn.textContent = "Connect";
    btn.style.cssText =
      "padding:8px 12px;border-radius:6px;border:none;background:#3b82f6;" +
      "color:#fff;font-size:14px;font-weight:500;cursor:pointer;";
    form.append(title, input, err, btn);
    overlay.append(form);
    document.body.append(overlay);
    input.focus();

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      btn.disabled = true;
      const pw = input.value;
      const creds = await tryPost(pw);
      btn.disabled = false;
      if (creds) {
        sessionStorage.setItem("petplay_rdp_password", pw);
        overlay.remove();
        resolve(creds);
      } else {
        err.textContent = "Wrong password";
        input.select();
      }
    });
  });
}

async function main(): Promise<void> {
  const session = parsed ?? await fetchSessionFromSite();
  if (!session) {
    show("Open this page with the session link (…/#<id>.<secret>).");
    return;
  }
  const { id, secret } = session;
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
  const liaison = await postal.add("./liaison.js");

  const canvas = document.getElementById("tab") as HTMLCanvasElement;
  const offscreen = canvas.transferControlToOffscreen();
  let bridgePort: MessagePort | null = null;
  const webrtcPeers = new Map<string, { pc: RTCPeerConnection; stop(): void }>();
  const postWebRtc = (event: PageWebRtcEvent, transfer: Transferable[] = []) =>
    bridgePort?.postMessage(event, transfer);

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

  Transport.accept("page.bridge", (transport) => {
    const port = transport.connection as MessagePort;
    bridgePort = port;
    port.onmessage = (event) => {
      const message = event.data as ToPage | PageWebRtcCommand;
      if ("webrtc" in message) {
        void handleWebRtc(message);
        return;
      }
      if (message.status) show(message.status === "connected" ? "" : message.status);
    };
  });
  const send = (dom: TabDomEvent) => bridgePort?.postMessage({ dom });

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
  addEventListener("resize", () => bridgePort?.postMessage({ viewport: viewport() }));

  await postal.PostMessage({
    target: client,
    type: "ATTACH",
    payload: {
      canvas: offscreen,
      viewport: viewport(),
      topic,
      secret,
      search: location.search,
      liaison,
    },
    transfer: [offscreen],
  } as never, true);

  await postal.PostMessage({
    target: liaison,
    type: "START",
    payload: { role: "client", topic, secret, consumers: [client] },
  }, true);
}

main().catch((error) => {
  console.error(error);
  show(`failed: ${error}`);
});
