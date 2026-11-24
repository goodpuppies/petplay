/**
 * PetPlay's writer into the raythree scene store (markdown/scene-stream).
 *
 * - Meshes go through raythree's `ExtractionStoreWriter`, with `renderAnchor`s mapped onto tracked
 *   nodes: anchored items are stored relative to the space that carries them and never change
 *   while only that space moves. The renderer fills in tracked poses at draw time.
 * - uikit panels, images and texts become `uiQuad` and `textRun` items. This is a polled writer
 *   over today's UI snapshot; binding to uikit's signals directly comes later.
 * - Atlases and UI images go into the `textures` table with their PNG bytes, so a remote renderer
 *   needs nothing from this machine's disk.
 * - Displays become `videoSurface` items (see {@link VideoSurfaceMarker}): where a feed appears and
 *   which part of it. The pixels travel over the media transport, not through the store.
 */
import * as THREE from "three";
import type { ExtractionResult, RenderInstance } from "../submodules/raythree/src/lib.ts";
import {
  type ClipPlanes,
  ExtractionStoreWriter,
  identityMatrix,
  type ItemPlacement,
  type RowId,
  SceneStore,
  type TextRunData,
  type TrackedPair,
  type TrackedSpace,
  type UiOrder,
  type UiQuadData,
  type VideoSurfaceData,
  WORLD_NODE,
} from "../submodules/raythree/src/store/mod.ts";
import {
  type Anchored,
  followKey,
  type RenderAnchor,
  type RenderAnchorSpace,
} from "./overlayRenderTracking.ts";
import type {
  WebXRRaythreeUiImageSnapshot,
  WebXRRaythreeUiOrderInfo,
  WebXRRaythreeUiPanelSnapshot,
  WebXRRaythreeUiSnapshot,
  WebXRRaythreeUiTextSnapshot,
} from "./webxrRaythreeUi.ts";

/** Fixed node ids for PetPlay's tracked spaces, in every store this writer feeds. */
export const TRACKED_NODES: Readonly<Record<RenderAnchorSpace, RowId>> = {
  head: 1,
  "left-hand": 2,
  "right-hand": 3,
  "left-ray": 4,
  "right-ray": 5,
};

const TRACKED_SPACE: Readonly<Record<RenderAnchorSpace, TrackedSpace>> = {
  head: "viewer",
  "left-hand": "left-grip",
  "right-hand": "right-grip",
  "left-ray": "left-ray",
  "right-ray": "right-ray",
};

/** Id ranges kept apart from the extractor's own ids. */
const FIRST_PAIR_NODE = 100;
const FIRST_UI_ITEM = 0x2000_0000;
const FIRST_UI_TEXTURE = 0x4000_0000;
const FIRST_VIDEO_ITEM = 0x3000_0000;
const FIRST_VIDEO_GEOMETRY = 0x5000_0000;
/** How often the scene is searched for video surface markers; between searches they are re-read. */
const VIDEO_SURFACE_SCAN_MS = 1000;

/**
 * `userData.videoSurface` on an object in the scene: a display showing (part of) a media feed.
 * The object's world matrix places `geometry`, whose UVs span the shown `crop` of the feed.
 */
export type VideoSurfaceMarker = {
  feed: string;
  geometry: THREE.BufferGeometry;
  crop: { x: number; y: number; width: number; height: number };
  opacity: number;
  waitingLabel?: string;
};

/** MSDF atlases by font id, as the raylib renderer and `msdf-text.tsx` know them. */
const ATLAS_PATHS: Record<string, URL> = {
  roboto: new URL(
    "../submodules/threewebxrwebgpudeno/vendor/three-msdf-text-utils/demo/fonts/roboto/roboto-regular.png",
    import.meta.url,
  ),
  "material-icons": new URL("../resources/fonts/material-icons/material-icons.png", import.meta.url),
};
const DEFAULT_FONT = "roboto";
/** msdfgen's pxRange for both atlases. */
const MSDF_PX_RANGE = 4;

