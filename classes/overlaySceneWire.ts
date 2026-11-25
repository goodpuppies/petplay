import { Buffer } from "node:buffer";
import { deserialize, serialize } from "node:v8";
import type { WebXRRaythreeRenderPayload } from "./webxrRaythreeScene.ts";
import type { SceneDelivery } from "./overlaySceneDelivery.ts";
import type { RenderAnchor, RenderAnchorSpace } from "./overlayRenderTracking.ts";
import type {
  WebXRRaythreeUiPanelSnapshot,
  WebXRRaythreeUiTextSnapshot,
} from "./webxrRaythreeUi.ts";

const LEGACY_FORMAT = "petplay-ir-v8-base64-v1";
export const OVERLAY_SCENE_WIRE_FORMAT = "petplay-ir-v8-base64-v2-ui-assets";
export type OverlayScenePacket = {
  format: typeof OVERLAY_SCENE_WIRE_FORMAT | typeof LEGACY_FORMAT;
  data: string;
};

const fromBase64Native = (Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array })
  .fromBase64;

function toBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function fromBase64(text: string): Uint8Array {
  if (fromBase64Native) return fromBase64Native(text);
  return Buffer.from(text, "base64");
}

// Legacy stateless codec: useful for independent snapshots and older consumers.
export function encodeOverlayScene(payload: WebXRRaythreeRenderPayload): OverlayScenePacket {
  return { format: LEGACY_FORMAT, data: toBase64(serialize(payload)) };
}
export function decodeOverlayScene(packet: OverlayScenePacket): WebXRRaythreeRenderPayload {
  if (packet.format !== LEGACY_FORMAT) throw new Error("Stateful scene decoder required");
  return deserialize(fromBase64(packet.data)) as WebXRRaythreeRenderPayload;
}

type Text = WebXRRaythreeUiTextSnapshot;
type Panel = WebXRRaythreeUiPanelSnapshot;
type Geometry = NonNullable<Text["geometry"]>;
type Ref = { id: number; revision: number };
type Asset = Ref & { geometry: Geometry };
type WireText = Omit<Text, "geometry"> & { geometry?: Geometry; geometryRef?: Ref };

// Slab-packed representation of ui.panels and ui.texts: collapses hundreds of individual
// Float32Arrays/Float64Arrays and JS objects into a few contiguous typed arrays so Deno's
// v8.deserialize performs O(1) Rust ops instead of O(N) _readHostObject calls.
type PackedPanels = {
  count: number;
  f32: Float32Array;
  anchorF64: Float64Array;
  // 11 i32s per panel: [f32Off, anchorF64Off, flags, instanceIndex, renderOrder, rootIndex, major, minor, elemType, patch, anchorSpaceIdx]
  i32: Int32Array;
  spaces: RenderAnchorSpace[];
  extraAnchors?: Array<[number, RenderAnchor]>;
};

type PackedTexts = {
  count: number;
  f32: Float32Array;
  anchorF64: Float64Array;
  // 9 f64s per text: [r, g, b, a, fontSize, minX, maxX, minY, maxY]
  f64: Float64Array;
  // 10 i32s per text: [f32Off, anchorF64Off, flags, rootIndex, geoId, geoRev, alignIdx, anchorXIdx, fontIdx, anchorSpaceIdx]
  i32: Int32Array;
  texts: string[];
  spaces: RenderAnchorSpace[];
  strings: string[];
  inlineGeometries?: Array<[number, Geometry]>;
  extraAnchors?: Array<[number, RenderAnchor]>;
};

type WirePayload = Omit<WebXRRaythreeRenderPayload, "ui"> & {
  delivery: SceneDelivery;
  ui: Omit<WebXRRaythreeRenderPayload["ui"], "texts" | "panels"> & {
    panels?: Panel[];
    texts?: WireText[];
    packedPanels?: PackedPanels;
    packedTexts?: PackedTexts;
  };
  uiGeometryAssets: Asset[];
};

