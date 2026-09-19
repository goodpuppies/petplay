import * as THREE from "three";
import type { InstancedBufferAttribute, Material, Object3D } from "three";
import { collectUikitRootContextsFromObject } from "../submodules/threewebxrwebgpudeno/local-uikit/raylibUikitSceneRoots.ts";
import { Component } from "../submodules/threewebxrwebgpudeno/local-uikit/components/component.ts";
import {
  type OrderInfo,
  orderInfoKey,
} from "../submodules/threewebxrwebgpudeno/submodules/uikit/packages/uikit/src/order.ts";

export type WebXRRaythreeUiOrderInfo = {
  majorIndex: number;
  minorIndex: number;
  elementType: number;
  patchIndex: number;
};

export type WebXRRaythreeUiPanelSnapshot = {
  worldMatrix: Float32Array;
  data: Float32Array;
  clipping: Float32Array;
  instanceIndex: number;
  renderOrder: number;
  depthTest: boolean;
  depthWrite: boolean;
  orderInfo?: WebXRRaythreeUiOrderInfo;
  /**
   * Which uikit root this came from.
   *
   * The UI pass draws with the depth test off, so layering is draw order alone.
   * Within one root uikit's own ordering is meaningful, but *between* roots there
   * is none — every panel reports order info 0/0/0/0 and `instanceIndex` is just
   * the order uikit happened to allocate slots. Two roots at different depths
   * (a keyboard and the wrist overlay) therefore interleave arbitrarily, and the
   * further one can paint over the nearer. Grouping by root lets the renderer
   * sort roots back-to-front and keep uikit's ordering inside each.
   */
  rootIndex: number;
};

/**
 * An image drawn as a UI panel's *fill*, not as an element inside one.
 *
 * That distinction is load-bearing. Ancestor clipping (`uClipping`) is four
 * half-space planes — an axis-aligned rectangle that knows nothing about corner
 * radius — so a child panel sitting in a rounded corner would fill the area the
 * curve cuts away. Drawing the image as the panel's own fill sends it through
 * that panel's rounded-rect SDF instead, so it gets the exact corner the flat
 * fill would have had, with the border still drawn over it.
 *
 * It also cannot be a mesh: the wrist menu subtree is marked
 * `bridge: { kind: "skip" }`, so raythree never extracts anything under it.
 * The UI snapshot is the only way in.
 */
export type WebXRRaythreeUiImageUserData = {
  /** Key into the renderer's texture registry. Only a string crosses this boundary. */
  texture: string;
  /** Panel size in uikit px; the renderer scales its unit quad by this. */
  width: number;
  height: number;
  /** Per-corner radius, in the same units as the panel shader expects. */
  borderRadius?: [number, number, number, number];
  /** How the image fills its box when the aspect ratios disagree. */
  fit?: "cover" | "stretch";
  /**
   * Focal point for `cover`, 0..1 on each axis. 0.5 centres the crop; 1 on x
   * keeps the right edge, which is what the clock wallpaper wants.
   */
  focus?: [number, number];
  opacity?: number;
};

export type WebXRRaythreeUiImageSnapshot = WebXRRaythreeUiImageUserData & {
  worldMatrix: Float32Array;
  /**
   * uikit's z-order for this node, on the same terms as a panel's. The UI pass
   * runs with the depth test off, so draw order *is* the layering — an image has
   * to interleave with panels rather than being drawn as a separate phase, or it
   * lands either behind the shell or on top of its own tile's contents.
   *
   * `Content` calls `setupRenderOrder` on its descendants, so the mesh inside it
   * carries the same order key panels do.
   */
  orderInfo?: WebXRRaythreeUiOrderInfo;
  renderOrder: number;
  /** See {@link WebXRRaythreeUiPanelSnapshot.rootIndex}. */
  rootIndex: number;
};

export type WebXRRaythreeUiTextSnapshot = {
  worldMatrix: Float32Array;
  text: string;
  color: [number, number, number, number];
  fontSize: number;
  align: "left" | "center" | "right";
  anchorX: "left" | "center" | "right";
  /** MSDF atlas id the baked UVs belong to. See {@link WebXRRaythreeTextUserData.font}. */
  font?: string;
  /** See {@link WebXRRaythreeUiPanelSnapshot.rootIndex}. */
  rootIndex: number;
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  };
  /** Per-glyph quad geometry in mesh-local space (from MSDFTextGeometry). */
  geometry?: {
    positions: Float32Array; // itemSize=2
    uvs: Float32Array; // itemSize=2
    indices: Uint16Array | Uint32Array;
    version: number;
  };
};