/** UI image keys, as the raylib renderer's registry knows them. */
const IMAGE_PATHS: Record<string, URL> = {
  wallpaper: new URL("../resources/ui/wallpaper.png", import.meta.url),
  petplay: new URL("../resources/PetPlay.png", import.meta.url),
};

type PetplayInstance = RenderInstance & Anchored & {
  vrcCameraHidden?: boolean;
  passthroughKey?: boolean;
  passthroughCutout?: boolean;
};

export class PetplaySceneStoreWriter {
  private readonly meshes: ExtractionStoreWriter;
  private readonly pairNodes = new Map<string, RowId>();
  private nextPairNode = FIRST_PAIR_NODE;
  private usedPairs = new Set<string>();

  private readonly uiItems = new Map<string, RowId>();
  /** The snapshot object each UI item was last written from (see {@link writeUi}). */
  private readonly uiSources = new Map<string, object>();
  private nextUiItem = FIRST_UI_ITEM;
  private readonly textures = new Map<string, RowId | null>();
  private nextTexture = FIRST_UI_TEXTURE;
  private readonly glyphCache = new Map<number, { revision: number; glyphs: Float32Array }>();

  private videoMarkers: THREE.Object3D[] = [];
  private videoScannedAt = -Infinity;
  private readonly videoItems = new Map<THREE.Object3D, RowId>();
  private nextVideoItem = FIRST_VIDEO_ITEM;
  private readonly videoGeometries = new Map<THREE.BufferGeometry, RowId>();
  private nextVideoGeometry = FIRST_VIDEO_GEOMETRY;

  constructor(readonly store: SceneStore = new SceneStore()) {
    this.meshes = new ExtractionStoreWriter(store, {
      place: (instance) => this.place(instance as PetplayInstance),
      extensions: (instance) => extensions(instance as PetplayInstance),
    });
    store.transaction(() => {
      for (const [space, id] of Object.entries(TRACKED_NODES)) {
        store.write("nodes", id, {
          structure: { parent: WORLD_NODE, tracked: TRACKED_SPACE[space as RenderAnchorSpace] },
          transform: identityMatrix(),
        });
      }
    });
  }

  /**
   * Writes one frame: the extraction (eye invariant, so the left eye's), the UI snapshot, and, given
   * the scene, its video surfaces.
   */
  write(extraction: ExtractionResult, ui?: WebXRRaythreeUiSnapshot, scene?: THREE.Object3D | null): void {
    this.store.transaction(() => {
      this.usedPairs = new Set();
      this.meshes.write(extraction);
      if (ui) this.writeUi(ui);
      if (scene) this.writeVideoSurfaces(scene);
      for (const [key, id] of this.pairNodes) {
        if (this.usedPairs.has(key)) continue;
        this.store.remove("nodes", id);
        this.pairNodes.delete(key);
      }
    });
  }

  // ---- meshes ----

  private place(instance: PetplayInstance): ItemPlacement {
    const anchor = instance.renderAnchor;
    if (!anchor) return { node: WORLD_NODE, matrix: instance.worldMatrix };
    return { node: this.anchorNode(anchor), matrix: anchor.localMatrix };
  }

  /** A one-hand carry is held in the pointer's own pose, which is what its tracked node is. */
  private anchorNode(anchor: RenderAnchor): RowId {
    return anchor.pair ? this.pairNode(anchor) : TRACKED_NODES[anchor.space];
  }

  private pairNode(anchor: RenderAnchor): RowId {
    const pair = anchor.pair!;
    const key = followKey(anchor.space, pair);
    this.usedPairs.add(key);
    let id = this.pairNodes.get(key);
    if (id === undefined) {
      id = this.nextPairNode++;
      this.pairNodes.set(key, id);
    }
    const point = (p: ArrayLike<number>) => [p[0]!, p[1]!, p[2]!] as [number, number, number];
    const tracked: TrackedPair = {
      first: TRACKED_SPACE[anchor.space],
      second: TRACKED_SPACE[pair.space],
      points: [point(pair.points[0]), point(pair.points[1])],
    };
    this.store.write("nodes", id, {
      structure: { parent: WORLD_NODE, tracked },
      transform: identityMatrix(),
    });
    return id;
  }