const bytes = (g: Geometry) =>
  g.positions.byteLength + g.uvs.byteLength + g.indices.byteLength +
  (g.vectorGlyphs?.byteLength ?? 0);
const identity = (d: SceneDelivery) => `${d.epoch}:${d.stream}`;
function validRef(r: Ref): boolean {
  return Number.isSafeInteger(r.id) && r.id > 0 && Number.isSafeInteger(r.revision) &&
    r.revision > 0;
}

const PANEL_STRIDE_I32 = 11;
const TEXT_STRIDE_I32 = 10;
const TEXT_STRIDE_F64 = 9;

function internSpace(
  s: RenderAnchorSpace,
  list: RenderAnchorSpace[],
  map: Map<RenderAnchorSpace, number>,
): number {
  let idx = map.get(s);
  if (idx === undefined) {
    idx = list.length;
    list.push(s);
    map.set(s, idx);
  }
  return idx;
}

function internStr(s: string | undefined, list: string[], map: Map<string, number>): number {
  if (s === undefined) return -1;
  let idx = map.get(s);
  if (idx === undefined) {
    idx = list.length;
    list.push(s);
    map.set(s, idx);
  }
  return idx;
}

function packPanels(panels: readonly Panel[]): PackedPanels | null {
  const count = panels.length;
  if (count === 0) {
    return {
      count: 0,
      f32: new Float32Array(0),
      anchorF64: new Float64Array(0),
      i32: new Int32Array(0),
      spaces: [],
    };
  }
  let anchorF64Count = 0;
  for (let i = 0; i < count; i++) {
    const p = panels[i]!;
    if (
      !(p.worldMatrix instanceof Float32Array) || p.worldMatrix.length !== 16 ||
      !(p.data instanceof Float32Array) || p.data.length !== 16 ||
      !(p.clipping instanceof Float32Array) || p.clipping.length !== 16
    ) {
      return null;
    }
    const ra = p.renderAnchor;
    if (ra != null && ra.pair === undefined && ra.localMatrix instanceof Float64Array && ra.localMatrix.length === 16) {
      anchorF64Count += 16;
    }
  }
  const f32 = new Float32Array(count * 48);
  const anchorF64 = new Float64Array(anchorF64Count);
  const i32 = new Int32Array(count * PANEL_STRIDE_I32);
  const spaces: RenderAnchorSpace[] = [];
  const spaceMap = new Map<RenderAnchorSpace, number>();
  let extraAnchors: Array<[number, RenderAnchor]> | undefined;
  let fOff = 0;
  let aOff = 0;
  for (let i = 0; i < count; i++) {
    const p = panels[i]!;
    const baseI = i * PANEL_STRIDE_I32;
    const startF = fOff;
    f32.set(p.worldMatrix, fOff);
    fOff += 16;
    f32.set(p.data, fOff);
    fOff += 16;
    f32.set(p.clipping, fOff);
    fOff += 16;
    let flags = (p.depthTest ? 1 : 0) | (p.depthWrite ? 2 : 0);
    const oi = p.orderInfo;
    if (oi !== undefined) flags |= 4;
    let spaceIdx = -1;
    let anchorOff = -1;
    const ra = p.renderAnchor;
    if (ra != null) {
      if (ra.pair === undefined && ra.localMatrix instanceof Float64Array && ra.localMatrix.length === 16) {
        flags |= 8;
        if (ra.follow) flags |= 16;
        anchorOff = aOff;
        anchorF64.set(ra.localMatrix, aOff);
        aOff += 16;
        spaceIdx = internSpace(ra.space, spaces, spaceMap);
      } else {
        flags |= 32;
        (extraAnchors ??= []).push([i, ra]);
      }
    }
    i32[baseI] = startF;
    i32[baseI + 1] = anchorOff;
    i32[baseI + 2] = flags;
    i32[baseI + 3] = p.instanceIndex | 0;
    i32[baseI + 4] = p.renderOrder | 0;
    i32[baseI + 5] = p.rootIndex | 0;
    if (oi !== undefined) {
      i32[baseI + 6] = oi.majorIndex | 0;
      i32[baseI + 7] = oi.minorIndex | 0;
      i32[baseI + 8] = oi.elementType | 0;
      i32[baseI + 9] = oi.patchIndex | 0;
    }
    i32[baseI + 10] = spaceIdx;
  }
  return { count, f32, anchorF64, i32, spaces, extraAnchors };
}