export type WebXRRaythreeUiSnapshot = {
  panels: WebXRRaythreeUiPanelSnapshot[];
  texts: WebXRRaythreeUiTextSnapshot[];
  images: WebXRRaythreeUiImageSnapshot[];
};

export type WebXRRaythreeTextUserData = {
  text: string;
  color: [number, number, number, number];
  fontSize: number;
  align: "left" | "center" | "right";
  anchorX: "left" | "center" | "right";
  /**
   * Which MSDF atlas the baked geometry's UVs index into. Text and icons share
   * one pipeline, so this is the only thing distinguishing a letter from a
   * glyph; the renderer keys its atlas cache on it.
   */
  font?: string;
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  };
};

const DEFAULT_CLIPPING = new Float32Array([
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
]);
const matrixHelper = new THREE.Matrix4();
const instanceMatrixHelper = new THREE.Matrix4();
const dataBlock16 = new Float32Array(16);

type TextGeometrySource = {
  attributes?: {
    position?: { array: ArrayLike<number>; itemSize: number; version?: number };
    uv?: { array: ArrayLike<number>; itemSize: number; version?: number };
  };
  index?: { array: ArrayLike<number>; version?: number } | null;
};

type TextGeometryCacheEntry = {
  positionArray: ArrayLike<number>;
  positionVersion: number;
  uvArray: ArrayLike<number>;
  uvVersion: number;
  indexArray: ArrayLike<number>;
  indexVersion: number;
  snapshot: NonNullable<WebXRRaythreeUiTextSnapshot["geometry"]>;
};

/**
 * MSDF glyph buffers are effectively static between text/layout changes. Keep
 * their snapshot copy alive instead of cloning every glyph buffer every frame.
 * The WeakMap follows the Three geometry lifetime and cannot retain removed UI.
 */
const textGeometryCache = new WeakMap<object, TextGeometryCacheEntry>();

function hasPanelDataAttributes(
  geometry:
    | {
      attributes?: Record<string, InstancedBufferAttribute | undefined>;
    }
    | null
    | undefined,
): boolean {
  if (geometry?.attributes == null) {
    return false;
  }
  const a = geometry.attributes;
  if (a.aData != null) {
    return true;
  }
  return a.aData0 != null && a.aData1 != null && a.aData2 != null && a.aData3 != null;
}

export function extractWebXRRaythreeUi(scene: THREE.Scene): WebXRRaythreeUiSnapshot {
  const snapshot: WebXRRaythreeUiSnapshot = {
    panels: [],
    texts: [],
    images: [],
  };

  // Every drawable is tagged with the uikit root it belongs to, so the renderer
  // can sort roots back-to-front. Indices are assigned here rather than derived
  // later because this is the only place the root -> object relationship exists.
  const rootIndices = new Map<unknown, number>();
  const rootIndexFor = (rootCtx: unknown): number => {
    let index = rootIndices.get(rootCtx);
    if (index === undefined) {
      index = rootIndices.size;
      rootIndices.set(rootCtx, index);
    }
    return index;
  };

  for (const rootCtx of collectUikitRootContextsFromObject(scene)) {
    const rootIndex = rootIndexFor(rootCtx);
    rootCtx.panelGroupManager.forEachGroup((group) => {
      const mesh = group.getInstancedPanelMesh();
      if (mesh == null || !mesh.visible) {
        return;
      }
      maybeCollectPanels(mesh, snapshot.panels, rootIndex);
    });
  }

  scene.traverseVisible((object: Object3D) => {
    // Text and images are ordinary scene objects, so their root has to be found
    // by walking up to the nearest uikit component.
    const rootIndex = resolveRootIndex(object, rootIndexFor);
    maybeCollectText(object, snapshot.texts, rootIndex);
    maybeCollectImage(object, snapshot.images, rootIndex);
  });

  return snapshot;
}