  // ---- UI ----

  private writeUi(ui: WebXRRaythreeUiSnapshot): void {
    const seen = new Set<string>();
    const write = (
      key: string,
      item: Anchored & { worldMatrix: ArrayLike<number> },
      kind: string,
      data: (node: NodeFrame) => unknown,
      /** False when the item's data depends on more than its own snapshot object. */
      skipUnchanged = true,
    ) => {
      seen.add(key);
      // The UI snapshot reuses an unchanged item's object and never mutates one it has handed
      // out, so the same object means the same content: nothing to derive, hash or compare.
      // A two-hand carry's pair node must still be marked as in use.
      if (skipUnchanged && this.uiSources.get(key) === item) {
        if (item.renderAnchor?.pair) this.usedPairs.add(followKey(item.renderAnchor.space, item.renderAnchor.pair));
        return;
      }
      this.uiSources.set(key, item);
      let id = this.uiItems.get(key);
      if (id === undefined) {
        id = this.nextUiItem++;
        this.uiItems.set(key, id);
      }
      const frame = this.nodeFrame(item);
      this.store.write("items", id, {
        header: { kind, node: frame.node },
        transform: frame.local,
        state: { visible: true, layerMask: 1, order: 0, depthSorted: false },
        data: data(frame),
      });
    };

    const panelOrders = new Map<WebXRRaythreeUiPanelSnapshot, UiOrder>();
    for (const panel of ui.panels) {
      const order = uiOrder(panel.rootIndex, 0, panel.renderOrder, panel.orderInfo, panel.instanceIndex);
      panelOrders.set(panel, order);
      const key = `p:${panel.rootIndex}:${panel.renderOrder}:${+panel.depthTest}${+panel.depthWrite}:${panel.instanceIndex}`;
      write(key, panel, "uiQuad", (frame) => panelData(panel, order, frame));
    }
    ui.images.forEach((image, i) => {
      // An image fills one panel's box: draw it right after that panel, through its corners.
      const panel = ui.panels.find((p) => p.rootIndex === image.rootIndex && panelMatchesImage(p, image));
      const base = panel ? panelOrders.get(panel)! : uiOrder(image.rootIndex, 0, image.renderOrder, image.orderInfo, 1e6);
      const order = [...base] as UiOrder;
      order[7] += 0.5;
      const texture = this.texture("image", image.texture);
      if (texture == null) return;
      // Not skipped when unchanged: its order comes from the panel it fills.
      write(
        `i:${image.rootIndex}:${image.texture}:${i}`,
        image,
        "uiQuad",
        (frame) => imageData(image, texture, order, frame),
        false,
      );
    });
    ui.texts.forEach((text, i) => {
      const atlas = this.texture("atlas", text.font ?? DEFAULT_FONT);
      if (atlas == null || !text.geometry) return;
      const key = `t:${text.geometry.id ?? `n${i}`}`;
      const glyphs = this.glyphs(text);
      if (!glyphs) return;
      write(key, text, "textRun", (frame) => textData(text, atlas, glyphs, frame));
    });

    for (const [key, id] of this.uiItems) {
      if (seen.has(key)) continue;
      this.store.remove("items", id);
      this.uiItems.delete(key);
      this.uiSources.delete(key);
    }
  }

  // ---- video surfaces ----

