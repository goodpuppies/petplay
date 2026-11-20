/**
 * Test actor standing in for the browser's client actor: opens the `rdp.ui` WebSocket transport
 * to the UI actor, keeps a replica of its scene store (acking each delta), and sends DOM events.
 */
import {
  actorState,
  messages,
  PostMan,
  registerTransportKind,
  Transport,
  type TransportMessages,
  webSocketTransport,
} from "../../submodules/stageforge/mod.ts";
import {
  decodeDelta,
  SceneStore,
  StoreDivergence,
} from "../../submodules/raythree/src/store/mod.ts";
import type { TabDomEvent, TabViewport, ToTab } from "../classes/tabProtocol.ts";

const state = actorState({ name: "rdp-tab-client" });
const replica = new SceneStore();
let tab: TransportMessages | null = null;
let kind = "";
let deltas = 0;
let camera: unknown = null;
let feeds: unknown = null;

new PostMan(state, {
  __INIT__: () => registerTransportKind(webSocketTransport()),
  OPEN: async (
    { ui, viewport, secret }: { ui: string; viewport: TabViewport; secret: string },
  ) => {
    const transport = await Transport.open(ui, {
      purpose: "rdp.ui",
      kinds: ["websocket"],
      params: { secret },
    });
    kind = transport.kind;
    tab = messages(transport);
    tab.onmessage = (raw) => {
      const message = raw as ToTab;
      if (message instanceof ArrayBuffer || message instanceof Uint8Array) {
        const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
        try {
          const delta = decodeDelta(bytes);
          replica.apply(delta);
          deltas++;
          tab!.send({ ack: delta.toTick });
        } catch (error) {
          if (!(error instanceof StoreDivergence)) throw error;
          tab!.send({ resync: true });
        }
        return;
      }
      if ("camera" in message) camera = message.camera;
      if ("media" in message) feeds = message.media.feeds;
    };
    tab.send({ viewport });
    return kind;
  },
  DOM: (events: TabDomEvent[]) => {
    for (const dom of events) tab!.send({ dom });
    return true;
  },
  FEEDSIZE: (size: { width: number; height: number }) => {
    tab!.send({ feedSize: { feed: "desktop", ...size } });
    return true;
  },
  /** What the replica holds: texts drawn, video surfaces with their placement, and so on. */
  STATE: () => {
    const texts: string[] = [];
    const videos: Array<{ feed: string; transform: number[] }> = [];
    let uiQuads = 0;
    for (const id of replica.ids("items")) {
      const item = replica.get("items", id) as {
        header: { kind: string };
        transform: Float64Array;
        data: { text?: string; feed?: string };
      };
      if (item.header.kind === "textRun") texts.push(item.data.text ?? "");
      else if (item.header.kind === "uiQuad") uiQuads++;
      else if (item.header.kind === "videoSurface") {
        videos.push({ feed: item.data.feed ?? "", transform: [...item.transform] });
      }
    }
    return { kind, deltas, tick: replica.sourceTick, texts, uiQuads, videos, camera, feeds };
  },
  CLOSE: () => {
    tab?.close("test done");
    return true;
  },
} as const);