function maybeCollectPanels(
  object: Object3D,
  target: WebXRRaythreeUiPanelSnapshot[],
  rootIndex: number,
): void {
  const count = readPanelInstanceCount(object);
  if (count <= 0) {
    return;
  }

  const geometry = (object as Object3D & {
    geometry?: {
      attributes?: Record<string, InstancedBufferAttribute | undefined>;
    };
  }).geometry;
  const material = (object as Object3D & {
    material?: Material & { depthTest?: boolean; depthWrite?: boolean };
    renderOrder?: number;
  }).material;
  const instanceMatrix = geometry?.attributes?.instanceMatrix ??
    (object as Object3D & { instanceMatrix?: InstancedBufferAttribute }).instanceMatrix;
  if (instanceMatrix == null || !hasPanelDataAttributes(geometry)) {
    return;
  }

  const instanceClipping = geometry?.attributes?.aClipping;
  const renderOrder = Number((object as Object3D & { renderOrder?: number }).renderOrder ?? 0);
  const depthTest = material?.depthTest ?? true;
  const depthWrite = material?.depthWrite ?? false;
  const orderInfo = readOrderInfo(object);

  // Hot path: runs per live instance per frame. Prefetch the backing arrays
  // once and index them directly instead of re-resolving attributes and
  // allocating a subarray view per instance.
  const instanceArray = instanceMatrix.array as unknown as ArrayLike<number>;
  const aData0Arr = geometry?.attributes?.aData0?.array as unknown as ArrayLike<number> | undefined;
  const aData1Arr = geometry?.attributes?.aData1?.array as unknown as ArrayLike<number> | undefined;
  const aData2Arr = geometry?.attributes?.aData2?.array as unknown as ArrayLike<number> | undefined;
  const aData3Arr = geometry?.attributes?.aData3?.array as unknown as ArrayLike<number> | undefined;
  const aDataMergedArr =
    (aData0Arr == null || aData1Arr == null || aData2Arr == null || aData3Arr == null)
      ? geometry?.attributes?.aData?.array as unknown as ArrayLike<number> | undefined
      : undefined;
  const hasSplitData = aData0Arr != null && aData1Arr != null && aData2Arr != null &&
    aData3Arr != null;
  for (let index = 0; index < count; index++) {
    const matrixOffset = index * 16;
    const dataOffset = index * 16;
    // Freed uikit panel slots are cleared to an all-zero matrix; drawing them (and tinting) causes white smears.
    let localAbs = 0;
    for (let j = 0; j < 16; j++) {
      localAbs += Math.abs(Number(instanceArray[matrixOffset + j] ?? 0));
    }
    if (localAbs < 1e-4) {
      continue;
    }
    let data16: Float32Array | null = null;
    if (hasSplitData) {
      const o = index * 4;
      if (
        o + 4 <= aData0Arr!.length && o + 4 <= aData1Arr!.length && o + 4 <= aData2Arr!.length &&
        o + 4 <= aData3Arr!.length
      ) {
        for (let k = 0; k < 4; k++) {
          dataBlock16[k] = Number(aData0Arr![o + k]);
          dataBlock16[4 + k] = Number(aData1Arr![o + k]);
          dataBlock16[8 + k] = Number(aData2Arr![o + k]);
          dataBlock16[12 + k] = Number(aData3Arr![o + k]);
        }
        // Copy: pooled buffer must not appear in postMessage transfer lists (shared by many panels).
        data16 = new Float32Array(dataBlock16);
      }
    } else if (aDataMergedArr != null) {
      const o = index * 16;
      if (o + 16 <= aDataMergedArr.length) {
        for (let k = 0; k < 16; k++) {
          dataBlock16[k] = Number(aDataMergedArr[o + k]);
        }
        data16 = new Float32Array(dataBlock16);
      }
    }
    if (data16 == null) {
      continue;
    }
    matrixHelper.copy(object.matrixWorld);
    instanceMatrixHelper.fromArray(
      instanceMatrix.array as unknown as number[],
      matrixOffset,
    );
    matrixHelper.multiply(instanceMatrixHelper);
    target.push({
      worldMatrix: new Float32Array(matrixHelper.elements),
      // `data16` above is already an owned copy (pooled scratch must not leak out).
      data: data16,
      clipping: instanceClipping == null
        ? new Float32Array(DEFAULT_CLIPPING)
        : new Float32Array(instanceClipping.array.subarray(dataOffset, dataOffset + 16)),
      instanceIndex: index,
      rootIndex,
      renderOrder,
      depthTest,
      depthWrite,
      orderInfo,
    });
  }
}

/**
 * Index of the uikit root owning `object`, or -1 when it belongs to none.
 *
 * A root registered here but not by the panel pass still gets a stable index —
 * a root can legitimately have text and no panels.
 */
function resolveRootIndex(
  object: Object3D,
  rootIndexFor: (rootCtx: unknown) => number,
): number {
  let current: Object3D | null = object;
  while (current != null) {
    if (current instanceof Component) {
      return rootIndexFor((current as unknown as { root: { value: unknown } }).root.value);
    }
    current = current.parent;
  }
  return -1;
}