  private writeVideoSurfaces(scene: THREE.Object3D): void {
    const now = performance.now();
    if (now - this.videoScannedAt > VIDEO_SURFACE_SCAN_MS) {
      this.videoScannedAt = now;
      this.videoMarkers = [];
      scene.traverse((object) => {
        if (object.userData?.videoSurface) this.videoMarkers.push(object);
      });
    }
    const seen = new Set<THREE.Object3D>();
    const usedGeometries = new Set<RowId>();
    for (const object of this.videoMarkers) {
      const marker = object.userData.videoSurface as VideoSurfaceMarker | undefined;
      if (!marker || !shownIn(object, scene)) continue;
      seen.add(object);
      let id = this.videoItems.get(object);
      if (id === undefined) {
        id = this.nextVideoItem++;
        this.videoItems.set(object, id);
      }
      const geometry = this.videoGeometry(marker.geometry);
      usedGeometries.add(geometry);
      const data: VideoSurfaceData = {
        feed: marker.feed,
        geometry,
        crop: { ...marker.crop },
        opacity: marker.opacity,
        ...(marker.waitingLabel ? { waitingLabel: marker.waitingLabel } : {}),
      };
      this.store.write("items", id, {
        header: { kind: "videoSurface", node: WORLD_NODE },
        transform: Float64Array.from(object.matrixWorld.elements),
        state: { visible: true, layerMask: 1, order: 0, depthSorted: marker.opacity < 1 },
        data,
      });
    }
    for (const [object, id] of this.videoItems) {
      if (seen.has(object)) continue;
      this.store.remove("items", id);
      this.videoItems.delete(object);
    }
    for (const [geometry, id] of this.videoGeometries) {
      if (usedGeometries.has(id)) continue;
      this.store.remove("geometries", id);
      this.videoGeometries.delete(geometry);
    }
  }

  /** A display's surface geometry, written once per geometry object (it is rebuilt on change). */
  private videoGeometry(geometry: THREE.BufferGeometry): RowId {
    let id = this.videoGeometries.get(geometry);
    if (id !== undefined) return id;
    id = this.nextVideoGeometry++;
    this.videoGeometries.set(geometry, id);
    const attributes: Record<string, { itemSize: number; normalized: boolean; array: Float32Array }> = {};
    for (const name of ["position", "normal", "uv"]) {
      const attribute = geometry.getAttribute(name) as THREE.BufferAttribute | undefined;
      if (!attribute) continue;
      attributes[name] = {
        itemSize: attribute.itemSize,
        normalized: attribute.normalized,
        array: Float32Array.from(attribute.array as ArrayLike<number>),
      };
    }
    const index = geometry.getIndex();
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere!;
    this.store.write("geometries", id, {
      data: {
        topology: "triangles",
        attributes,
        index: index
          ? (index.count > 65535 ? Uint32Array : Uint16Array).from(index.array as ArrayLike<number>)
          : null,
        bounds: { center: sphere.center.toArray(), radius: sphere.radius },
      },
    });
    return id;
  }

  /** The node an item hangs under, its matrix there, and the node's world pose at capture. */
  private nodeFrame(item: Anchored & { worldMatrix: ArrayLike<number> }): NodeFrame {
    const anchor = item.renderAnchor;
    const world = new THREE.Matrix4().fromArray(item.worldMatrix as number[]);
    if (!anchor) {
      return { node: WORLD_NODE, local: new Float64Array(world.elements), nodeWorld: null };
    }
    const local = new THREE.Matrix4().fromArray(anchor.localMatrix as unknown as number[]);
    // The pose the producer placed the item from: world = nodeWorld × local.
    const nodeWorld = Math.abs(local.determinant()) > 1e-30
      ? world.clone().multiply(local.clone().invert())
      : null;
    return { node: this.anchorNode(anchor), local: new Float64Array(anchor.localMatrix), nodeWorld };
  }

  /** Atlas and image textures, written once with their PNG bytes. Null if unknown. */
  private texture(kind: "atlas" | "image", name: string): RowId | null {
    const key = `${kind}:${name}`;
    if (this.textures.has(key)) return this.textures.get(key)!;
    const path = (kind === "atlas" ? ATLAS_PATHS : IMAGE_PATHS)[name];
    let id: RowId | null = null;
    if (path) {
      try {
        const bytes = Deno.readFileSync(path);
        const { width, height } = pngSize(bytes);
        id = this.nextTexture++;
        this.store.write("textures", id, {
          meta: {
            width,
            height,
            format: "rgba8",
            // MSDF distances are data, not color.
            colorSpace: kind === "atlas" ? "linear" : "srgb",
            // three-msdf-text-utils bakes glyph UVs against a flipY upload of the atlas.
            flipY: kind === "atlas",
            generateMipmaps: kind === "image",
            wrapS: "clamp",
            wrapT: "clamp",
          },
          source: { uri: key, mimeType: "image/png", bytes },
        });
      } catch {
        id = null;
      }
    }
    this.textures.set(key, id);
    return id;
  }