function unpackPanels(packed: PackedPanels): Panel[] {
  const { count, f32, anchorF64, i32, spaces, extraAnchors } = packed;
  const extraMap = extraAnchors ? new Map<number, RenderAnchor>(extraAnchors) : null;
  const out = new Array<Panel>(count);
  for (let i = 0; i < count; i++) {
    const baseI = i * PANEL_STRIDE_I32;
    const fOff = i32[baseI]!;
    const aOff = i32[baseI + 1]!;
    const flags = i32[baseI + 2]!;
    const panel: Panel = {
      worldMatrix: f32.subarray(fOff, fOff + 16),
      data: f32.subarray(fOff + 16, fOff + 32),
      clipping: f32.subarray(fOff + 32, fOff + 48),
      instanceIndex: i32[baseI + 3]!,
      renderOrder: i32[baseI + 4]!,
      rootIndex: i32[baseI + 5]!,
      depthTest: (flags & 1) !== 0,
      depthWrite: (flags & 2) !== 0,
    };
    if ((flags & 4) !== 0) {
      panel.orderInfo = {
        majorIndex: i32[baseI + 6]!,
        minorIndex: i32[baseI + 7]!,
        elementType: i32[baseI + 8]!,
        patchIndex: i32[baseI + 9]!,
      };
    }
    if ((flags & 8) !== 0) {
      const ra: RenderAnchor = {
        space: spaces[i32[baseI + 10]!]!,
        localMatrix: anchorF64.subarray(aOff, aOff + 16),
      };
      if ((flags & 16) !== 0) ra.follow = true;
      panel.renderAnchor = ra;
    } else if ((flags & 32) !== 0 && extraMap !== null) {
      const ra = extraMap.get(i);
      if (ra !== undefined) panel.renderAnchor = ra;
    }
    out[i] = panel;
  }
  return out;
}

