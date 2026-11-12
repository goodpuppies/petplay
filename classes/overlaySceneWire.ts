import { Buffer } from "node:buffer";
import { deserialize, serialize } from "node:v8";
import type { WebXRRaythreeRenderPayload } from "./webxrRaythreeScene.ts";
import type { SceneDelivery } from "./overlaySceneDelivery.ts";

const LEGACY_FORMAT = "petplay-ir-v8-base64-v1";
export const OVERLAY_SCENE_WIRE_FORMAT = "petplay-ir-v8-base64-v2-ui-assets";
export type OverlayScenePacket = {
  format: typeof OVERLAY_SCENE_WIRE_FORMAT | typeof LEGACY_FORMAT;
  data: string;
};
// Legacy stateless codec: useful for independent snapshots and older consumers.
export function encodeOverlayScene(payload: WebXRRaythreeRenderPayload): OverlayScenePacket {
  return { format: LEGACY_FORMAT, data: serialize(payload).toString("base64") };
}
export function decodeOverlayScene(packet: OverlayScenePacket): WebXRRaythreeRenderPayload {
  if (packet.format !== LEGACY_FORMAT) throw new Error("Stateful scene decoder required");
  return deserialize(Buffer.from(packet.data, "base64")) as WebXRRaythreeRenderPayload;
}

type Text = WebXRRaythreeRenderPayload["ui"]["texts"][number];
type Geometry = NonNullable<Text["geometry"]>;
type Ref = { id: number; revision: number };
type Asset = Ref & { geometry: Geometry };
type WireText = Omit<Text, "geometry"> & { geometry?: Geometry; geometryRef?: Ref };
type WirePayload = Omit<WebXRRaythreeRenderPayload, "ui"> & {
  delivery: SceneDelivery;
  ui: Omit<WebXRRaythreeRenderPayload["ui"], "texts"> & { texts: WireText[] };
  uiGeometryAssets: Asset[];
};
const bytes = (g: Geometry) => g.positions.byteLength + g.uvs.byteLength + g.indices.byteLength +
  (g.vectorGlyphs?.byteLength ?? 0);
const identity = (d: SceneDelivery) => `${d.epoch}:${d.stream}`;
function validRef(r: Ref): boolean {
  return Number.isSafeInteger(r.id) && r.id > 0 && Number.isSafeInteger(r.revision) &&
    r.revision > 0;
}

/** One encoder per registered view; all unreceipted dependencies are repeated. */
export class OverlaySceneWireEncoder {
  private stream: string | null = null;
  private version = 0;
  private acknowledged = 0;
  private entries = new Map<number, Asset & { version: number }>();
  private pending = new Map<number, number>();
  constructor(private readonly byteLimit = 64 * 1024 * 1024) {}

  encode(payload: WebXRRaythreeRenderPayload): OverlayScenePacket {
    const d = payload.delivery;
    if (!d) throw new Error("Stateful scene encoding requires delivery identity");
    const stream = identity(d);
    if (stream !== this.stream) {
      this.stream = stream;
      this.version = this.acknowledged = 0;
      this.entries.clear();
      this.pending.clear();
    }
    const current = new Map<number, Asset & { version: number }>();
    const texts: WireText[] = payload.ui.texts.map((text) => {
      const g = text.geometry;
      if (!g || g.id === undefined || g.revision === undefined) return text;
      const ref = { id: g.id, revision: g.revision };
      if (!validRef(ref)) throw new Error("Invalid UI geometry identity");
      const previous = this.entries.get(ref.id);
      const entry = previous?.revision === ref.revision ? previous : {
        ...ref,
        geometry: g,
        version: ++this.version,
      };
      current.set(ref.id, entry);
      return { ...text, geometry: undefined, geometryRef: ref };
    });
    let total = 0;
    for (const entry of current.values()) total += bytes(entry.geometry);
    if (total > this.byteLimit) throw new Error("UI geometry transport budget exceeded");
    const delivery = { ...d, uiGeometryVersion: this.version };
    const wire: WirePayload = {
      ...payload,
      delivery,
      ui: { ...payload.ui, texts },
      uiGeometryAssets: [...current.values()].filter((e) => e.version > this.acknowledged)
        .map(({ id, revision, geometry }) => ({ id, revision, geometry })),
    };
    const packet = { format: OVERLAY_SCENE_WIRE_FORMAT, data: serialize(wire).toString("base64") };
    // Removed geometry is forgotten. Reappearance gets a new version and is sent again.
    this.entries = current;
    this.pending.set(delivery.sequence, this.version);
    while (this.pending.size > 16) this.pending.delete(this.pending.keys().next().value!);
    return packet as OverlayScenePacket;
  }