  /** Glyph quads from the MSDF geometry, cached by geometry id and revision. */
  private glyphs(text: WebXRRaythreeUiTextSnapshot): Float32Array | null {
    const g = text.geometry!;
    const cached = g.id != null ? this.glyphCache.get(g.id) : undefined;
    if (cached && cached.revision === (g.revision ?? g.version)) return cached.glyphs;
    const glyphs = glyphQuads(g.positions, g.uvs);
    if (!glyphs) return null;
    if (g.id != null) this.glyphCache.set(g.id, { revision: g.revision ?? g.version, glyphs });
    return glyphs;
  }
}

type NodeFrame = {
  node: RowId;
  local: Float64Array;
  /** The node's world matrix the producer used; null for the world node (identity). */
  nodeWorld: THREE.Matrix4 | null;
};

/** Still in `scene` and not hidden by itself or an ancestor. */
function shownIn(object: THREE.Object3D, scene: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = object; o; o = o.parent) {
    if (!o.visible) return false;
    if (o === scene) return true;
  }
  return false;
}

function uiOrder(
  root: number,
  layer: number,
  renderOrder: number,
  info: WebXRRaythreeUiOrderInfo | undefined,
  slot: number,
): UiOrder {
  return [
    root,
    layer,
    renderOrder,
    info?.majorIndex ?? 0,
    info?.minorIndex ?? 0,
    info?.elementType ?? 0,
    info?.patchIndex ?? 0,
    slot,
  ];
}

function panelData(panel: WebXRRaythreeUiPanelSnapshot, order: UiOrder, frame: NodeFrame): UiQuadData {
  const d = panel.data;
  const height = d[15]!;
  const r = unpackRadius(d[8]!);
  return {
    size: [d[14]!, height],
    borderWidth: [d[0]!, d[1]!, d[2]!, d[3]!],
    borderRadius: [r[0] * height, r[1] * height, r[2] * height, r[3] * height],
    borderBend: d[13]!,
    background: srgb(d[4]!, d[5]!, d[6]!, d[7]!),
    border: srgb(d[9]!, d[10]!, d[11]!, d[12]!),
    image: null,
    clip: nodeClip(panel.clipping, frame),
    depthTest: panel.depthTest,
    depthWrite: panel.depthWrite,
    uiOrder: order,
  };
}

function imageData(
  image: WebXRRaythreeUiImageSnapshot,
  texture: RowId,
  order: UiOrder,
  _frame: NodeFrame,
): UiQuadData {
  const radius = image.borderRadius ?? [0, 0, 0, 0];
  return {
    size: [image.width, image.height],
    borderWidth: [0, 0, 0, 0],
    borderRadius: [
      radius[0] * image.height,
      radius[1] * image.height,
      radius[2] * image.height,
      radius[3] * image.height,
    ],
    borderBend: 0,
    background: [0, 0, 0, 0],
    border: [0, 0, 0, 0],
    image: {
      texture,
      fit: image.fit ?? "cover",
      focus: image.focus ?? [0.5, 0.5],
      opacity: image.opacity ?? 1,
    },
    clip: null,
    depthTest: false,
    depthWrite: false,
    uiOrder: order,
  };
}

function textData(
  text: WebXRRaythreeUiTextSnapshot,
  atlas: RowId,
  glyphs: Float32Array,
  _frame: NodeFrame,
): TextRunData {
  const [r, g, b, a] = text.color;
  return {
    text: text.text,
    atlas,
    pxRange: MSDF_PX_RANGE,
    color: srgb(r, g, b, a),
    glyphs,
    bounds: { ...text.bounds },
    clip: null,
    // Texts sort among themselves by view depth (the renderer's job), so no slot.
    uiOrder: [text.rootIndex, 1, 0, 0, 0, 0, 0, 0],
  };
}

/**
 * MSDF text geometry is one axis-aligned quad per glyph: four vertices, the first and third at
 * opposite corners, UVs aligned with them. Packed as 8 floats per glyph (see `TextRunData`).
 */