function packTexts(texts: readonly WireText[]): PackedTexts | null {
  const count = texts.length;
  if (count === 0) {
    return {
      count: 0,
      f32: new Float32Array(0),
      anchorF64: new Float64Array(0),
      f64: new Float64Array(0),
      i32: new Int32Array(0),
      texts: [],
      spaces: [],
      strings: [],
    };
  }
  let anchorF64Count = 0;
  for (let i = 0; i < count; i++) {
    const t = texts[i]!;
    if (!(t.worldMatrix instanceof Float32Array) || t.worldMatrix.length !== 16) return null;
    const ra = t.renderAnchor;
    if (ra != null && ra.pair === undefined && ra.localMatrix instanceof Float64Array && ra.localMatrix.length === 16) {
      anchorF64Count += 16;
    }
  }
  const f32 = new Float32Array(count * 16);
  const anchorF64 = new Float64Array(anchorF64Count);
  const f64 = new Float64Array(count * TEXT_STRIDE_F64);
  const i32 = new Int32Array(count * TEXT_STRIDE_I32);
  const textStrings = new Array<string>(count);
  const spaces: RenderAnchorSpace[] = [];
  const spaceMap = new Map<RenderAnchorSpace, number>();
  const strings: string[] = [];
  const strMap = new Map<string, number>();
  let inlineGeometries: Array<[number, Geometry]> | undefined;
  let extraAnchors: Array<[number, RenderAnchor]> | undefined;
  let fOff = 0;
  let aOff = 0;
  for (let i = 0; i < count; i++) {
    const t = texts[i]!;
    const baseI = i * TEXT_STRIDE_I32;
    const baseF64 = i * TEXT_STRIDE_F64;
    const startF = fOff;
    f32.set(t.worldMatrix, fOff);
    fOff += 16;
    let flags = 0;
    let spaceIdx = -1;
    let anchorOff = -1;
    const ra = t.renderAnchor;
    if (ra != null) {
      if (ra.pair === undefined && ra.localMatrix instanceof Float64Array && ra.localMatrix.length === 16) {
        flags |= 1;
        if (ra.follow) flags |= 64;
        anchorOff = aOff;
        anchorF64.set(ra.localMatrix, aOff);
        aOff += 16;
        spaceIdx = internSpace(ra.space, spaces, spaceMap);
      } else {
        flags |= 128;
        (extraAnchors ??= []).push([i, ra]);
      }
    }
    if (t.color !== undefined) {
      flags |= 2;
      f64[baseF64] = t.color[0];
      f64[baseF64 + 1] = t.color[1];
      f64[baseF64 + 2] = t.color[2];
      f64[baseF64 + 3] = t.color[3];
    }
    if (t.fontSize !== undefined) {
      flags |= 4;
      f64[baseF64 + 4] = t.fontSize;
    }
    if (t.bounds !== undefined) {
      flags |= 8;
      f64[baseF64 + 5] = t.bounds.minX;
      f64[baseF64 + 6] = t.bounds.maxX;
      f64[baseF64 + 7] = t.bounds.minY;
      f64[baseF64 + 8] = t.bounds.maxY;
    }
    if (t.rootIndex !== undefined) flags |= 16;
    let geoId = 0;
    let geoRev = 0;
    if (t.geometryRef !== undefined) {
      flags |= 32;
      geoId = t.geometryRef.id;
      geoRev = t.geometryRef.revision;
    } else if (t.geometry !== undefined) {
      (inlineGeometries ??= []).push([i, t.geometry]);
    }
    textStrings[i] = t.text;
    i32[baseI] = startF;
    i32[baseI + 1] = anchorOff;
    i32[baseI + 2] = flags;
    i32[baseI + 3] = t.rootIndex ?? 0;
    i32[baseI + 4] = geoId;
    i32[baseI + 5] = geoRev;
    i32[baseI + 6] = internStr(t.align, strings, strMap);
    i32[baseI + 7] = internStr(t.anchorX, strings, strMap);
    i32[baseI + 8] = internStr(t.font, strings, strMap);
    i32[baseI + 9] = spaceIdx;
  }
  return {
    count,
    f32,
    anchorF64,
    f64,
    i32,
    texts: textStrings,
    spaces,
    strings,
    inlineGeometries,
    extraAnchors,
  };
}