  /** Call only after the ordinary scene-credit receipt has been validated. */
  acknowledge(delivery: SceneDelivery): boolean {
    const version = this.pending.get(delivery.sequence);
    if (
      identity(delivery) !== this.stream || version === undefined ||
      version !== delivery.uiGeometryVersion
    ) return false;
    this.pending.delete(delivery.sequence);
    this.acknowledged = Math.max(this.acknowledged, version);
    return true;
  }
}

type Decoded =
  | { stale: false; payload: WebXRRaythreeRenderPayload }
  | { stale: true; delivery: SceneDelivery };
/** Resolve references before returning receipt credit. GPU adoption can happen later. */
export class OverlaySceneWireDecoder {
  private stream: string | null = null;
  private sequence = 0;
  private entries = new Map<number, Asset>();
  private retired = new Set<string>();
  constructor(private readonly byteLimit = 64 * 1024 * 1024) {}
  decode(packet: OverlayScenePacket): Decoded {
    if (packet.format === LEGACY_FORMAT) {
      return { stale: false, payload: decodeOverlayScene(packet) };
    }
    if (packet.format !== OVERLAY_SCENE_WIRE_FORMAT) throw new Error("Unsupported IR wire format");
    const wire = deserialize(Buffer.from(packet.data, "base64")) as WirePayload;
    const d = wire.delivery;
    if (!d) throw new Error("Missing scene delivery identity");
    const stream = identity(d);
    if (this.retired.has(stream) || (stream === this.stream && d.sequence <= this.sequence)) {
      return { stale: true, delivery: d };
    }
    const previous = stream === this.stream ? this.entries : new Map<number, Asset>();
    const incoming = new Map<number, Asset>();
    for (const asset of wire.uiGeometryAssets) {
      if (!validRef(asset)) throw new Error("Invalid UI geometry asset");
      incoming.set(asset.id, asset);
    }
    const current = new Map<number, Asset>();
    const texts: Text[] = wire.ui.texts.map((text) => {
      const ref = text.geometryRef;
      if (!ref) return text;
      if (!validRef(ref)) throw new Error("Invalid UI geometry reference");
      const cached = previous.get(ref.id);
      const asset = cached?.revision === ref.revision ? cached : incoming.get(ref.id);
      if (!asset || asset.revision !== ref.revision) {
        throw new Error(`Missing UI geometry ${ref.id}:${ref.revision}`);
      }
      current.set(ref.id, asset);
      const { geometryRef: _, ...rest } = text;
      return { ...rest, geometry: asset.geometry };
    });
    let total = 0;
    for (const asset of current.values()) total += bytes(asset.geometry);
    if (total > this.byteLimit) throw new Error("UI geometry decoder budget exceeded");
    // Commit only after every dependency has resolved and the memory bound passes.
    if (this.stream !== null && stream !== this.stream) {
      this.retired.add(this.stream);
      while (this.retired.size > 16) this.retired.delete(this.retired.values().next().value!);
    }
    this.stream = stream;
    this.sequence = d.sequence;
    this.entries = current;
    const { uiGeometryAssets: _, ...rest } = wire;
    return { stale: false, payload: { ...rest, ui: { ...wire.ui, texts } } };
  }
}