export function glyphQuads(positions: ArrayLike<number>, uvs: ArrayLike<number>): Float32Array | null {
  const count = Math.floor(positions.length / 8);
  if (uvs.length < count * 8) return null;
  const out = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) {
    const p = i * 8;
    out[p] = positions[p]!;
    out[p + 1] = positions[p + 1]!;
    out[p + 2] = positions[p + 4]!;
    out[p + 3] = positions[p + 5]!;
    out[p + 4] = uvs[p]!;
    out[p + 5] = uvs[p + 1]!;
    out[p + 6] = uvs[p + 4]!;
    out[p + 7] = uvs[p + 5]!;
  }
  return out;
}

/** uikit packs corner radii in base 50, as hundredths of the panel height: TL, TR, BR, BL. */
function unpackRadius(packed: number): [number, number, number, number] {
  return [
    Math.floor(packed / 125000) % 50,
    Math.floor(packed / 2500) % 50,
    Math.floor(packed / 50) % 50,
    Math.floor(packed) % 50,
  ].map((v) => v * 0.01) as [number, number, number, number];
}

/** uikit colors are in Three's working space (linear when color management is on). */
function srgb(r: number, g: number, b: number, a: number): [number, number, number, number] {
  const c = (v: number) =>
    !THREE.ColorManagement.enabled ? v : v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return [c(r), c(g), c(b), a];
}

/** Planes that never cut: uikit writes a huge offset (or zero normals) for "no clipping". */
const NO_CLIP_OFFSET = 1e12;

/** World-space clip planes into node space: p_node = Nᵀ p_world for the node's world matrix N. */
export function nodeClip(
  world: ArrayLike<number>,
  frame: { nodeWorld: THREE.Matrix4 | null },
): ClipPlanes {
  let unclipped = true;
  for (let i = 0; i < 16; i += 4) {
    const normal = Math.hypot(world[i]!, world[i + 1]!, world[i + 2]!);
    if (!(normal < 1e-12 ? world[i + 3]! > 0 : world[i + 3]! > NO_CLIP_OFFSET)) unclipped = false;
  }
  if (unclipped) return null;
  const out = new Float64Array(16);
  const n = frame.nodeWorld?.elements;
  for (let i = 0; i < 16; i += 4) {
    const px = world[i]!, py = world[i + 1]!, pz = world[i + 2]!, pw = world[i + 3]!;
    if (!n) {
      out.set([px, py, pz, pw], i);
      continue;
    }
    // Column j of N (column-major) dotted with the plane gives row j of Nᵀ p.
    for (let j = 0; j < 4; j++) {
      out[i + j] = n[j * 4]! * px + n[j * 4 + 1]! * py + n[j * 4 + 2]! * pz + n[j * 4 + 3]! * pw;
    }
  }
  return out;
}

/** Same box and place as the raylib renderer's matcher: an image fills exactly one panel. */
function panelMatchesImage(panel: WebXRRaythreeUiPanelSnapshot, image: WebXRRaythreeUiImageSnapshot): boolean {
  const w = panel.data[14]!, h = panel.data[15]!;
  if (w <= 0 || h <= 0 || Math.abs(w - image.width) > 1 || Math.abs(h - image.height) > 1) return false;
  const m = image.worldMatrix;
  const tolerance = Math.max(Math.hypot(m[0]!, m[1]!, m[2]!) * 0.05, 1e-4);
  return Math.abs(panel.worldMatrix[12]! - m[12]!) < tolerance &&
    Math.abs(panel.worldMatrix[13]! - m[13]!) < tolerance &&
    Math.abs(panel.worldMatrix[14]! - m[14]!) < tolerance;
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(12) !== 0x49484452) {
    throw new Error("Not a PNG");
  }
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function extensions(instance: PetplayInstance): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (instance.vrcCameraHidden) out["petplay.vrcCameraHidden"] = true;
  if (instance.passthroughKey) out["petplay.passthroughKey"] = true;
  if (instance.passthroughCutout) out["petplay.passthroughCutout"] = true;
  return out;
}