function unpackTexts(
  packed: PackedTexts,
  previous: Map<number, Asset>,
  incoming: Map<number, Asset>,
  current: Map<number, Asset>,
): Text[] {
  const {
    count,
    f32,
    anchorF64,
    f64,
    i32,
    texts: textStrings,
    spaces,
    strings,
    inlineGeometries,
    extraAnchors,
  } = packed;
  const inlineMap = inlineGeometries ? new Map<number, Geometry>(inlineGeometries) : null;
  const extraMap = extraAnchors ? new Map<number, RenderAnchor>(extraAnchors) : null;
  const out = new Array<Text>(count);
  for (let i = 0; i < count; i++) {
    const baseI = i * TEXT_STRIDE_I32;
    const baseF64 = i * TEXT_STRIDE_F64;
    const fOff = i32[baseI]!;
    const aOff = i32[baseI + 1]!;
    const flags = i32[baseI + 2]!;
    const text = {
      worldMatrix: f32.subarray(fOff, fOff + 16),
      text: textStrings[i]!,
    } as Text;
    if ((flags & 1) !== 0) {
      const ra: RenderAnchor = {
        space: spaces[i32[baseI + 9]!]!,
        localMatrix: anchorF64.subarray(aOff, aOff + 16),
      };
      if ((flags & 64) !== 0) ra.follow = true;
      text.renderAnchor = ra;
    } else if ((flags & 128) !== 0 && extraMap !== null) {
      const ra = extraMap.get(i);
      if (ra !== undefined) text.renderAnchor = ra;
    }
    if ((flags & 2) !== 0) {
      text.color = [f64[baseF64]!, f64[baseF64 + 1]!, f64[baseF64 + 2]!, f64[baseF64 + 3]!];
    }
    if ((flags & 4) !== 0) text.fontSize = f64[baseF64 + 4]!;
    if ((flags & 8) !== 0) {
      text.bounds = {
        minX: f64[baseF64 + 5]!,
        maxX: f64[baseF64 + 6]!,
        minY: f64[baseF64 + 7]!,
        maxY: f64[baseF64 + 8]!,
      };
    }
    if ((flags & 16) !== 0) text.rootIndex = i32[baseI + 3]!;
    const alignIdx = i32[baseI + 6]!;
    if (alignIdx >= 0) text.align = strings[alignIdx] as Text["align"];
    const anchorXIdx = i32[baseI + 7]!;
    if (anchorXIdx >= 0) text.anchorX = strings[anchorXIdx] as Text["anchorX"];
    const fontIdx = i32[baseI + 8]!;
    if (fontIdx >= 0) text.font = strings[fontIdx];
    if ((flags & 32) !== 0) {
      const ref: Ref = { id: i32[baseI + 4]!, revision: i32[baseI + 5]! };
      if (!validRef(ref)) throw new Error("Invalid UI geometry reference");
      const cached = previous.get(ref.id);
      const asset = cached?.revision === ref.revision ? cached : incoming.get(ref.id);
      if (!asset || asset.revision !== ref.revision) {
        throw new Error(`Missing UI geometry ${ref.id}:${ref.revision}`);
      }
      current.set(ref.id, asset);
      text.geometry = asset.geometry;
    } else if (inlineMap !== null) {
      const g = inlineMap.get(i);
      if (g !== undefined) text.geometry = g;
    }
    out[i] = text;
  }
  return out;
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
    const wireTexts: WireText[] = payload.ui.texts.map((text) => {
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
    const packedPanels = packPanels(payload.ui.panels);
    const packedTexts = packTexts(wireTexts);
    const ui: WirePayload["ui"] = {
      textRendering: payload.ui.textRendering,
      images: payload.ui.images,
      ...(packedPanels ? { packedPanels } : { panels: payload.ui.panels }),
      ...(packedTexts ? { packedTexts } : { texts: wireTexts }),
    };
    const wire: WirePayload = {
      ...payload,
      delivery,
      ui,
      uiGeometryAssets: [...current.values()].filter((e) => e.version > this.acknowledged)
        .map(({ id, revision, geometry }) => ({ id, revision, geometry })),
    };
    const packet = { format: OVERLAY_SCENE_WIRE_FORMAT, data: toBase64(serialize(wire)) };
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
  /** The sender's stream identity (epoch and stream) of the last packet decoded. */
  get streamId(): string | null {
    return this.stream;
  }
  private sequence = 0;
  private entries = new Map<number, Asset>();
  private retired = new Set<string>();
  constructor(private readonly byteLimit = 64 * 1024 * 1024) {}

  decode(packet: OverlayScenePacket): Decoded {
    if (packet.format === LEGACY_FORMAT) {
      return { stale: false, payload: decodeOverlayScene(packet) };
    }
    if (packet.format !== OVERLAY_SCENE_WIRE_FORMAT) throw new Error("Unsupported IR wire format");
    const wire = deserialize(fromBase64(packet.data)) as WirePayload;
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
    const panels = wire.ui.packedPanels
      ? unpackPanels(wire.ui.packedPanels)
      : (wire.ui.panels ?? []);
    const texts: Text[] = wire.ui.packedTexts
      ? unpackTexts(wire.ui.packedTexts, previous, incoming, current)
      : (wire.ui.texts ?? []).map((text) => {
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
    return {
      stale: false,
      payload: {
        ...rest,
        ui: {
          textRendering: wire.ui.textRendering,
          images: wire.ui.images,
          panels,
          texts,
        },
      },
    };
  }
}