function maybeCollectImage(
  object: Object3D,
  target: WebXRRaythreeUiImageSnapshot[],
  rootIndex: number,
): void {
  const metadata = (object.userData as {
    raythreeUiImage?: WebXRRaythreeUiImageUserData;
  } | undefined)?.raythreeUiImage;
  if (metadata == null || metadata.width <= 0 || metadata.height <= 0) {
    return;
  }
  target.push({
    ...metadata,
    worldMatrix: new Float32Array(object.matrixWorld.elements),
    orderInfo: readOrderInfo(object),
    renderOrder: Number(
      (object as Object3D & { renderOrder?: number }).renderOrder ?? 0,
    ),
    rootIndex,
  });
}

function maybeCollectText(
  object: Object3D,
  target: WebXRRaythreeUiTextSnapshot[],
  rootIndex: number,
): void {
  const metadata = (object.userData as {
    raythreeUiText?: WebXRRaythreeTextUserData;
  } | undefined)?.raythreeUiText;
  if (metadata == null) {
    return;
  }
  const meshGeometry = (object as Object3D & { geometry?: TextGeometrySource }).geometry;
  let geometry: WebXRRaythreeUiTextSnapshot["geometry"];
  const positionAttr = meshGeometry?.attributes?.position;
  const uvAttr = meshGeometry?.attributes?.uv;
  const indexAttr = meshGeometry?.index;
  if (
    meshGeometry != null && positionAttr != null && uvAttr != null && indexAttr != null
  ) {
    geometry = getTextGeometrySnapshot(meshGeometry, positionAttr, uvAttr, indexAttr);
  }
  target.push({
    worldMatrix: new Float32Array(object.matrixWorld.elements),
    text: metadata.text,
    color: metadata.color,
    fontSize: metadata.fontSize,
    align: metadata.align,
    anchorX: metadata.anchorX,
    font: metadata.font,
    rootIndex,
    bounds: metadata.bounds,
    geometry,
  });
}

function getTextGeometrySnapshot(
  source: TextGeometrySource,
  positionAttr: NonNullable<NonNullable<TextGeometrySource["attributes"]>["position"]>,
  uvAttr: NonNullable<NonNullable<TextGeometrySource["attributes"]>["uv"]>,
  indexAttr: NonNullable<TextGeometrySource["index"]>,
): NonNullable<WebXRRaythreeUiTextSnapshot["geometry"]> {
  const positionVersion = Number(positionAttr.version ?? 0);
  const uvVersion = Number(uvAttr.version ?? 0);
  const indexVersion = Number(indexAttr.version ?? 0);
  const cached = textGeometryCache.get(source);
  if (
    cached != null && cached.positionArray === positionAttr.array &&
    cached.positionVersion === positionVersion && cached.uvArray === uvAttr.array &&
    cached.uvVersion === uvVersion && cached.indexArray === indexAttr.array &&
    cached.indexVersion === indexVersion
  ) {
    return cached.snapshot;
  }

  const rawIndices = indexAttr.array;
  const indices = rawIndices instanceof Uint16Array
    ? rawIndices.slice()
    : rawIndices instanceof Uint32Array
    ? rawIndices.slice()
    : new Uint32Array(Array.from(rawIndices));
  const snapshot = {
    positions: positionAttr.array instanceof Float32Array
      ? positionAttr.array.slice()
      : Float32Array.from(positionAttr.array),
    uvs: uvAttr.array instanceof Float32Array
      ? uvAttr.array.slice()
      : Float32Array.from(uvAttr.array),
    indices,
    version: positionVersion + uvVersion + indexVersion,
  };
  textGeometryCache.set(source, {
    positionArray: positionAttr.array,
    positionVersion,
    uvArray: uvAttr.array,
    uvVersion,
    indexArray: indexAttr.array,
    indexVersion,
    snapshot,
  });
  return snapshot;
}

function readPanelInstanceCount(object: Object3D): number {
  const candidate = object as Object3D & {
    count?: number;
    geometry?: {
      attributes?: Record<string, InstancedBufferAttribute | undefined>;
    };
  };
  if (
    !hasPanelDataAttributes(candidate.geometry) ||
    candidate.geometry?.attributes?.aClipping == null
  ) {
    return 0;
  }
  return Math.max(0, Number(candidate.count ?? 0));
}

function readOrderInfo(object: Object3D): WebXRRaythreeUiOrderInfo | undefined {
  const signal = (object as Object3D & {
    [orderInfoKey]?: { value?: OrderInfo | undefined };
  })[orderInfoKey];
  const value = signal?.value;
  if (value == null) {
    return undefined;
  }
  return {
    majorIndex: value.majorIndex,
    minorIndex: value.minorIndex,
    elementType: value.elementType,
    patchIndex: value.patchIndex,
  };
}
